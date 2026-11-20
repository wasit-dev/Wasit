/**
 * L0 seen from the CLI: `wasit mpp-charge`, `wasit mpp-channel` and `wasit test`
 * on stellar:pubnet with an RPC endpoint send no payment, whether the network
 * comes from the flag or from MPP_STELLAR_NETWORK.
 *
 * Runs the built binary (`npm run build` first) in an empty temporary
 * directory with an empty HOME, so no `.env` and no saved wallet are loaded.
 * Every key is generated here and holds nothing. Nothing leaves 127.0.0.1.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

interface Target {
  readonly url: string;
  readonly requests: () => number;
  readonly paid: () => number;
  readonly close: () => Promise<void>;
}

/**
 * Answers every request with a well-formed x402 v2 challenge on stellar:pubnet,
 * counting all requests and those that carried a payment or a credential.
 */
async function target(): Promise<Target> {
  let requests = 0;
  let paid = 0;
  const challenge = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "http://127.0.0.1/paid" },
      accepts: [
        {
          scheme: "exact",
          network: "stellar:pubnet",
          amount: "10000",
          asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
          payTo: Keypair.random().publicKey(),
          maxTimeoutSeconds: 60,
          extra: { areFeesSponsored: true },
        },
      ],
    }),
  ).toString("base64");
  const server = http.createServer((req, res) => {
    requests += 1;
    if (req.headers["payment-signature"] || req.headers["x-payment"] || req.headers.authorization) paid += 1;
    res.writeHead(402, { "payment-required": challenge, "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/paid`,
    requests: () => requests,
    paid: () => paid,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** An https RPC address on 127.0.0.1 that counts connections and drops each one. */
async function countingRpc() {
  let calls = 0;
  const server = net.createServer((socket) => {
    calls += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `https://127.0.0.1:${port}`,
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
}

function wasit(args: string[], cwd: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: cwd, NO_COLOR: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

interface StructuredCheck {
  readonly id: string;
  readonly detail: string;
  readonly errorKind?: string;
}

function checks(run: Run): StructuredCheck[] {
  return (JSON.parse(run.stdout) as { results: StructuredCheck[] }).results;
}

describe("the CLI on stellar:pubnet", () => {
  let cwd: string;
  let paywall: Target;
  let rpc: Awaited<ReturnType<typeof countingRpc>>;

  before(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "wasit-l0-"));
  });
  after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const fresh = async () => {
    paywall = await target();
    rpc = await countingRpc();
  };
  const closeAll = async () => {
    await paywall.close();
    await rpc.close();
  };

  for (const [label, args, env] of [
    ["--network", ["--network", "stellar:pubnet"], {}],
    ["MPP_STELLAR_NETWORK", [], { MPP_STELLAR_NETWORK: "stellar:pubnet" }],
  ] as const) {
    it(`wasit mpp-charge with ${label} refuses, sends nothing, exits 2`, async () => {
      await fresh();
      try {
        const run = await wasit(
          ["mpp-charge", "--target", paywall.url, ...args, "--rpc-url", rpc.url, "--payer-key", Keypair.random().secret(), "--json"],
          cwd,
          env,
        );
        assert.equal(run.code, 2, run.stdout);
        const [result] = checks(run);
        assert.equal(result?.id, "MPP-01");
        assert.equal(result?.errorKind, "configuration");
        assert.match(result?.detail ?? "", /MPP stays on test networks/);
        assert.equal(paywall.requests(), 0);
        assert.equal(rpc.calls(), 0);
      } finally {
        await closeAll();
      }
    });
  }

  it("wasit mpp-channel refuses at preflight, sends nothing, exits 2", async () => {
    await fresh();
    try {
      const run = await wasit(
        [
          "mpp-channel", "--target", paywall.url, "--network", "stellar:pubnet", "--rpc-url", rpc.url,
          "--commitment-key", randomBytes(32).toString("hex"), "--json",
        ],
        cwd,
      );
      assert.equal(run.code, 2, run.stdout);
      const [result, ...rest] = checks(run);
      assert.equal(result?.id, "PREFLIGHT");
      assert.equal(result?.errorKind, "configuration");
      assert.equal(rest.length, 0);
      assert.equal(paywall.requests(), 0);
      assert.equal(rpc.calls(), 0);
    } finally {
      await closeAll();
    }
  });

  // The read checks are never guarded: they send no payment and take no key.
  // What must not happen is the payment that would follow them.
  it("wasit test runs the read checks and pays nothing", async () => {
    await fresh();
    try {
      const run = await wasit(
        ["test", "--target", paywall.url, "--network", "stellar:pubnet", "--rpc-url", rpc.url, "--payer-key", Keypair.random().secret(), "--json"],
        cwd,
      );
      const results = checks(run);
      const preflight = results.find((result) => result.id === "PREFLIGHT");
      assert.equal(preflight?.errorKind, "configuration", run.stdout);
      assert.match(preflight?.detail ?? "", /the mainnet opt-in is not part of this version/);
      assert.equal(results.some((result) => /^X402-(0[6-9]|10)$/.test(result.id)), false);
      assert.equal(paywall.paid(), 0);
      assert.equal(rpc.calls(), 0);
    } finally {
      await closeAll();
    }
  });
});
