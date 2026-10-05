/**
 * X402-08 Payment Replay Rejected, X402-09 Underpayment Rejected, X402-10
 * Expired Authorization Rejected, and the rule that every negative check
 * needs an accepted baseline.
 *
 * Offline: the payer is a throwaway EVM key, and EIP-3009 signing needs no
 * RPC, so a local stand-in on Base Sepolia's network id can take or refuse
 * every payment while recording exactly what was signed. A second stand-in
 * answers the payer's token balance, which X402-06 reads before paying. The
 * X402-10 runs wait out a one-second lifetime, so each takes about five
 * seconds.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

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
  network?: string;
  asset?: string;
}): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const challenge = {
    x402Version: 2,
    resource: { url: "http://127.0.0.1/paid" },
    accepts: [
      {
        scheme: "exact",
        network: options.network ?? NETWORK,
        amount: options.amount ?? "10000",
        asset: options.asset ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
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

/**
 * A JSON-RPC endpoint that answers every `eth_call` (the ERC-20 `balanceOf`
 * X402-06 reads) with `balance`, or fails every request with 500.
 */
async function rpcStandIn(
  balance: bigint | "unreadable",
): Promise<{ url: string; calls: () => number; close: () => Promise<void> }> {
  let calls = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      calls++;
      if (balance === "unreadable") {
        response.writeHead(500);
        response.end();
        return;
      }
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          method === "eth_call"
            ? { jsonrpc: "2.0", id, result: `0x${balance.toString(16).padStart(64, "0")}` }
            : { jsonrpc: "2.0", id, error: { code: -32601, message: "not in this stand-in" } },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    calls: () => calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A payer that holds plenty: the default for runs that are not about the balance. */
let funded: Awaited<ReturnType<typeof rpcStandIn>>;
before(async () => {
  funded = await rpcStandIn(10n ** 12n);
});
after(async () => {
  await funded.close();
});

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
        rpcUrl: funded.url,
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
        await runX402PaymentChecks({
          target: target.url,
          network: NETWORK,
          payerSecretKey: generatePrivateKey(),
          rpcUrl: funded.url,
        }),
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
        await runX402PaymentChecks({
          target: target.url,
          network: NETWORK,
          payerSecretKey: generatePrivateKey(),
          rpcUrl: funded.url,
        }),
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
        await runX402PaymentChecks({
          target: target.url,
          network: NETWORK,
          payerSecretKey: generatePrivateKey(),
          rpcUrl: funded.url,
        }),
      );
      assert.match(r["X402-06"]?.detail ?? "", /^Expected 2xx after a valid payment, got 402\.$/);
    } finally {
      await target.close();
    }
  });
});

describe("on Ethereum Sepolia", () => {
  // Circle's Sepolia USDC is not an SDK default asset, and the SDK client's
  // spend controls refuse non-default assets unless they are allowed.
  it("pays in Circle's Sepolia USDC, up to the SDK's own $1 cap", async () => {
    for (const [amount, paid] of [
      ["10000", true],
      ["1000001", false],
    ] as const) {
      const target = await standIn({
        mode: "refuse",
        amount,
        network: "eip155:11155111",
        asset: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      });
      try {
        const r = byId(
          await runX402PaymentChecks({
            target: target.url,
            network: "eip155:11155111",
            payerSecretKey: generatePrivateKey(),
            rpcUrl: funded.url,
          }),
        );
        assert.equal(target.received.length, paid ? 1 : 0, amount);
        if (paid) assert.match(r["X402-06"]?.detail ?? "", /got 402/);
        else {
          assert.equal(r["X402-06"]?.error?.kind, "setup");
          assert.match(r["X402-06"]?.detail ?? "", /asks for 1000001 base units .* more than the \$1 a payment/);
        }
      } finally {
        await target.close();
      }
    }
  });
});

describe("a target the SDK client's spend controls refuse", () => {
  // Not the target's fault, and nothing is sent: no verdict, saying why.
  it("is a setup error on a price above $1, or on an asset the client does not pay in", async () => {
    for (const [label, options, reason] of [
      ["above $1", { amount: "1000001" }, /more than the \$1 a payment the official x402 client pays by default/],
      ["other asset", { asset: "0x0000000000000000000000000000000000000Bad" }, /not an asset the official x402 client pays in by default/],
    ] as const) {
      const target = await standIn({ mode: "accept", ...options });
      try {
        const r = byId(
          await runX402PaymentChecks({
            target: target.url,
            network: NETWORK,
            payerSecretKey: generatePrivateKey(),
            rpcUrl: funded.url,
          }),
        );
        assert.equal(r["X402-06"]?.error?.kind, "setup", label);
        assert.match(r["X402-06"]?.detail ?? "", reason, label);
        for (const id of ["X402-07", "X402-08", "X402-09", "X402-10"]) assert.equal(r[id]?.skipped, true, `${label} ${id}`);
        assert.equal(target.received.length, 0, label);
      } finally {
        await target.close();
      }
    }
  });
});

describe("a payer that cannot cover the price", () => {
  // Measured on Solana devnet: an unfunded payer's payment is refused for a
  // reason a real defect gives too. Read first, it is the payer's, not the
  // target's: no verdict, and nothing is sent.
  it("gets X402-06 as a setup error before any payment is sent", async () => {
    const target = await standIn({ mode: "accept" });
    const chain = await rpcStandIn(9_999n);
    try {
      const r = byId(
        await runX402PaymentChecks({
          target: target.url,
          network: NETWORK,
          payerSecretKey: generatePrivateKey(),
          rpcUrl: chain.url,
        }),
      );
      assert.equal(r["X402-06"]?.error?.kind, "setup");
      assert.match(r["X402-06"]?.detail ?? "", /holds less of .* than the advertised 10000 base units/);
      assert.match(r["X402-06"]?.detail ?? "", /EVM_PRIVATE_KEY/);
      for (const id of ["X402-07", "X402-08", "X402-09", "X402-10"]) assert.equal(r[id]?.skipped, true, id);
      assert.equal(target.received.length, 0);
    } finally {
      await chain.close();
      await target.close();
    }
  });

  it("pays as before when the balance cannot be read, or covers the price exactly", async () => {
    for (const balance of ["unreadable", 10_000n] as const) {
      const target = await standIn({ mode: "refuse" });
      const chain = await rpcStandIn(balance);
      try {
        const r = byId(
          await runX402PaymentChecks({
            target: target.url,
            network: NETWORK,
            payerSecretKey: generatePrivateKey(),
            rpcUrl: chain.url,
          }),
        );
        assert.ok(chain.calls() > 0, `${balance}: the balance was asked for`);
        assert.equal(r["X402-06"]?.error, undefined, `${balance}: no setup error`);
        assert.match(r["X402-06"]?.detail ?? "", /got 402/, `${balance}`);
        assert.equal(target.received.length, 1, `${balance}: the payment was sent`);
      } finally {
        await chain.close();
        await target.close();
      }
    }
  });
});

describe("when a negative check has nothing to test", () => {
  it("skips X402-08 under payment-identifier, and X402-09 at a 1-unit price", async () => {
    const target = await standIn({ mode: "accept", amount: "1", paymentIdentifier: true });
    try {
      const r = byId(
        await runX402PaymentChecks({
          target: target.url,
          network: NETWORK,
          payerSecretKey: generatePrivateKey(),
          rpcUrl: funded.url,
        }),
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
