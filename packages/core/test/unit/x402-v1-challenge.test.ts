/**
 * x402 v1 challenges, and challenges the payment client cannot read.
 *
 * x402 v1 signals payment in the 402 response body; v2 uses the
 * PAYMENT-REQUIRED header, and the `exact` scheme on Stellar is defined for v2
 * only. Wasit grades v2, so a v1 service is "unsupported": X402-02..05 are
 * SKIPs of kind `unsupported`, not a FAIL on a service that may be conformant
 * to the version it speaks (spec A3). The v1 field findings are kept as notes
 * in the skip's detail. Neither payment check has a verdict when no payment
 * could be built. Before 0.5.0 a v1 target got X402-06/07 reported as FAIL;
 * before this change it got X402-02 reported as FAIL.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import { checkStatus, type CheckResult } from "../../src/check.js";
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
  it("reports X402-02..05 as unsupported skips, not failures, and keeps the v1 findings as notes", async () => {
    const target = await serve(v1Body("stellar-testnet"));
    try {
      const results = byId(await runX402ReadChecks({ target: target.url }));
      assert.equal(results["X402-01"]?.pass, true);
      for (const id of ["X402-02", "X402-03", "X402-04", "X402-05"]) {
        assert.equal(checkStatus(results[id]!), "SKIP", id);
        assert.equal(results[id]?.skipKind, "unsupported", id);
        assert.equal(results[id]?.pass, false, id);
        assert.match(results[id]?.skipReason ?? "", /x402 v1/, id);
      }
      assert.equal(Object.values(results).some((result) => checkStatus(result) === "FAIL"), false);
      // The v1 field findings stay visible, labelled as notes and not as verdicts.
      assert.match(results["X402-04"]?.detail ?? "", /Note, not a verdict: All required v1 fields present/);
      assert.match(
        results["X402-05"]?.detail ?? "",
        /Note, not a verdict: "stellar-testnet" is not a CAIP-2 identifier.*x402 v1 used plain names/,
      );
    } finally {
      await target.close();
    }
  });

  it("notes a valid CAIP-2 network on a v1 challenge, still as a skip", async () => {
    const target = await serve(v1Body("stellar:testnet"));
    try {
      const results = byId(await runX402ReadChecks({ target: target.url }));
      assert.equal(checkStatus(results["X402-02"]!), "SKIP");
      assert.equal(checkStatus(results["X402-05"]!), "SKIP");
      assert.match(results["X402-05"]?.detail ?? "", /Note, not a verdict: Network identifier "stellar:testnet" is valid/);
    } finally {
      await target.close();
    }
  });

  it("notes a v1 challenge missing a field, without failing it", async () => {
    const broken = JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "stellar:testnet" }] });
    const target = await serve(broken);
    try {
      const results = byId(await runX402ReadChecks({ target: target.url }));
      assert.equal(checkStatus(results["X402-04"]!), "SKIP");
      assert.match(results["X402-04"]?.detail ?? "", /Note, not a verdict: Missing: maxAmountRequired, asset, payTo/);
    } finally {
      await target.close();
    }
  });

  it("fails X402-02 and skips the rest as a dependency when the body is not a challenge at all", async () => {
    const target = await serve("payment required");
    try {
      const results = byId(await runX402ReadChecks({ target: target.url }));
      assert.equal(checkStatus(results["X402-02"]!), "FAIL");
      for (const id of ["X402-03", "X402-04", "X402-05"]) {
        assert.equal(results[id]?.skipped, true, id);
        assert.equal(results[id]?.skipKind, "dependency", id);
      }
    } finally {
      await target.close();
    }
  });

  it("does not turn a v2 header challenge into unsupported, even with a v1 body", async () => {
    const v2Header = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [] })).toString("base64");
    const server = http.createServer((_request, response) => {
      response.writeHead(402, { "payment-required": v2Header, "content-type": "application/json" });
      response.end(v1Body("stellar:testnet"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const results = byId(await runX402ReadChecks({ target: `http://127.0.0.1:${port}/paid` }));
      assert.equal(checkStatus(results["X402-02"]!), "PASS");
      assert.equal(results["X402-02"]?.skipKind, undefined);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("payment checks when no payment can be built", () => {
  const payerSecretKey = Keypair.random().secret();

  for (const [label, body, reason] of [
    ["an x402 v1 challenge", v1Body("stellar-testnet"), /x402 v1 challenge/],
    ["an unreadable challenge", "payment required", /could not be read/],
  ] as const) {
    it(`skips every payment check for ${label}, and sends nothing`, async () => {
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
            ["X402-08", true],
            ["X402-09", true],
            ["X402-10", true],
            ["X402-11", true],
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
