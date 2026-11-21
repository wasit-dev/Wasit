/**
 * The caps of spec B4, as code: $1 a payment, $5 a run (a config may only
 * lower it), charged before the signature and never credited back; the US
 * dollar assets Wasit can hold to those caps; the pin over every `exact`
 * option; the signatures a run makes per endpoint (B0 fact 8).
 *
 * Pure: no network, no key.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PER_PAYMENT_CAP_USD,
  PER_RUN_CAP_USD,
  PaymentGuardRefusedError,
  RunBudget,
  USD_ASSETS,
  assertPinned,
  formatUsd,
  plannedSignatures,
  sameAddress,
  usdAsset,
  usdFromDollars,
} from "../../src/guard/budget.js";
import { CheckSetupError } from "../../src/errors.js";
import { NETWORK_CLASSES } from "../../src/guard/networks.js";

const STELLAR = "stellar:testnet";
const STELLAR_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const BASE = "eip155:84532";
const BASE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "GDPAPDZWAKBXUPCNMI4YHAZ7DS7UOUTPGXAFDSWZG4URRMWHFSQTDQBM";

function refusedWith(reason: PaymentGuardRefusedError["reason"], run: () => void): PaymentGuardRefusedError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof PaymentGuardRefusedError, `expected a refusal, got ${String(error)}`);
    assert.equal(error.reason, reason);
    assert.match(error.message, /Nothing was signed\.$/);
    return error;
  }
  return assert.fail(`expected a "${reason}" refusal`);
}

describe("the caps", () => {
  it("are $1 a payment and $5 a run, fixed in code", () => {
    assert.equal(PER_PAYMENT_CAP_USD, 1);
    assert.equal(PER_RUN_CAP_USD, 5);
  });

  it("a refusal is a setup error: no verdict about the target", () => {
    const error = refusedWith("price", () =>
      new RunBudget().charge({ check: "X402-06", network: STELLAR, asset: STELLAR_USDC, amount: "10000001" }),
    );
    assert.ok(error instanceof CheckSetupError);
  });
});

describe("the US dollar assets", () => {
  it("lists test networks, each in the guard's table, and on mainnet only stellar:pubnet's USDC (the opt-in)", () => {
    const mainnet = USD_ASSETS.filter((entry) => NETWORK_CLASSES.get(entry.network) !== "test");
    assert.deepEqual(mainnet, [
      { network: "stellar:pubnet", asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", decimals: 7, symbol: "USDC" },
    ]);
    assert.equal(NETWORK_CLASSES.get("stellar:pubnet"), "mainnet-optin");
    for (const entry of USD_ASSETS.filter((item) => item.network !== "stellar:pubnet")) {
      assert.equal(NETWORK_CLASSES.get(entry.network), "test", entry.network);
    }
  });

  it("knows USDC on every test network, with the decimals the SDK uses", () => {
    assert.equal(usdAsset(STELLAR, STELLAR_USDC)?.decimals, 7);
    assert.equal(usdAsset(BASE, BASE_USDC)?.decimals, 6);
    assert.equal(usdAsset("eip155:11155111", "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238")?.decimals, 6);
    assert.equal(
      usdAsset("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")?.decimals,
      6,
    );
  });

  it("reads an EVM address in any case, and a Stellar or Solana one exactly", () => {
    assert.ok(usdAsset(BASE, BASE_USDC.toLowerCase()));
    assert.ok(sameAddress(BASE, BASE_USDC, BASE_USDC.toUpperCase().replace("0X", "0x")));
    assert.equal(usdAsset(STELLAR, STELLAR_USDC.toLowerCase()), undefined);
    assert.equal(sameAddress(STELLAR, PAY_TO, PAY_TO.toLowerCase()), false);
  });

  it("does not value an asset on another network, or one it does not list", () => {
    assert.equal(usdAsset(BASE, STELLAR_USDC), undefined);
    assert.equal(usdAsset(STELLAR, BASE_USDC), undefined);
    // Mainnet USDC is valued on stellar:pubnet only (the opt-in), never on testnet.
    assert.equal(usdAsset(STELLAR, "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"), undefined);
    assert.equal(usdAsset("stellar:pubnet", STELLAR_USDC), undefined);
  });

  it("formats a dollar amount exactly, with at least two decimals", () => {
    assert.equal(formatUsd(usdFromDollars(4.5)), "$4.50");
    assert.equal(formatUsd(usdFromDollars(5)), "$5.00");
    assert.equal(formatUsd(0n), "$0.00");
    const budget = new RunBudget();
    budget.charge({ check: "X402-06", network: STELLAR, asset: STELLAR_USDC, amount: "1" });
    assert.equal(formatUsd(budget.spentUsd), "$0.0000001");
  });
});

describe("a run's budget", () => {
  const pay = (budget: RunBudget, amount: string, check = "X402-06"): void =>
    budget.charge({ check, network: STELLAR, asset: STELLAR_USDC, amount });

  it("takes a payment of exactly $1, and refuses one base unit more", () => {
    const budget = new RunBudget();
    pay(budget, "10000000");
    refusedWith("price", () => pay(new RunBudget(), "10000001"));
    assert.equal(formatUsd(budget.spentUsd), "$1.00");
  });

  it("refuses the payment that would take the run above $5, and keeps what was charged", () => {
    const budget = new RunBudget();
    for (let index = 0; index < 5; index += 1) pay(budget, "10000000");
    const error = refusedWith("run-cap", () => pay(budget, "1"));
    assert.match(error.message, /\$5\.00/);
    assert.equal(formatUsd(budget.spentUsd), "$5.00");
  });

  it("is lowered by maxRunUsd and never raised by it", () => {
    const lowered = new RunBudget({ maxRunUsd: 1.5 });
    assert.equal(formatUsd(lowered.capUsd), "$1.50");
    pay(lowered, "10000000");
    refusedWith("run-cap", () => pay(lowered, "5000001"));
    assert.equal(formatUsd(new RunBudget({ maxRunUsd: 50 }).capUsd), "$5.00");
  });

  it("refuses a maxRunUsd that is not a positive number, rather than reading it as no cap", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => new RunBudget({ maxRunUsd: bad }), /maxRunUsd/);
    }
  });

  it("charges before anything is signed: a failed signature is never credited back", () => {
    const budget = new RunBudget({ maxRunUsd: 1 });
    pay(budget, "10000000");
    // Whatever happens to that payment afterwards, the run has spent its dollar.
    refusedWith("run-cap", () => pay(budget, "1", "X402-07"));
    assert.equal(budget.entries.length, 1);
    assert.deepEqual(budget.entries[0], { check: "X402-06", network: STELLAR, asset: STELLAR_USDC, amount: 10000000n });
  });

  it("refuses an asset it cannot value, a negative amount and one that is not a whole number", () => {
    refusedWith("asset", () => new RunBudget().charge({ check: "X402-06", network: STELLAR, asset: "CAAAA", amount: "1" }));
    for (const amount of ["-1", "1.5", "1e3", "", " 1", "0x10", "9".repeat(79)]) {
      refusedWith("amount", () => pay(new RunBudget(), amount));
    }
  });

  it("refuses a payment above what the plan allowed for that check", () => {
    const budget = new RunBudget();
    const error = refusedWith("plan", () =>
      budget.charge({ check: "X402-06", network: STELLAR, asset: STELLAR_USDC, amount: "100001", planned: 100000n }),
    );
    assert.match(error.message, /X402-06/);
    assert.equal(budget.spentUsd, 0n);
  });

  it("charges USDC with 6 decimals at the same dollar value", () => {
    const budget = new RunBudget();
    budget.charge({ check: "X402-06", network: BASE, asset: BASE_USDC, amount: "1000000" });
    assert.equal(formatUsd(budget.spentUsd), "$1.00");
    refusedWith("price", () =>
      budget.charge({ check: "X402-07", network: BASE, asset: BASE_USDC, amount: "1000001" }),
    );
  });
});

describe("the pin", () => {
  const option = (payTo: string, asset = STELLAR_USDC, network = STELLAR, scheme = "exact") => ({
    scheme,
    network,
    payTo,
    asset,
    amount: "100000",
    maxTimeoutSeconds: 60,
    extra: {},
  });
  const pin = { payTo: PAY_TO, asset: STELLAR_USDC };
  const OTHER = "GALVZ57VAY6BE33WYPJMUJ27PFAUDRQ6ATTVMIIF4STTGQTXDBEIBXUI";

  it("passes a challenge whose every exact option on the network is the pinned one", () => {
    assertPinned(STELLAR, [option(PAY_TO), option(PAY_TO)], pin);
  });

  it("refuses ANY exact option on the network that pays someone else, not only the first", () => {
    const error = refusedWith("pin", () => assertPinned(STELLAR, [option(PAY_TO), option(OTHER)], pin));
    assert.match(error.message, /payTo/);
  });

  it("refuses an exact option in another asset", () => {
    refusedWith("pin", () => assertPinned(STELLAR, [option(PAY_TO, "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA")], pin));
  });

  it("ignores options on other networks and other schemes, which are never signed", () => {
    assertPinned(STELLAR, [option(PAY_TO), option(OTHER, BASE_USDC, BASE), option(OTHER, STELLAR_USDC, STELLAR, "upto")], pin);
  });

  it("does nothing without a pin", () => {
    assertPinned(STELLAR, [option(OTHER)], undefined);
  });

  it("never echoes a long or hostile value from the challenge", () => {
    const error = refusedWith("pin", () => assertPinned(STELLAR, [option(`G${"A".repeat(500)}\u001b[31m`)], pin));
    assert.ok(error.message.length < 400, error.message);
    assert.doesNotMatch(error.message, /\u001b/);
  });
});

describe("what a run signs per endpoint (B0 fact 8)", () => {
  it("is 3.5 times the price: X402-06, 07 and 10 at the price, 09 at half", () => {
    assert.deepEqual(plannedSignatures(100000n), [
      { check: "X402-06", amount: 100000n },
      { check: "X402-07", amount: 100000n },
      { check: "X402-09", amount: 50000n },
      { check: "X402-10", amount: 100000n },
    ]);
  });

  it("has no X402-09 when there is no smaller payment to offer", () => {
    assert.deepEqual(
      plannedSignatures(1n).map((entry) => entry.check),
      ["X402-06", "X402-07", "X402-10"],
    );
  });
});
