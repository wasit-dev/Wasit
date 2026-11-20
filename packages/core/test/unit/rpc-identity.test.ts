/**
 * The RPC identity check (D-032, D-023a+b): before a run signs anything or
 * reads a settlement, the RPC it was given must say it serves the run's
 * network. Stellar: `getNetwork`'s passphrase; EVM: `eth_chainId`; Solana: the
 * genesis hash, whose first 32 characters are the CAIP-2 reference. A mismatch,
 * no answer, or an answer that cannot be read refuses the run before any
 * request reaches the target.
 *
 * Why: a run labelled `stellar:testnet` pointed at a mainnet RPC signed a
 * mainnet-valid channel commitment in 0.7.0 (`689bdc0` fixed that case by
 * decoding); a wrong RPC also makes every settlement read come from the wrong
 * chain. Offline: JSON-RPC stand-ins on loopback.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";

import { Keypair, Networks } from "@stellar/stellar-sdk";
import { generatePrivateKey } from "viem/accounts";

import { ConfigurationError, classifyCheckError } from "../../src/errors.js";
import {
  RpcIdentityError,
  assertRpcServesNetwork,
  setRpcIdentityTransportForTesting,
} from "../../src/guard/rpc-identity.js";
import { runMppChargeChecks } from "../../src/mpp/charge.js";
import { runMppChannelSuite } from "../../src/mpp/suite.js";
import { runX402PaymentChecks } from "../../src/x402/simulator.js";

const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

interface Rpc {
  readonly url: string;
  readonly methods: string[];
  readonly close: () => Promise<void>;
}

const open: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  setRpcIdentityTransportForTesting(undefined);
  await Promise.all(open.splice(0).map((server) => server.close()));
});

/** A JSON-RPC stand-in: `answer(method)` gives the result, `undefined` gives a JSON-RPC error. */
async function rpc(answer: (method: string) => unknown, raw?: (response: http.ServerResponse) => boolean): Promise<Rpc> {
  const methods: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (raw?.(response)) return;
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      methods.push(method);
      const result = answer(method);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          result === undefined
            ? { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } }
            : { jsonrpc: "2.0", id, result },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const created = {
    url: `http://127.0.0.1:${port}/v1/secret-api-key-123`,
    methods,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  open.push(created);
  return created;
}

/** A target that only counts requests: the check must stop the run before any reaches it. */
async function countingTarget(): Promise<{ url: string; requests: () => number }> {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(402);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  open.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return { url: `http://127.0.0.1:${port}/paid`, requests: () => requests };
}

async function refused(promise: Promise<unknown>): Promise<RpcIdentityError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RpcIdentityError, `expected an RpcIdentityError, got ${String(error)}`);
    return error;
  }
  return assert.fail("expected the RPC to be refused");
}

