/**
 * x402 v1 challenges, and challenges the payment client cannot read.
 *
 * x402 v1 signals payment in the 402 response body; v2 uses the
 * PAYMENT-REQUIRED header, and the `exact` scheme on Stellar is defined for v2
 * only. A v1 service therefore fails X402-02, but its terms are still worth
 * checking, and neither payment check has a verdict when no payment could be
 * built. Before this, a v1 target got X402-03..05 skipped and X402-06/07
 * reported as FAIL, so X402-07 read as a corrupted signature that was not
 * rejected although nothing was ever sent.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import type { CheckResult } from "../../src/check.js";
import {
  readV1BodyChallenge,
  runX402PaymentChecks,
  runX402ReadChecks,
} from "../../src/x402/simulator.js";

function v1Body(network: string): string {
  return JSON.stringify({
    x402Version: 1,
    error: "Payment required",
    accepts: [
      {
        scheme: "exact",
        network,
        maxAmountRequired: "10000",
        resource: "http://127.0.0.1/paid",
        description: "test",
        mimeType: "application/json",
        payTo: "GBNCC3VFT7PGUMGDQU5O35SXVWWTAHCO4LFFWLYFBLQCD56DNWYWM6ZS",
        maxTimeoutSeconds: 60,
        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      },
    ],
  });
}

function byId(results: CheckResult[]): Record<string, CheckResult> {
  return Object.fromEntries(results.map((result) => [result.id, result]));
}

/** Starts a server answering every request with 402 and `body`. */
async function serve(body: string): Promise<{
  url: string;
  paymentHeadersSeen: () => number;
  close: () => Promise<void>;
}> {
  let paymentHeaders = 0;
  const server = http.createServer((request, response) => {
    if (request.headers["x-payment"] || request.headers["payment-signature"]) paymentHeaders++;
    response.writeHead(402, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/paid`,
    paymentHeadersSeen: () => paymentHeaders,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("readV1BodyChallenge", () => {
  it("reads a v1 PaymentRequirementsResponse", () => {
    assert.equal(readV1BodyChallenge(v1Body("stellar-testnet"))?.["x402Version"], 1);
  });

  it("does not treat anything else as a v1 challenge", () => {
    assert.equal(readV1BodyChallenge("not json"), undefined);
    assert.equal(readV1BodyChallenge(JSON.stringify({ x402Version: 2, accepts: [] })), undefined);
    assert.equal(readV1BodyChallenge(JSON.stringify({ x402Version: 1 })), undefined);
    assert.equal(readV1BodyChallenge("null"), undefined);
  });
});

describe("read checks against a v1 body challenge", () => {
  it("fails X402-02, checks the v1 terms, and flags a non-CAIP-2 network", async () => {
    const target = await serve(v1Body("stellar-testnet"));
    try {
      const results = byId(await runX402ReadChecks({ target: target.url }));
      assert.equal(results["X402-01"]?.pass, true);
      assert.equal(results["X402-02"]?.pass, false);
      assert.match(results["X402-02"]?.detail ?? "", /x402 v1 challenge/);
      assert.equal(results["X402-03"]?.pass, true);
      assert.equal(results["X402-04"]?.pass, true);
      assert.equal(results["X402-05"]?.pass, false);
      assert.equal(results["X402-05"]?.skipped, undefined);
    } finally {
      await target.close();
    }
  });

  it("passes X402-05 when a v1 challenge uses the CAIP-2 identifier", async () => {
    const target = await serve(v1Body("stellar:testnet"));
    try {
      const results = byId(await runX402ReadChecks({ target: target.url }));
      assert.equal(results["X402-02"]?.pass, false);
      assert.equal(results["X402-05"]?.pass, true);
    } finally {
      await target.close();
    }
  });

  it("still skips X402-03..05 when the body is not a challenge at all", async () => {
    const target = await serve("payment required");
    try {
      const results = byId(await runX402ReadChecks({ target: target.url }));
      assert.equal(results["X402-02"]?.pass, false);
      for (const id of ["X402-03", "X402-04", "X402-05"]) {
        assert.equal(results[id]?.skipped, true, id);
      }
    } finally {
      await target.close();
    }
  });
});

describe("payment checks when no payment can be built", () => {
  const payerSecretKey = Keypair.random().secret();

  for (const [label, body, reason] of [
    ["an x402 v1 challenge", v1Body("stellar-testnet"), /x402 v1 challenge/],
    ["an unreadable challenge", "payment required", /could not be read/],
  ] as const) {
    it(`skips X402-06 and X402-07 for ${label}, and sends nothing`, async () => {
      const target = await serve(body);
      try {
        const results = await runX402PaymentChecks({
          target: target.url,
          network: "stellar:testnet",
          payerSecretKey,
        });
        assert.deepEqual(
          results.map((result) => [result.id, result.skipped]),
          [
            ["X402-06", true],
            ["X402-07", true],
          ],
        );
        for (const result of results) assert.match(result.detail, reason);
        assert.equal(target.paymentHeadersSeen(), 0);
      } finally {
        await target.close();
      }
    });
  }
});
