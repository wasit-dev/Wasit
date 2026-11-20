/**
 * The payment tier on a network Wasit cannot pay on (spec A3): the payment group
 * is a SKIP of kind `unsupported`, not a PREFLIGHT error.
 *
 * Only a network with no payment adapter is unsupported. The guard's refusals are
 * a different thing and must stay refusals: `stellar:pubnet` has an adapter and
 * is refused by the L0 guard as a configuration error, before anything is
 * signed. The tests here hold both lines.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import { checkStatus } from "../../src/check.js";
import { ConfigurationError, classifyCheckError } from "../../src/errors.js";
import { runX402PaymentChecks } from "../../src/x402/simulator.js";

const PAYMENT_IDS = ["X402-06", "X402-07", "X402-08", "X402-09", "X402-10", "X402-11"];

/** A target that counts every request it gets, and answers 402 with an empty challenge. */
async function countingTarget(): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(402);
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/paid`,
    requests: () => requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("a network no payment adapter pays on", () => {
  for (const network of [
    "eip155:97", // BNB Smart Chain testnet
    "eip155:8453", // Base mainnet
    "eip155:1", // Ethereum mainnet
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", // Solana mainnet
    "stellar:futurenet",
    "ach:us",
    "stellar-testnet",
    "",
    "constructor",
  ]) {
    it(`skips ${JSON.stringify(network)} as unsupported and sends nothing`, async () => {
      const target = await countingTarget();
      try {
        const results = await runX402PaymentChecks({
          target: target.url,
          network,
          payerSecretKey: Keypair.random().secret(),
        });
        assert.deepEqual(results.map((result) => result.id), PAYMENT_IDS);
        for (const result of results) {
          assert.equal(checkStatus(result), "SKIP", result.id);
          assert.equal(result.skipKind, "unsupported", result.id);
          assert.equal(result.error, undefined, result.id);
        }
        assert.match(results[0]?.skipReason ?? "", /is not one of them/);
        assert.equal(target.requests(), 0, "the target was asked for something");
      } finally {
        await target.close();
      }
    });
  }

  it("reports each skip to the live-progress hook, in order", async () => {
    const target = await countingTarget();
    try {
      const seen: string[] = [];
      await runX402PaymentChecks({
        target: target.url,
        network: "eip155:97",
        payerSecretKey: Keypair.random().secret(),
        onResult: (result) => seen.push(result.id),
      });
      assert.deepEqual(seen, PAYMENT_IDS);
    } finally {
      await target.close();
    }
  });

  it("quotes the network so a control character cannot reach the reason as a raw one", async () => {
    const target = await countingTarget();
    try {
      const results = await runX402PaymentChecks({
        target: target.url,
        network: "eip155:1\u001b[31m",
        payerSecretKey: Keypair.random().secret(),
      });
      assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(results[0]?.skipReason ?? ""), false);
    } finally {
      await target.close();
    }
  });

  it("does not use the network the key was given for as a way around the line: a bad URL is still a PREFLIGHT error", async () => {
    const results = await runX402PaymentChecks({
      target: "not a url",
      network: "eip155:97",
      payerSecretKey: Keypair.random().secret(),
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, "PREFLIGHT");
    assert.equal(results[0]?.error?.kind, "configuration");
  });
});

describe("the guard's refusals are not unsupported", () => {
  it("still refuses stellar:pubnet as a PREFLIGHT configuration error, not a skip", async () => {
    const target = await countingTarget();
    try {
      const results = await runX402PaymentChecks({
        target: target.url,
        network: "stellar:pubnet",
        payerSecretKey: Keypair.random().secret(),
        rpcUrl: "http://127.0.0.1:1",
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.id, "PREFLIGHT");
      assert.equal(checkStatus(results[0]!), "ERROR");
      assert.equal(results[0]?.error?.kind, "configuration");
      assert.equal(results[0]?.skipKind, undefined);
      assert.equal(target.requests(), 0);
    } finally {
      await target.close();
    }
  });

  it("still stops a malformed payer key on a supported network as a PREFLIGHT error", async () => {
    const target = await countingTarget();
    try {
      const results = await runX402PaymentChecks({ target: target.url, network: "stellar:testnet", payerSecretKey: "SNOTAREALKEY" });
      assert.equal(results[0]?.id, "PREFLIGHT");
      assert.equal(results[0]?.error?.kind, "configuration");
      assert.equal(target.requests(), 0);
    } finally {
      await target.close();
    }
  });
});

describe("an unsupported network, if it were thrown from anywhere else", () => {
  it("is still a configuration error", async () => {
    // The adapter lookup throws a ConfigurationError subclass; a caller that does not know the
    // subclass (an older front end) still classifies it as no verdict, never as a defect.
    const { UnsupportedPaymentNetworkError } = await import("../../src/x402/simulator.js");
    const error = new UnsupportedPaymentNetworkError("eip155:97");
    assert.ok(error instanceof ConfigurationError);
    assert.equal(classifyCheckError(error).kind, "configuration");
    assert.equal(error.network, "eip155:97");
  });
});