describe("assertRpcServesNetwork", () => {
  it("passes a Stellar RPC whose passphrase is the run's network", async () => {
    const node = await rpc((method) => (method === "getNetwork" ? { passphrase: Networks.TESTNET, protocolVersion: 30 } : undefined));
    await assertRpcServesNetwork("stellar:testnet", node.url);
    assert.deepEqual(node.methods, ["getNetwork"]);
  });

  it("refuses a mainnet Stellar RPC on a testnet run, naming both networks and only the RPC's origin", async () => {
    const node = await rpc(() => ({ passphrase: Networks.PUBLIC, protocolVersion: 29 }));
    const error = await refused(assertRpcServesNetwork("stellar:testnet", node.url));
    assert.match(error.message, /stellar:pubnet/);
    assert.match(error.message, /stellar:testnet/);
    assert.match(error.message, /nothing was signed/);
    assert.equal(error.message.includes("secret-api-key-123"), false, "the RPC path can hold an API key");
    assert.ok(error instanceof ConfigurationError);
    assert.equal(classifyCheckError(error).kind, "configuration");
  });

  it("refuses a Stellar RPC that names a passphrase Wasit does not know, without echoing it raw", async () => {
    const node = await rpc(() => ({ passphrase: "Private network\u001b[31m ; 2026" }));
    const error = await refused(assertRpcServesNetwork("stellar:testnet", node.url));
    assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(error.message), false);
  });

  it("passes an EVM RPC whose chain id is the run's, and refuses another chain", async () => {
    const sepolia = await rpc((method) => (method === "eth_chainId" ? "0x14a34" : undefined));
    await assertRpcServesNetwork("eip155:84532", sepolia.url);
    const mainnet = await rpc(() => "0x2105");
    const error = await refused(assertRpcServesNetwork("eip155:84532", mainnet.url));
    assert.match(error.message, /eip155:8453\b/);
  });

  it("passes a Solana RPC whose genesis hash starts with the CAIP-2 reference, and refuses mainnet", async () => {
    const devnet = await rpc((method) => (method === "getGenesisHash" ? DEVNET_GENESIS : undefined));
    await assertRpcServesNetwork(SOLANA_DEVNET, devnet.url);
    const mainnet = await rpc(() => MAINNET_GENESIS);
    await refused(assertRpcServesNetwork(SOLANA_DEVNET, mainnet.url));
  });

  it("refuses when the RPC does not answer the method, answers garbage, or answers an error status", async () => {
    const missing = await rpc(() => undefined);
    const garbage = await rpc(() => undefined, (response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not json");
      return true;
    });
    const status = await rpc(() => undefined, (response) => {
      response.writeHead(503);
      response.end();
      return true;
    });
    const wrongShape = await rpc(() => ({ passphrase: 42 }));
    for (const node of [missing, garbage, status, wrongShape]) {
      const error = await refused(assertRpcServesNetwork("stellar:testnet", node.url));
      assert.match(error.message, /could not confirm|did not say/);
    }
  });

  it("refuses an RPC that cannot be reached", async () => {
    await refused(assertRpcServesNetwork("stellar:testnet", "http://127.0.0.1:1"));
  });

  it("does not follow a redirect from the RPC", async () => {
    let elsewhere = 0;
    const other = http.createServer((_request, response) => {
      elsewhere += 1;
      response.end("{}");
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    open.push({ close: () => new Promise<void>((resolve) => { other.closeAllConnections(); other.close(() => resolve()); }) });
    const { port } = other.address() as { port: number };
    const node = await rpc(() => undefined, (response) => {
      response.writeHead(307, { location: `http://127.0.0.1:${port}/` });
      response.end();
      return true;
    });
    await refused(assertRpcServesNetwork("stellar:testnet", node.url));
    assert.equal(elsewhere, 0);
  });

  it("refuses a network it has no identity rule for: fail closed", async () => {
    const node = await rpc(() => "0x1");
    await refused(assertRpcServesNetwork("cosmos:cosmoshub-4", node.url));
    assert.equal(node.methods.length, 0);
  });
});

describe("the entry points check the RPC before any request to the target", () => {
  it("x402: a wrong EVM chain id is a PREFLIGHT error, and the target sees nothing", async () => {
    const target = await countingTarget();
    const node = await rpc(() => "0x1");
    const results = await runX402PaymentChecks({
      target: target.url,
      network: "eip155:84532",
      payerSecretKey: generatePrivateKey(),
      rpcUrl: node.url,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, "PREFLIGHT");
    assert.equal(results[0]?.error?.kind, "configuration");
    assert.match(results[0]?.detail ?? "", /eip155:1\b/);
    assert.equal(target.requests(), 0);
  });

  it("MPP charge: an RPC that serves mainnet refuses the run before the challenge is read", async () => {
    const target = await countingTarget();
    const asked: string[] = [];
    setRpcIdentityTransportForTesting(async (url, method) => {
      asked.push(`${new URL(url).host} ${method}`);
      return { passphrase: Networks.PUBLIC };
    });
    const error = await refused(
      runMppChargeChecks({
        target: target.url,
        network: "stellar:testnet",
        payerSecretKey: Keypair.random().secret(),
        rpcUrl: "https://rpc.example.test",
      }),
    );
    assert.match(error.message, /stellar:pubnet/);
    assert.deepEqual(asked, ["rpc.example.test getNetwork"]);
    assert.equal(target.requests(), 0);
  });

  it("MPP channel: an RPC that serves mainnet is a PREFLIGHT error, and the target sees nothing", async () => {
    const target = await countingTarget();
    setRpcIdentityTransportForTesting(async () => ({ passphrase: Networks.PUBLIC }));
    const results = await runMppChannelSuite({
      target: target.url,
      commitmentSecretHex: "11".repeat(32),
      network: "stellar:testnet",
      rpcUrl: "https://rpc.example.test",
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, "PREFLIGHT");
    assert.equal(results[0]?.error?.kind, "configuration");
    assert.equal(target.requests(), 0);
  });
});
