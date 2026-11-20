/**
 * The MCP server's start-up switches and its RPC (spec B5, B12; D-023c option C).
 *
 * - `WASIT_MAINNET_OPT_IN`, `WASIT_MAINNET_CONFIG` and `--mainnet` ask for the
 *   mainnet opt-in, which this version does not have: the server does not
 *   start, exit 2, and says why. Without them the tool list has no mainnet tool.
 * - `WASIT_RPC_URL`, read once at start-up, fixes the RPC of every tool call;
 *   the server then refuses the `rpcUrl` argument before anything is sent. A
 *   value that is not an http(s) URL stops the server, without being echoed.
 * - A result that reads the chain names its RPC by origin, says where it came
 *   from, and flags one that is not Wasit's default.
 *
 * Starts the built server (`npm run build` first), as an MCP client does. Every
 * key is generated here and holds nothing. Nothing leaves 127.0.0.1.
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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Keypair } from "@stellar/stellar-sdk";

const SERVER = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const SECRET_PATH = "/v1/rpc-key-5f4e3d2c1b0a";

/** Starts the server as a plain process and waits for it to end (or kills it after `ms`). */
function startRaw(cwd: string, env: Record<string, string>, args: string[] = [], ms = 10_000) {
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, ...args], {
      cwd,
      env: { PATH: process.env["PATH"] ?? "", HOME: cwd, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), ms);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });
}

