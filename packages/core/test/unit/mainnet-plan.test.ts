/**
 * L1's rules for a mainnet run (spec B3, B4, B5, B17.2), written before the
 * code (B11): the mainnet USDC constant, the pin a mainnet environment must
 * have, the option a mainnet endpoint may be paid by, the token's decimals,
 * and the two cross-checks against public Horizon (the anchor ledger and the
 * payer's USDC balance). Pure: nothing here reads a network.
 *
 * This version has no mainnet opt-in (B12): these rules refuse, and nothing
 * calls them yet. The budget still cannot value mainnet USDC, so no charge on
 * stellar:pubnet can pass on this branch.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { Asset, Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { USDC_PUBNET_ADDRESS, USDC_TESTNET_ADDRESS } from "@x402/stellar";

import { ConfigurationError } from "../../src/errors.js";
import { usdAsset } from "../../src/guard/budget.js";
import {
  MAINNET_ANCHOR_MAX_GAP_LEDGERS,
  MAINNET_MAX_TIMEOUT_SECONDS,
  MAINNET_USDC,
  MainnetPlanRefusedError,
  PUBNET_HORIZON_URL,
  assertAnchorNearHorizon,
  assertBalancesAgree,
  assertMainnetDecimals,
  assertMainnetOption,
  assertMainnetPin,
  horizonBalances,
  parseHorizonAmount,
  type MainnetPlanRefusal,
} from "../../src/guard/mainnet-plan.js";

const PUBNET = "stellar:pubnet";
/** Circle's USDC issuer on Stellar mainnet, as its page lists it (read 2026-11-21). */
const CIRCLE_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const PAYER = Keypair.random().publicKey();
const PAY_TO = Keypair.random().publicKey();

function refused(run: () => unknown, reason: MainnetPlanRefusal): MainnetPlanRefusedError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof MainnetPlanRefusedError, `not a MainnetPlanRefusedError: ${String(error)}`);
    assert.ok(error instanceof ConfigurationError, "a plan refusal is a ConfigurationError: it says nothing about the target");
    assert.equal(error.reason, reason, error.message);
    assert.match(error.message, /Nothing was signed\.$/);
    return error;
  }
  assert.fail(`not refused (expected ${reason})`);
}

describe("the mainnet USDC constant (B4), checked three ways", () => {
  it("is the Stellar Asset Contract of Circle's USDC on mainnet, as derived and as the x402 SDK has it", () => {
    assert.equal(MAINNET_USDC.network, PUBNET);
    assert.equal(MAINNET_USDC.code, "USDC");
    assert.equal(MAINNET_USDC.issuer, CIRCLE_ISSUER);
    assert.equal(MAINNET_USDC.decimals, 7);
    assert.equal(MAINNET_USDC.symbol, "USDC");
    assert.equal(MAINNET_USDC.asset, new Asset("USDC", CIRCLE_ISSUER).contractId(Networks.PUBLIC));
    assert.equal(MAINNET_USDC.asset, USDC_PUBNET_ADDRESS);
    assert.ok(StrKey.isValidContract(MAINNET_USDC.asset));
  });

  it("is not the testnet USDC", () => {
    assert.notEqual(MAINNET_USDC.asset, USDC_TESTNET_ADDRESS);
  });

  it("is the one mainnet asset the run budget values, at its decimals (the opt-in, B4); L0 still needs the opt-in", () => {
    assert.deepEqual(usdAsset(PUBNET, MAINNET_USDC.asset), {
      network: PUBNET,
      asset: MAINNET_USDC.asset,
      decimals: MAINNET_USDC.decimals,
      symbol: MAINNET_USDC.symbol,
    });
  });

  it("goes with fixed limits: 300 s of lifetime, 12 ledgers between the RPC and Horizon, Horizon at its public address", () => {
    assert.equal(MAINNET_MAX_TIMEOUT_SECONDS, 300);
    assert.equal(MAINNET_ANCHOR_MAX_GAP_LEDGERS, 12);
    assert.equal(PUBNET_HORIZON_URL, "https://horizon.stellar.org");
  });
});

