/**
 * X402-08 Payment Replay Rejected, X402-09 Underpayment Rejected, X402-10
 * Expired Authorization Rejected, and the rule that every negative check
 * needs an accepted baseline.
 *
 * Offline: the payer is a throwaway EVM key, and EIP-3009 signing needs no
 * RPC, so a local stand-in on Base Sepolia's network id can take or refuse
 * every payment while recording exactly what was signed. The X402-10 runs
 * wait out a one-second lifetime, so each takes about five seconds.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";

import { generatePrivateKey } from "viem/accounts";

import type { CheckResult } from "../../src/check.js";
import {
  expiredVerdict,
  replayVerdict,
  runX402PaymentChecks,
  underpaymentVerdict,
} from "../../src/x402/simulator.js";

const NETWORK = "eip155:84532";

interface Received {
  readonly raw: string;
  readonly payload: {
    accepted: { amount: string; maxTimeoutSeconds: number };
    payload: { authorization: { value: string; validBefore: string } };
  };
  readonly atSeconds: number;
}

/**
 * Answers unpaid requests with a Base Sepolia challenge; answers payments
 * with 200 and no settlement (`accept`), or with 402 (`refuse`).
 */
async function standIn(options: {
  mode: "accept" | "refuse" | "permit2-allowance";
  amount?: string;
  paymentIdentifier?: boolean;
}): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const challenge = {
    x402Version: 2,
    resource: { url: "http://127.0.0.1/paid" },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        amount: options.amount ?? "10000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
    ...(options.paymentIdentifier
      ? { extensions: { "payment-identifier": { info: { required: false } } } }
      : {}),
  };
  const header = Buffer.from(JSON.stringify(challenge)).toString("base64");
  const server = http.createServer((request, response) => {
    const paid = request.headers["payment-signature"];
    if (typeof paid !== "string") {
      response.writeHead(402, { "payment-required": header });
      response.end();
      return;
    }
    received.push({
      raw: paid,
      payload: JSON.parse(Buffer.from(paid, "base64").toString("utf-8")),
      atSeconds: Math.floor(Date.now() / 1000),
    });
    if (options.mode === "permit2-allowance") {
      const refusal = { ...challenge, error: "permit2_allowance_required" };
      response.writeHead(412, { "payment-required": Buffer.from(JSON.stringify(refusal)).toString("base64") });
      response.end();
      return;
    }
    response.writeHead(options.mode === "accept" ? 200 : 402);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/paid`,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function byId(results: CheckResult[]): Record<string, CheckResult> {
  return Object.fromEntries(results.map((result) => [result.id, result]));
}

describe("the negative checks against a target that takes anything", () => {
  it("fails X402-07 to X402-10, having sent exactly what each one claims", async () => {
    const target = await standIn({ mode: "accept" });
    try {
      const results = await runX402PaymentChecks({
        target: target.url,
        network: NETWORK,
        payerSecretKey: generatePrivateKey(),
      });
      assert.deepEqual(
        results.map((result) => result.id),
        ["X402-06", "X402-07", "X402-08", "X402-09", "X402-10"],
      );
      const r = byId(results);
      assert.match(r["X402-06"]!.detail, /no PAYMENT-RESPONSE header/);
      for (const id of ["X402-07", "X402-08", "X402-09", "X402-10"]) {
        assert.equal(r[id]?.pass, false, id);
        assert.equal(r[id]?.skipped, undefined, id);
        assert.ok(r[id]?.hint, `${id} carries a fix`);
      }

      // Order of payments: honest, corrupted, replay, underpaid, expired.
      const [honest, , replay, underpaid, expired] = target.received;
      assert.equal(target.received.length, 5);
      assert.equal(replay?.raw, honest?.raw, "the replay is the honest payment, byte for byte");
      assert.equal(underpaid?.payload.payload.authorization.value, "5000");
      assert.equal(underpaid?.payload.accepted.amount, "10000", "it still claims the advertised price");
      assert.equal(expired?.payload.accepted.maxTimeoutSeconds, 60, "it still claims the advertised window");
      assert.ok(
        Number(expired?.payload.payload.authorization.validBefore) < expired!.atSeconds,
        "the authorization had expired when it arrived",
      );
    } finally {
      await target.close();
    }
  });
});

describe("a target that refuses even the valid payment", () => {
  it("gets no verdict on any negative check, and is sent only the valid payment", async () => {
    const target = await standIn({ mode: "refuse" });
    try {
      const r = byId(
        await runX402PaymentChecks({ target: target.url, network: NETWORK, payerSecretKey: generatePrivateKey() }),
      );
      assert.equal(r["X402-06"]?.pass, false);
      for (const id of ["X402-07", "X402-08", "X402-09", "X402-10"]) {
        assert.equal(r[id]?.skipped, true, id);
        assert.match(r[id]?.skipReason ?? "", /refused X402-06's valid payment/, id);
      }
      assert.equal(target.received.length, 1);
    } finally {
      await target.close();
    }
  });
});

describe("a Permit2 target that needs an approval this payer never made", () => {
  // The refusal is about Wasit's payer, not the target: no verdict, and no
  // negative check runs without an accepted baseline.
  it("reports X402-06 as a setup error and skips the negative checks", async () => {
    const target = await standIn({ mode: "permit2-allowance" });
    try {
      const r = byId(
        await runX402PaymentChecks({ target: target.url, network: NETWORK, payerSecretKey: generatePrivateKey() }),
      );
      assert.equal(r["X402-06"]?.error?.kind, "setup");
      assert.match(r["X402-06"]?.detail ?? "", /approved the Permit2 contract/);
      for (const id of ["X402-07", "X402-08", "X402-09", "X402-10"]) assert.equal(r[id]?.skipped, true, id);
    } finally {
      await target.close();
    }
  });
});

describe("a refused valid payment", () => {
  // Earlier evidence quotes this wording; a reason is added only when given.
  it("keeps X402-06's wording when the target gives no reason", async () => {
    const target = await standIn({ mode: "refuse" });
    try {
      const r = byId(
        await runX402PaymentChecks({ target: target.url, network: NETWORK, payerSecretKey: generatePrivateKey() }),
      );
      assert.match(r["X402-06"]?.detail ?? "", /^Expected 2xx after a valid payment, got 402\.$/);
    } finally {
      await target.close();
    }
  });
});

describe("when a negative check has nothing to test", () => {
  it("skips X402-08 under payment-identifier, and X402-09 at a 1-unit price", async () => {
    const target = await standIn({ mode: "accept", amount: "1", paymentIdentifier: true });
    try {
      const r = byId(
        await runX402PaymentChecks({ target: target.url, network: NETWORK, payerSecretKey: generatePrivateKey() }),
      );
      assert.equal(r["X402-08"]?.skipped, true);
      assert.match(r["X402-08"]?.skipReason ?? "", /payment-identifier/);
      assert.equal(r["X402-09"]?.skipped, true);
      assert.match(r["X402-09"]?.skipReason ?? "", /1 base unit/);
      assert.equal(r["X402-07"]?.pass, false);
      assert.equal(r["X402-10"]?.pass, false);
      // honest, corrupted, expired: no replay and no underpayment were sent.
      assert.equal(target.received.length, 3);
    } finally {
      await target.close();
    }
  });
});

describe("the verdicts", () => {
  it("pass a refusal and fail a 2xx, with a fix only on the failure", () => {
    for (const verdict of [replayVerdict, expiredVerdict, (s: number) => underpaymentVerdict(s, 5000n, 10000n)]) {
      const refused = verdict(402);
      assert.equal(refused.pass, true);
      assert.equal(refused.hint, undefined);
      const served = verdict(200);
      assert.equal(served.pass, false);
      assert.ok(served.hint);
    }
  });

  it("say what was offered against what was advertised", () => {
    assert.match(underpaymentVerdict(200, 5000n, 10000n).detail, /5000 of the advertised 10000 base units was accepted/);
    assert.match(replayVerdict(200).detail, /one payment bought the resource twice/);
    assert.match(expiredVerdict(200).detail, /cannot settle/);
  });
});
