/**
 * L0 seen from the MCP server: `wasit_mpp_charge_test`, `wasit_mpp_channel_test`
 * and `wasit_x402_test` called with stellar:pubnet and an RPC URL send no
 * payment, whether the network comes from the tool argument or, for MPP, from
 * MPP_STELLAR_NETWORK in the server's environment.
 *
 * Starts the built server (`npm run build` first) through the SDK's own stdio
 * client, the way an MCP client starts it, with an empty temporary directory
 * as its working directory and HOME. Every key is generated here and holds
 * nothing. Nothing leaves 127.0.0.1.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Keypair } from "@stellar/stellar-sdk";

const SERVER = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

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

interface StructuredCheck {
  readonly id: string;
  readonly status: string;
  readonly detail: string;
  readonly errorKind?: string;
}

/** Starts the server with `env`, calls one tool, stops the server. */
async function callTool(
  cwd: string,
  env: Record<string, string>,
  name: string,
  args: Record<string, unknown>,
): Promise<StructuredCheck[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd,
    // The SDK adds HOME, PATH and a few others from this process; HOME is
    // overridden so nothing under the real home directory is read.
    env: { HOME: cwd, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "wasit-l0-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    return (result.structuredContent as { results: StructuredCheck[] }).results;
  } finally {
    await client.close();
  }
}

describe("the MCP server on stellar:pubnet", () => {
  let cwd: string;
  let paywall: Target;
  let rpc: Awaited<ReturnType<typeof countingRpc>>;

  before(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "wasit-l0-mcp-"));
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
    ["the network argument", { network: "stellar:pubnet" }, {}],
    ["MPP_STELLAR_NETWORK", {}, { MPP_STELLAR_NETWORK: "stellar:pubnet" }],
  ] as const) {
    it(`wasit_mpp_charge_test with ${label} refuses and sends nothing`, async () => {
      await fresh();
      try {
        const results = await callTool(
          cwd,
          { MPP_PAYER_SECRET: Keypair.random().secret(), ...env },
          "wasit_mpp_charge_test",
          { target: paywall.url, rpcUrl: rpc.url, ...args },
        );
        assert.equal(results.length, 1);
        assert.equal(results[0]?.id, "MPP-01");
        assert.equal(results[0]?.status, "ERROR");
        assert.equal(results[0]?.errorKind, "configuration");
        assert.match(results[0]?.detail ?? "", /MPP stays on test networks/);
        assert.equal(paywall.requests(), 0);
        assert.equal(rpc.calls(), 0);
      } finally {
        await closeAll();
      }
    });

    it(`wasit_mpp_channel_test with ${label} refuses at preflight and sends nothing`, async () => {
      await fresh();
      try {
        const results = await callTool(
          cwd,
          { COMMITMENT_SECRET_HEX: randomBytes(32).toString("hex"), ...env },
          "wasit_mpp_channel_test",
          { target: paywall.url, rpcUrl: rpc.url, ...args },
        );
        assert.equal(results.length, 1);
        assert.equal(results[0]?.id, "PREFLIGHT");
        assert.equal(results[0]?.status, "ERROR");
        assert.equal(results[0]?.errorKind, "configuration");
        assert.match(results[0]?.detail ?? "", /MPP stays on test networks/);
        assert.equal(paywall.requests(), 0);
        assert.equal(rpc.calls(), 0);
      } finally {
        await closeAll();
      }
    });
  }

  // The read checks are never guarded: they send no payment and take no key.
  // What must not happen is the payment that would follow them.
  it("wasit_x402_test runs the read checks and pays nothing", async () => {
    await fresh();
    try {
      const results = await callTool(
        cwd,
        { STELLAR_PRIVATE_KEY: Keypair.random().secret() },
        "wasit_x402_test",
        { target: paywall.url, network: "stellar:pubnet", rpcUrl: rpc.url },
      );
      const preflight = results.find((result) => result.id === "PREFLIGHT");
      assert.equal(preflight?.errorKind, "configuration", JSON.stringify(results));
      assert.match(preflight?.detail ?? "", /this run has no mainnet opt-in: Wasit pays there only through wasit run --mainnet, the Action's mainnet: true on workflow_dispatch, or the MCP server's wasit_x402_mainnet_test/);
      assert.equal(results.some((result) => /^X402-(0[6-9]|10)$/.test(result.id)), false);
      assert.equal(paywall.paid(), 0);
      assert.equal(rpc.calls(), 0);
    } finally {
      await closeAll();
    }
  });
});