describe("the pin of a mainnet environment (B5 point 2)", () => {
  it("passes a G or C payee other than the payer, in mainnet USDC", () => {
    assertMainnetPin({ payTo: PAY_TO, asset: MAINNET_USDC.asset }, PAYER);
    assertMainnetPin({ payTo: StrKey.encodeContract(randomBytes(32)), asset: MAINNET_USDC.asset }, PAYER);
  });

  it("is required", () => {
    refused(() => assertMainnetPin(undefined, PAYER), "pin");
  });

  it("must name mainnet USDC as the asset", () => {
    refused(() => assertMainnetPin({ payTo: PAY_TO, asset: USDC_TESTNET_ADDRESS }, PAYER), "asset");
    refused(() => assertMainnetPin({ payTo: PAY_TO, asset: MAINNET_USDC.asset.toLowerCase() }, PAYER), "asset");
    refused(() => assertMainnetPin({ payTo: PAY_TO, asset: ` ${MAINNET_USDC.asset}` }, PAYER), "asset");
  });

  it("must name a valid Stellar address as the payee", () => {
    for (const payTo of ["", "not an address", PAY_TO.toLowerCase(), `${PAY_TO} `, PAY_TO.slice(0, -1), Keypair.random().secret()]) {
      const error = refused(() => assertMainnetPin({ payTo, asset: MAINNET_USDC.asset }, PAYER), "pin");
      assert.doesNotMatch(error.message, /S[A-Z2-7]{55}/, "never echoes a key");
    }
  });

  it("must not pay the payer itself: a transfer to oneself would hide what left the account", () => {
    refused(() => assertMainnetPin({ payTo: PAYER, asset: MAINNET_USDC.asset }, PAYER), "pin");
  });
});

describe("the option a mainnet endpoint may be paid by (L1, B3)", () => {
  const option = { scheme: "exact", network: PUBNET, payTo: PAY_TO, asset: MAINNET_USDC.asset, maxTimeoutSeconds: 60 };

  it("passes exact, stellar:pubnet, mainnet USDC, a lifetime from 1 to 300 s", () => {
    assertMainnetOption(option);
    assertMainnetOption({ ...option, maxTimeoutSeconds: 1 });
    assertMainnetOption({ ...option, maxTimeoutSeconds: 300 });
  });

  it("refuses another scheme or network", () => {
    refused(() => assertMainnetOption({ ...option, scheme: "upto" }), "network");
    refused(() => assertMainnetOption({ ...option, network: "stellar:testnet" }), "network");
  });

  it("refuses another asset", () => {
    refused(() => assertMainnetOption({ ...option, asset: USDC_TESTNET_ADDRESS }), "asset");
  });

  it("refuses a lifetime above 300 s, or one that is not a positive whole number of seconds", () => {
    for (const maxTimeoutSeconds of [301, 3600, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "300", undefined, null]) {
      refused(() => assertMainnetOption({ ...option, maxTimeoutSeconds: maxTimeoutSeconds as number }), "lifetime");
    }
  });
});

describe("the token's decimals, read on chain (B4)", () => {
  it("must be 7", () => {
    assertMainnetDecimals(7);
    for (const decimals of [6, 8, 0, "7", 7.5, undefined, null, Number.NaN, 7n]) {
      refused(() => assertMainnetDecimals(decimals), "decimals");
    }
  });
});

