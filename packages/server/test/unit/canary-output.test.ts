/**
 * The canary test (spec B6) for the MCP server (review R7): a fresh random
 * Stellar key, which holds nothing, in every key variable at once, and an RPC
 * url that carries a made-up API key in its path and its query. The tools are
 * then called on the paths where a key or a url is most likely to be echoed:
 * an RPC that drops every connection, an RPC that answers another network, the
 * lock refusing an `rpcUrl` argument, an agent's own `rpcUrl`, and
 * `stellar:pubnet`. Every tool result and everything the server wrote to
 * stderr is searched for the key, its raw seed in hex and in base64, and the
 * RPC key. Any hit fails.
 *
 * Offline: the target and the RPCs are on 127.0.0.1. Nothing is signed: every
 * call stops at the preflight, or is refused before it.
 */

import assert from "node:assert/strict";
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

const CANARY = Keypair.random();
const KEY = CANARY.secret();
const SEED = CANARY.rawSecretKey();
const RPC_KEY = `rpckey${Math.random().toString(36).slice(2)}canary`;
const NEEDLES = [KEY, SEED.toString("hex"), SEED.toString("base64"), SEED.toString("base64url"), RPC_KEY];

/** Every key variable the server reads holds the canary, in the form it expects. */
const KEYS = {
  STELLAR_PRIVATE_KEY: KEY,
  MPP_PAYER_SECRET: KEY,
  COMMITMENT_SECRET_HEX: SEED.toString("hex"),
  EVM_PRIVATE_KEY: `0x${SEED.toString("hex")}`,
  SVM_PRIVATE_KEY: KEY,
};

function assertClean(label: string, text: string): void {
  for (const needle of NEEDLES) assert.ok(!text.includes(needle), `${label} carries a key value`);
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

describe("canary: no key and no RPC key in any MCP tool result or on the server's stderr", () => {
  let cwd: string;
  const drop = net.createServer((socket) => socket.destroy());
  const otherNetwork = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { passphrase: "Some Other Network ; 2026", protocolVersion: 23 } }));
  });
  const target = http.createServer((_request, response) => {
    const body = {
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
    };
    response.writeHead(402, { "payment-required": Buffer.from(JSON.stringify(body)).toString("base64") });
    response.end("{}");
  });
  let ports: { drop: number; other: number; target: number };
  const scanned: string[] = [];

  before(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "wasit-mcp-canary-"));
    ports = { drop: await listen(drop), other: await listen(otherNetwork), target: await listen(target) };
  });
  after(async () => {
    drop.close();
    otherNetwork.closeAllConnections();
    otherNetwork.close();
    target.closeAllConnections();
    target.close();
    await rm(cwd, { recursive: true, force: true });
  });

  /** One server, started with `env`, called with each of `calls`; its results and stderr are kept for the scan. */
  async function session(env: Record<string, string>, calls: Array<[string, Record<string, unknown>]>): Promise<void> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      cwd,
      env: { PATH: process.env["PATH"] ?? "", HOME: cwd, ...env },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    const client = new Client({ name: "wasit-mcp-canary", version: "0.0.0" });
    await client.connect(transport);
    try {
      for (const [name, args] of calls) {
        try {
          scanned.push(JSON.stringify(await client.callTool({ name, arguments: args })));
        } catch (error) {
          scanned.push(String(error instanceof Error ? error.message : error));
        }
      }
    } finally {
      await client.close();
    }
    scanned.push(stderr);
  }

  const paid = () => `http://127.0.0.1:${ports.target}/paid`;
  const lockAt = (port: number) => `http://127.0.0.1:${port}/v1/${RPC_KEY}?apikey=${RPC_KEY}`;

  it("with the RPC locked at start-up to an RPC that drops every connection", async () => {
    await session({ ...KEYS, WASIT_RPC_URL: lockAt(ports.drop) }, [
      ["wasit_x402_test", { target: paid() }],
      ["wasit_mpp_charge_test", { target: paid() }],
      ["wasit_mpp_channel_test", { target: paid() }],
      ["wasit_x402_test", { target: paid(), rpcUrl: `http://127.0.0.1:${ports.other}/${RPC_KEY}` }],
    ]);
  });

  it("with the RPC locked at start-up to an RPC of another network", async () => {
    await session({ ...KEYS, WASIT_RPC_URL: lockAt(ports.other) }, [
      ["wasit_x402_test", { target: paid() }],
      ["wasit_x402_test", { target: paid(), network: "eip155:84532" }],
      ["wasit_mpp_charge_test", { target: paid() }],
    ]);
  });

  it("without a lock: the agent's own rpcUrl, and stellar:pubnet", async () => {
    await session({ ...KEYS }, [
      ["wasit_x402_test", { target: paid(), rpcUrl: `http://127.0.0.1:${ports.drop}/v1/${RPC_KEY}?k=${RPC_KEY}` }],
      ["wasit_x402_test", { target: paid(), network: "stellar:pubnet", rpcUrl: `http://127.0.0.1:${ports.other}/${RPC_KEY}` }],
    ]);
  });

  it("a server that does not start: a mainnet start-up switch and a lock that is not a url", async () => {
    for (const env of [{ ...KEYS, WASIT_MAINNET_OPT_IN: KEY }, { ...KEYS, WASIT_RPC_URL: `ftp://127.0.0.1/${RPC_KEY}` }]) {
      await session(env, []).catch((error: unknown) => scanned.push(String(error instanceof Error ? error.message : error)));
    }
  });

  it("left no key and no RPC key in any result or on stderr", () => {
    assert.ok(scanned.length >= 12, `too few outputs were searched (${scanned.length})`);
    assert.ok(scanned.some((text) => text.includes("RPC")), "no output named an RPC: the paths were not reached");
    for (const [index, text] of scanned.entries()) assertClean(`output ${index + 1}`, text);
  });
});
