/**
 * Covers what runners.ts must always get right offline: refusing to run
 * mpp-channel/mpp-charge before touching the network when the required secret
 * is missing, or when MPP_STELLAR_NETWORK names a network that is not a test
 * network (L0). The success paths need a real target and a real key — out of
 * scope here, same "no keys, no target, no network" rule the rest of this
 * repo's unit tests follow. The L0 cases use keys generated here, which hold
 * nothing, and a target on 127.0.0.1 that only counts requests.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import { runAction } from "../../src/dashboard/runners.js";

/** A target on 127.0.0.1 that answers 402 to everything and counts requests. */
async function countingTarget() {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(402, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/paid`,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const ENV_KEYS = ["COMMITMENT_SECRET_HEX", "MPP_PAYER_SECRET", "MPP_STELLAR_NETWORK"] as const;

describe("runAction", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  // The real process env may already carry these from a loaded .env — clear
  // them for the duration of each test so the guard clauses are exercised
  // regardless of what's set on the machine running the suite.
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) saved[key] = value;
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      // Drop what a test set before putting back what the machine had.
      delete process.env[key];
      const value = saved[key];
      if (value !== undefined) process.env[key] = value;
      delete saved[key];
    }
  });

  it("refuses mpp-channel without a commitment key, before touching the network", async () => {
    await assert.rejects(
      () => runAction({ kind: "mpp-channel" }, "https://example.com", () => {}),
      /COMMITMENT_SECRET_HEX/,
    );
  });

  it("refuses mpp-charge without a payer key, before touching the network", async () => {
    await assert.rejects(
      () => runAction({ kind: "mpp-charge" }, "https://example.com", () => {}),
      /MPP_PAYER_SECRET/,
    );
  });

  // L0: MPP_STELLAR_NETWORK=stellar:pubnet with a key set must not reach the
  // target. The refusal comes back as a configuration result, not a throw, so
  // the run screen shows it like any other result that has no verdict.
  it("refuses mpp-charge on stellar:pubnet, sends nothing", async () => {
    process.env.MPP_PAYER_SECRET = Keypair.random().secret();
    process.env.MPP_STELLAR_NETWORK = "stellar:pubnet";
    const target = await countingTarget();
    try {
      const results = await runAction({ kind: "mpp-charge" }, target.url, () => {});
      assert.equal(results.length, 1);
      assert.equal(results[0]?.id, "MPP-01");
      assert.equal(results[0]?.error?.kind, "configuration");
      assert.match(results[0]?.detail ?? "", /MPP stays on test networks/);
      assert.equal(target.requests(), 0);
    } finally {
      await target.close();
    }
  });

  it("refuses mpp-channel on stellar:pubnet at preflight, sends nothing", async () => {
    process.env.COMMITMENT_SECRET_HEX = randomBytes(32).toString("hex");
    process.env.MPP_STELLAR_NETWORK = "stellar:pubnet";
    const target = await countingTarget();
    try {
      const results = await runAction({ kind: "mpp-channel" }, target.url, () => {});
      assert.equal(results.length, 1);
      assert.equal(results[0]?.id, "PREFLIGHT");
      assert.equal(results[0]?.error?.kind, "configuration");
      assert.match(results[0]?.detail ?? "", /MPP stays on test networks/);
      assert.equal(target.requests(), 0);
    } finally {
      await target.close();
    }
  });
});
