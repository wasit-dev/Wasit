/**
 * X402-04 and X402-05 on challenges from any chain, and the payment checks on
 * a challenge that offers nothing Wasit can pay.
 *
 * Before 0.7.0, X402-05 accepted only stellar:testnet and stellar:pubnet, so a
 * conformant x402 service on any other chain failed it, and both checks read
 * only `accepts[0]`, so a challenge offering several networks was judged on
 * whichever came first. Network rules come from CAIP-2 and the namespace
 * definitions (DECISIONS.md, Verified facts, 2026-10-04).
 */

import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import type { CheckResult } from "../../src/check.js";
import {
  checkNetworkIdentifier,
  checkRequiredFields,
  validateNetwork,
} from "../../src/x402/requirements.js";
import { runX402PaymentChecks } from "../../src/x402/simulator.js";

const STELLAR_ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const STELLAR_PAY_TO = "GBNCC3VFT7PGUMGDQU5O35SXVWWTAHCO4LFFWLYFBLQCD56DNWYWM6ZS";
const BASE_SEPOLIA = "eip155:84532";
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

function option(network: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network,
    amount: "10000",
    asset: network.startsWith("stellar:") ? STELLAR_ASSET : "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: network.startsWith("stellar:") ? STELLAR_PAY_TO : "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    maxTimeoutSeconds: 60,
    ...overrides,
  };
}

function v2(...accepts: unknown[]): Record<string, unknown> {
  return { x402Version: 2, resource: { url: "http://127.0.0.1/paid" }, accepts };
}

describe("validateNetwork", () => {
  it("accepts the identifiers the namespaces define", () => {
    for (const network of [
      "stellar:testnet",
      "stellar:pubnet",
      BASE_SEPOLIA,
      "eip155:8453",
      "eip155:56",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      SOLANA_DEVNET,
    ]) {
      const verdict = validateNetwork(network);
      assert.equal(verdict.valid, true, network);
      assert.equal(verdict.valid && verdict.known, true, network);
    }
  });

  it("rejects what is not CAIP-2 at all, naming the format", () => {
    for (const network of [
      "base-sepolia", // x402 v1 style
      "stellar-testnet",
      "Stellar:testnet", // namespace is lowercase only
      "ab:x", // namespace is 3 to 8 characters
      "eip155:", // empty reference
      `eip155:${"1".repeat(33)}`, // reference is at most 32 characters
      "eip155:84532:extra",
    ]) {
      const verdict = validateNetwork(network);
      assert.equal(verdict.valid, false, network);
      assert.match(!verdict.valid ? verdict.reason : "", /not a CAIP-2 identifier/, network);
    }
  });

  it("holds stellar to its two networks", () => {
    for (const network of ["stellar:mainnet", "stellar:futurenet", "stellar:Testnet"]) {
      const verdict = validateNetwork(network);
      assert.equal(verdict.valid, false, network);
      assert.match(!verdict.valid ? verdict.reason : "", /stellar:testnet or stellar:pubnet/);
    }
  });

  it("holds eip155 to a base-10 chain id", () => {
    for (const network of ["eip155:0x14a34", "eip155:0", "eip155:01", "eip155:base"]) {
      const verdict = validateNetwork(network);
      assert.equal(verdict.valid, false, network);
      assert.match(!verdict.valid ? verdict.reason : "", /EIP-155 chain id in base 10/);
    }
  });

  it("holds solana to 32 base58 characters of the genesis hash", () => {
    for (const network of [
      "solana:devnet",
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa", // 31 characters
      "solana:0tWTRABZaYq6iMfeYKouRu166VU2xqa1", // 0 is not base58
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqI1", // I is not base58
    ]) {
      const verdict = validateNetwork(network);
      assert.equal(verdict.valid, false, network);
      assert.match(!verdict.valid ? verdict.reason : "", /genesis hash/);
    }
  });

  // x402 v2 asks only for CAIP-2; failing a namespace Wasit has no rules for
  // would report Wasit's ignorance as the target's defect.
  it("accepts a well-formed identifier in a namespace it has no rules for", () => {
    for (const network of ["ach:us", "hedera:testnet", "aptos:2"]) {
      const verdict = validateNetwork(network);
      assert.equal(verdict.valid, true, network);
      assert.equal(verdict.valid && verdict.known, false, network);
    }
  });
});