describe("the anchor ledger against Horizon (B17.2)", () => {
  it("passes when the RPC's latest ledger is within 12 of Horizon's, either way", () => {
    for (const gap of [0, 1, 12, -1, -12]) assertAnchorNearHorizon(65_594_567 + gap, 65_594_567);
  });

  it("refuses a gap of 13 or more", () => {
    refused(() => assertAnchorNearHorizon(65_594_567 + 13, 65_594_567), "anchor");
    refused(() => assertAnchorNearHorizon(65_594_567 - 13, 65_594_567), "anchor");
    refused(() => assertAnchorNearHorizon(65_594_567 + 10_000_000, 65_594_567), "anchor");
  });

  it("refuses a reading that is not a positive whole ledger number", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, undefined, "65594567"]) {
      refused(() => assertAnchorNearHorizon(bad as number, 65_594_567), "anchor");
      refused(() => assertAnchorNearHorizon(65_594_567, bad as number), "anchor");
    }
  });
});

describe("Horizon's amounts and balances", () => {
  it("reads an amount with exactly 7 decimals into base units", () => {
    assert.equal(parseHorizonAmount("10.0000000"), 100_000_000n);
    assert.equal(parseHorizonAmount("0.0000001"), 1n);
    assert.equal(parseHorizonAmount("0.0000000"), 0n);
    assert.equal(parseHorizonAmount("21871636256.6342925"), 218_716_362_566_342_925n);
  });

  it("reads nothing else", () => {
    for (const bad of ["10", "10.000000", "10.00000000", "-1.0000000", "+1.0000000", "1e3", " 1.0000000", "1.0000000 ", "", "0x1.0000000", 10, null, undefined]) {
      assert.equal(parseHorizonAmount(bad), undefined, String(bad));
    }
  });

  const usdc = (balance: string, issuer = CIRCLE_ISSUER, code = "USDC", type = "credit_alphanum4") => ({
    balance,
    asset_type: type,
    asset_code: code,
    asset_issuer: issuer,
  });
  const native = (balance: string) => ({ balance, asset_type: "native" });

  it("finds the USDC trustline by code, issuer and type, and the native balance", () => {
    const account = { balances: [usdc("9.5000000"), native("3.0000000")] };
    assert.deepEqual(horizonBalances(account, MAINNET_USDC), { usdc: 95_000_000n, native: 30_000_000n });
  });

  it("ignores a token with the same code from another issuer, or a longer code", () => {
    const other = Keypair.random().publicKey();
    const account = { balances: [usdc("1000.0000000", other), usdc("1000.0000000", CIRCLE_ISSUER, "USDCAllow", "credit_alphanum12"), native("3.0000000")] };
    assert.deepEqual(horizonBalances(account, MAINNET_USDC), { usdc: 0n, native: 30_000_000n });
  });

  it("reads no USDC trustline as zero", () => {
    assert.deepEqual(horizonBalances({ balances: [native("1.0000000")] }, MAINNET_USDC), { usdc: 0n, native: 10_000_000n });
  });

  it("gives no reading for an answer it cannot trust", () => {
    const cases: unknown[] = [
      undefined,
      null,
      {},
      { balances: "x" },
      { balances: [] },
      { balances: [usdc("1.0000000")] },
      { balances: [usdc("1.0"), native("1.0000000")] },
      { balances: [usdc("1.0000000"), native("x")] },
      { balances: [usdc("1.0000000"), usdc("2.0000000"), native("1.0000000")] },
      { balances: [native("1.0000000"), native("2.0000000")] },
    ];
    for (const account of cases) assert.equal(horizonBalances(account, MAINNET_USDC), undefined, JSON.stringify(account));
  });
});

describe("the payer's USDC balance, RPC against Horizon (B17.12)", () => {
  it("passes when both say the same", () => {
    assertBalancesAgree(95_000_000n, 95_000_000n);
    assertBalancesAgree(0n, 0n);
  });

  it("refuses when they differ, by one base unit too", () => {
    refused(() => assertBalancesAgree(95_000_000n, 95_000_001n), "balance");
    refused(() => assertBalancesAgree(1n, 0n), "balance");
  });

  it("refuses when either has no reading", () => {
    refused(() => assertBalancesAgree(undefined, 1n), "balance");
    refused(() => assertBalancesAgree(1n, undefined), "horizon");
  });
});