/** Answers every request with an x402 v2 challenge on stellar:testnet, counting requests and paid ones. */
async function target() {
  let requests = 0;
  let paid = 0;
  const challenge = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "http://127.0.0.1/paid" },
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          amount: "10000",
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
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
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** An RPC address on 127.0.0.1 that counts connections and drops each one. */
async function countingRpc() {
  let calls = 0;
  const server = net.createServer((socket) => {
    calls += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}${SECRET_PATH}`,
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface ToolResult {
  readonly isError?: boolean;
  readonly text: string;
  readonly structured?: { rpc?: { origin: string; source: string; isDefault: boolean }; results?: Array<{ id: string; status: string }> };
}

async function withClient<T>(cwd: string, env: Record<string, string>, use: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd,
    env: { HOME: cwd, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "wasit-rpc-lock-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await use(client);
  } finally {
    await client.close();
  }
}

async function call(cwd: string, env: Record<string, string>, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return withClient(cwd, env, async (client) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }>;
    return {
      ...(result.isError === true ? { isError: true } : {}),
      text: content.map((entry) => entry.text ?? "").join("\n"),
      ...(result.structuredContent === undefined ? {} : { structured: result.structuredContent as ToolResult["structured"] }),
    };
  });
}

describe("the MCP server's start-up switches (B12)", () => {
  let cwd: string;
  before(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "wasit-mcp-switch-"));
  });
  after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  for (const [name, env, args] of [
    ["WASIT_MAINNET_OPT_IN", { WASIT_MAINNET_OPT_IN: "1" }, []],
    ["WASIT_MAINNET_OPT_IN", { WASIT_MAINNET_OPT_IN: "0" }, []],
    ["WASIT_MAINNET_CONFIG", { WASIT_MAINNET_CONFIG: "/srv/wasit/mainnet.config.json" }, []],
    ["--mainnet", {}, ["--mainnet"]],
  ] as const) {
    it(`does not start with ${name}${"WASIT_MAINNET_OPT_IN" in env ? `=${env.WASIT_MAINNET_OPT_IN}` : ""}: exit 2, and says why on stderr`, async () => {
      const result = await startRaw(cwd, { ...env }, [...args]);
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.stdout, "", "nothing on the protocol channel");
      assert.match(result.stderr, new RegExp(`^wasit MCP server: ${name.replace(/[-]/g, "\\-")} is (set|refused): the mainnet opt-in is not part of this version`));
      assert.match(result.stderr, /Wasit pays on test networks only \(stellar:testnet, /);
    });
  }

  it("names every switch that is set", async () => {
    const result = await startRaw(cwd, { WASIT_MAINNET_OPT_IN: "1", WASIT_MAINNET_CONFIG: "/x.json" }, ["--mainnet"]);
    assert.equal(result.code, 2);
    for (const name of ["--mainnet", "WASIT_MAINNET_OPT_IN", "WASIT_MAINNET_CONFIG"]) assert.ok(result.stderr.includes(`${name} is`), name);
  });

  it("starts without them, and its tool list has no mainnet tool", async () => {
    const names = await withClient(cwd, {}, async (client) => (await client.listTools()).tools.map((tool) => tool.name));
    assert.deepEqual(names.sort(), ["wasit_mpp_channel_test", "wasit_mpp_charge_test", "wasit_x402_test"]);
    assert.ok(!names.some((name) => /mainnet|pubnet/i.test(name)));
  });

  it("does not start when WASIT_RPC_URL is not an http(s) URL, and never echoes the value", async () => {
    for (const value of ["rpc.example.test/key-77aa", "ftp://rpc.example.test/key-77aa"]) {
      const result = await startRaw(cwd, { WASIT_RPC_URL: value });
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /^wasit MCP server: WASIT_RPC_URL /);
      assert.match(result.stderr, /so this server does not start\./);
      assert.ok(!result.stderr.includes("key-77aa"), result.stderr);
    }
  });
});

describe("the MCP server's RPC lock and the RPC in results (D-023c)", () => {
  let cwd: string;
  before(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "wasit-mcp-rpc-"));
  });
  after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const tools: Array<[string, Record<string, string>, Record<string, unknown>?]> = [
    ["wasit_x402_test", { STELLAR_PRIVATE_KEY: Keypair.random().secret() }],
    ["wasit_mpp_charge_test", { MPP_PAYER_SECRET: Keypair.random().secret() }],
    ["wasit_mpp_channel_test", { COMMITMENT_SECRET_HEX: randomBytes(32).toString("hex") }],
    // The close tool exists only with WASIT_ALLOW_DESTRUCTIVE=1 (review R6, S1).
    [
      "wasit_mpp_channel_test_with_close",
      { COMMITMENT_SECRET_HEX: randomBytes(32).toString("hex"), WASIT_ALLOW_DESTRUCTIVE: "1" },
      { destructiveChannel: "CDESTROYCHANNEL" },
    ],
  ];

  for (const [tool, keys, extra = {}] of tools) {
    it(`${tool}: with WASIT_RPC_URL set, the rpcUrl argument is refused before anything is sent`, async () => {
      const paywall = await target();
      const locked = await countingRpc();
      const other = await countingRpc();
      try {
        const result = await call(cwd, { ...keys, WASIT_RPC_URL: locked.url }, tool, { target: paywall.url, rpcUrl: other.url, ...extra });
        assert.equal(result.isError, true, result.text);
        assert.match(result.text, /^rpcUrl is not taken by this server: its RPC was fixed when it started \(WASIT_RPC_URL, http:\/\/127\.0\.0\.1:\d+\)\./);
        assert.match(result.text, /Nothing was sent\.$/);
        assert.ok(!result.text.includes(SECRET_PATH), "the lock's path was printed");
        assert.equal(paywall.requests(), 0);
        assert.equal(locked.calls(), 0);
        assert.equal(other.calls(), 0);
      } finally {
        await paywall.close();
        await locked.close();
        await other.close();
      }
    });
  }

  it("wasit_x402_test with WASIT_RPC_URL and no argument reads through the lock and names it by origin, flagged", async () => {
    const paywall = await target();
    const locked = await countingRpc();
    try {
      const result = await call(cwd, { STELLAR_PRIVATE_KEY: Keypair.random().secret(), WASIT_RPC_URL: locked.url }, "wasit_x402_test", { target: paywall.url });
      assert.ok(
        result.text.includes(
          `RPC: ${locked.origin}, fixed when this server started (WASIT_RPC_URL): not Wasit's default for stellar:testnet, so every chain read of this run is this RPC's word.`,
        ),
        result.text,
      );
      assert.deepEqual(result.structured?.rpc, { origin: locked.origin, source: "start-up", isDefault: false });
      assert.ok(locked.calls() > 0, "the lock was not the RPC the run used");
      assert.ok(!JSON.stringify(result).includes(SECRET_PATH), "the lock's path was printed");
      assert.equal(paywall.paid(), 0);
    } finally {
      await paywall.close();
      await locked.close();
    }
  });

  it("wasit_x402_test without a lock names the rpcUrl argument by origin, flagged", async () => {
    const paywall = await target();
    const rpc = await countingRpc();
    try {
      const result = await call(cwd, { STELLAR_PRIVATE_KEY: Keypair.random().secret() }, "wasit_x402_test", { target: paywall.url, rpcUrl: rpc.url });
      assert.ok(
        result.text.includes(`RPC: ${rpc.origin}, from the rpcUrl argument: not Wasit's default for stellar:testnet, so every chain read of this run is this RPC's word.`),
        result.text,
      );
      assert.deepEqual(result.structured?.rpc, { origin: rpc.origin, source: "argument", isDefault: false });
      assert.ok(!JSON.stringify(result).includes(SECRET_PATH));
      assert.equal(paywall.paid(), 0);
    } finally {
      await paywall.close();
      await rpc.close();
    }
  });

  it("wasit_x402_test that reads no chain (readOnly, or no payer key) names no RPC", async () => {
    const paywall = await target();
    const rpc = await countingRpc();
    try {
      for (const [env, args] of [
        [{ STELLAR_PRIVATE_KEY: Keypair.random().secret() }, { readOnly: true }],
        [{}, {}],
      ] as const) {
        const result = await call(cwd, { ...env }, "wasit_x402_test", { target: paywall.url, rpcUrl: rpc.url, ...args });
        assert.doesNotMatch(result.text, /^RPC: /m, result.text);
        assert.equal(result.structured?.rpc, undefined);
      }
      assert.equal(rpc.calls(), 0);
    } finally {
      await paywall.close();
      await rpc.close();
    }
  });

  it("wasit_mpp_charge_test with WASIT_RPC_URL names the lock too", async () => {
    const paywall = await target();
    const locked = await countingRpc();
    try {
      const result = await call(cwd, { MPP_PAYER_SECRET: Keypair.random().secret(), WASIT_RPC_URL: locked.url }, "wasit_mpp_charge_test", { target: paywall.url });
      assert.ok(result.text.includes(`RPC: ${locked.origin}, fixed when this server started (WASIT_RPC_URL)`), result.text);
      assert.equal(result.structured?.rpc?.source, "start-up");
      assert.equal(paywall.paid(), 0);
    } finally {
      await paywall.close();
      await locked.close();
    }
  });
});