describe("checkRequiredFields across payment options", () => {
  it("passes when every option carries its fields, and says how many", () => {
    const result = checkRequiredFields(v2(option("stellar:testnet"), option(BASE_SEPOLIA)));
    assert.equal(result.pass, true);
    assert.match(result.detail, /each of the 2 payment options/);
  });

  it("keeps the single-option wording", () => {
    const result = checkRequiredFields(v2(option("stellar:testnet")));
    assert.equal(result.detail, "All required v2 fields present.");
  });

  it("fails on a broken option even when the first one is fine", () => {
    const result = checkRequiredFields(
      v2(option("stellar:testnet"), option(BASE_SEPOLIA, { payTo: undefined })),
    );
    assert.equal(result.pass, false);
    assert.equal(result.detail, "accepts[1]: Missing: payTo.");
  });

  it("names the v1 field in a v2 option, per option", () => {
    const result = checkRequiredFields(
      v2(option(SOLANA_DEVNET), option("stellar:testnet", { amount: undefined, maxAmountRequired: "1" })),
    );
    assert.equal(result.pass, false);
    assert.match(result.detail, /^accepts\[1\]: .*`maxAmountRequired`.*requires `amount`/);
  });

  it("fails a challenge that offers no options at all", () => {
    for (const payload of [v2(), { x402Version: 2 }]) {
      const result = checkRequiredFields(payload);
      assert.equal(result.pass, false);
      assert.match(result.detail, /no payment options/);
    }
  });

  it("reads an option that is not an object as one with every field missing", () => {
    const result = checkRequiredFields(v2(option("stellar:testnet"), "oops"));
    assert.equal(
      result.detail,
      "accepts[1]: Missing: scheme, network, amount, asset, payTo, maxTimeoutSeconds.",
    );
  });
});

function byId(results: CheckResult[]): Record<string, CheckResult> {
  return Object.fromEntries(results.map((result) => [result.id, result]));
}

describe("checkNetworkIdentifier across payment options", () => {
  it("passes a challenge offering several valid networks, listing them", () => {
    const result = checkNetworkIdentifier(v2(option(BASE_SEPOLIA), option("stellar:testnet")));
    assert.equal(result.pass, true);
    assert.equal(result.detail, `Network identifiers are valid: ${BASE_SEPOLIA}, stellar:testnet.`);
  });

  it("passes a non-Stellar network on its own", () => {
    const result = checkNetworkIdentifier(v2(option(SOLANA_DEVNET)));
    assert.equal(result.pass, true);
    assert.equal(result.detail, `Network identifier "${SOLANA_DEVNET}" is valid.`);
  });

  it("fails on any invalid network and names the option", () => {
    const result = checkNetworkIdentifier(v2(option("stellar:testnet"), option("base-sepolia")));
    assert.equal(result.pass, false);
    assert.match(result.detail, /^accepts\[1\]: "base-sepolia" is not a CAIP-2 identifier/);
  });

  it("tells a v1 challenge that v2 renamed its networks", () => {
    const result = checkNetworkIdentifier({
      x402Version: 1,
      accepts: [{ network: "base-sepolia" }],
    });
    assert.equal(result.pass, false);
    assert.match(result.detail, /x402 v1 used plain names; v2 requires CAIP-2\.$/);
  });

  it("says when only the CAIP-2 format could be checked", () => {
    const result = checkNetworkIdentifier(v2(option("ach:us")));
    assert.equal(result.pass, true);
    assert.match(result.detail, /no further rules for the "ach" namespace/);
  });

  it("leaves a missing network to X402-04", () => {
    const result = checkNetworkIdentifier(v2(option("stellar:testnet", { network: undefined })));
    assert.equal(result.skipped, true);
    assert.match(result.skipReason ?? "", /X402-04/);
  });

  // A missing network in one option is X402-04's finding; the others are
  // still checked rather than the whole check being skipped.
  it("checks the options that do name a network", () => {
    const result = checkNetworkIdentifier(
      v2(option("stellar:testnet", { network: undefined }), option("stellar:mainnet")),
    );
    assert.equal(result.pass, false);
    assert.match(result.detail, /^accepts\[1\]: "stellar:mainnet"/);
  });
});

