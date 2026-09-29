/**
 * X402-06 now verifies settlement on-chain, starting from the settlement the
 * paid response reports in its `PAYMENT-RESPONSE` header.
 *
 * Before, a 2xx was enough to pass, so a target that served the resource
 * without settling passed. These cover what is decided before anything is
 * looked up on RPC: no header, a reported failure, and a transaction that is
 * not a Stellar hash all fail; a success with a hash goes on to be verified.
 * The headers are decoded by the same `x402HTTPClient` the check uses.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { x402Client, x402HTTPClient } from "@x402/fetch";

import { readSettlementReference } from "../../src/x402/simulator.js";

const HASH = "02f56c0a9c1c702d504fc168013dbe4d4f1ce3bda52d7c1d432d60a6afcecfe8";
const client = new x402HTTPClient(new x402Client());

function header(settlement: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(settlement)).toString("base64");
}

function read(headers: Record<string, string>) {
  return readSettlementReference(200, () =>
    client.getPaymentSettleResponse((name) => headers[name] ?? null),
  );
}

describe("readSettlementReference", () => {
  it("returns the transaction hash of a reported success", () => {
    const result = read({
      "PAYMENT-RESPONSE": header({ success: true, transaction: HASH, network: "stellar:testnet" }),
    });
    assert.deepEqual(result, { reference: HASH });
  });

  it("also reads the older X-PAYMENT-RESPONSE name", () => {
    const result = read({
      "X-PAYMENT-RESPONSE": header({ success: true, transaction: HASH, network: "stellar:testnet" }),
    });
    assert.deepEqual(result, { reference: HASH });
  });

  it("fails a 2xx that carries no settlement header", () => {
    const result = read({});
    assert.ok("failure" in result);
    assert.match(result.failure, /no PAYMENT-RESPONSE header/);
  });

  it("fails a reported settlement failure", () => {
    const result = read({
      "PAYMENT-RESPONSE": header({ success: false, transaction: "", network: "stellar:testnet" }),
    });
    assert.ok("failure" in result);
    assert.match(result.failure, /reports failure/);
  });

  it("fails a reported failure even when it carries a hash", () => {
    const result = read({
      "PAYMENT-RESPONSE": header({
        success: false,
        errorReason: "insufficient_funds",
        transaction: HASH,
        network: "stellar:testnet",
      }),
    });
    assert.ok("failure" in result);
  });

  it("goes on to verify a settlement_pending hash on chain, as the spec directs", () => {
    const result = read({
      "PAYMENT-RESPONSE": header({
        success: false,
        errorReason: "settlement_pending",
        transaction: HASH,
        network: "stellar:testnet",
      }),
    });
    assert.deepEqual(result, { reference: HASH });
  });

  it("fails a success whose transaction is not a Stellar hash", () => {
    const result = read({
      "PAYMENT-RESPONSE": header({ success: true, transaction: "0xabc", network: "stellar:testnet" }),
    });
    assert.ok("failure" in result);
    assert.match(result.failure, /not a settled Stellar transaction hash/);
  });
});