/** Answers every request with 402 and a v2 `PAYMENT-REQUIRED` header. */
async function serveV2(payload: unknown): Promise<{
  url: string;
  paymentHeadersSeen: () => number;
  close: () => Promise<void>;
}> {
  let paymentHeaders = 0;
  const header = Buffer.from(JSON.stringify(payload)).toString("base64");
  const server = http.createServer((request, response) => {
    if (request.headers["x-payment"] || request.headers["payment-signature"]) paymentHeaders++;
    response.writeHead(402, { "payment-required": header, "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/paid`,
    paymentHeadersSeen: () => paymentHeaders,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("payment checks on a challenge Wasit cannot pay", () => {
  const payerSecretKey = Keypair.random().secret();

  for (const [label, payload, reason] of [
    [
      "a challenge on other chains only",
      v2(option(BASE_SEPOLIA), option(SOLANA_DEVNET)),
      new RegExp(`offers no payment option on stellar:testnet \\(it offers ${BASE_SEPOLIA}, ${SOLANA_DEVNET}\\)`),
    ],
    [
      "a challenge on the other Stellar network only",
      v2(option("stellar:pubnet")),
      /offers no payment option on stellar:testnet \(it offers stellar:pubnet\)/,
    ],
    [
      "a Stellar option in a scheme other than exact",
      v2(option("stellar:testnet", { scheme: "upto" })),
      /uses the "upto" scheme, and Wasit pays through the `exact` scheme only/,
    ],
  ] as const) {
    it(`skips X402-06 and X402-07 for ${label}, and sends nothing`, async () => {
      const target = await serveV2(payload);
      try {
        const results = byId(
          await runX402PaymentChecks({ target: target.url, network: "stellar:testnet", payerSecretKey }),
        );
        for (const id of ["X402-06", "X402-07", "X402-08", "X402-09", "X402-10"]) {
          assert.equal(results[id]?.skipped, true, id);
          assert.match(results[id]?.skipReason ?? "", reason, id);
        }
        assert.equal(target.paymentHeadersSeen(), 0);
      } finally {
        await target.close();
      }
    });
  }

  it("stops before paying when asked to pay on a network it cannot pay on", async () => {
    // Ethereum Sepolia: read-only only.
    const target = await serveV2(v2(option("eip155:11155111")));
    try {
      const results = await runX402PaymentChecks({
        target: target.url,
        network: "eip155:11155111",
        payerSecretKey,
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.id, "PREFLIGHT");
      assert.equal(results[0]?.error?.kind, "configuration");
      assert.equal(target.paymentHeadersSeen(), 0);
    } finally {
      await target.close();
    }
  });

  // A Stellar secret on an EVM network, or any malformed key, is the run's
  // configuration, caught before anything is sent.
  for (const [label, network, key] of [
    ["a Stellar secret on Base Sepolia", BASE_SEPOLIA, Keypair.random().secret()],
    ["a malformed Stellar secret", "stellar:testnet", "SNOTAREALKEY"],
  ] as const) {
    it(`stops before paying with ${label}`, async () => {
      const target = await serveV2(v2(option(network)));
      try {
        const results = await runX402PaymentChecks({ target: target.url, network, payerSecretKey: key });
        assert.equal(results.length, 1);
        assert.equal(results[0]?.id, "PREFLIGHT");
        assert.equal(results[0]?.error?.kind, "configuration");
        assert.equal(results[0]?.detail.includes(key), false);
        assert.equal(target.paymentHeadersSeen(), 0);
      } finally {
        await target.close();
      }
    });
  }

  // pubnet has no default RPC endpoint. Without one X402-06 could
  // not verify the settlement, so the payment must not be made at all.
  it("stops before paying on pubnet without an RPC endpoint", async () => {
    const target = await serveV2(v2(option("stellar:pubnet")));
    try {
      const results = await runX402PaymentChecks({
        target: target.url,
        network: "stellar:pubnet",
        payerSecretKey,
      });
      assert.equal(results[0]?.id, "PREFLIGHT");
      assert.equal(results[0]?.error?.kind, "configuration");
      assert.equal(target.paymentHeadersSeen(), 0);
    } finally {
      await target.close();
    }
  });
});
