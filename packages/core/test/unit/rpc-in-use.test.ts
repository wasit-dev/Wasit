/**
 * Which RPC a run reads the chain through, as a result names it (D-023c,
 * option C): its origin only, where it came from (Wasit's default for the
 * network, the `rpcUrl` argument of an MCP tool, or `WASIT_RPC_URL` fixed when
 * the server started), and whether it is Wasit's default. A non-default RPC is
 * flagged, because every settlement read of the run is its word. And the
 * start-up lock itself: `WASIT_RPC_URL`, read once, must be an http(s) URL.
 *
 * No request is made: the defaults are read from the adapters' own tables.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeRpcInUse, readRpcLock, rpcInUse } from "../../src/guard/rpc-in-use.js";
import { stellarChain } from "../../src/x402/chains/stellar.js";
import { setPaymentChainsForTesting } from "../../src/x402/chains/index.js";

const STELLAR_DEFAULT = "https://soroban-testnet.stellar.org";
const SECRET_PATH = "/v1/rpc-key-0f0e0d0c0b0a";

describe("the RPC a run reads the chain through (D-023c)", () => {
  it("is Wasit's default for the network when nothing was given", () => {
    for (const protocol of ["x402", "mpp"] as const) {
      const rpc = rpcInUse(protocol, "stellar:testnet");
      assert.deepEqual(rpc, { origin: STELLAR_DEFAULT, source: "default", isDefault: true }, protocol);
      assert.equal(describeRpcInUse("stellar:testnet", rpc!), `RPC: ${STELLAR_DEFAULT}, Wasit's default for stellar:testnet.`);
    }
    for (const network of ["eip155:84532", "eip155:11155111", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]) {
      const rpc = rpcInUse("x402", network);
      assert.equal(rpc?.source, "default", network);
      assert.equal(rpc?.isDefault, true, network);
      assert.match(rpc!.origin, /^https:\/\//, network);
    }
  });

  it("names a given RPC by its origin only, and flags it when it is not the default", () => {
    const url = `https://rpc.example.test:8443${SECRET_PATH}?apikey=abc123#frag`;
    const rpc = rpcInUse("x402", "stellar:testnet", { url, source: "argument" });
    assert.deepEqual(rpc, { origin: "https://rpc.example.test:8443", source: "argument", isDefault: false });
    const line = describeRpcInUse("stellar:testnet", rpc!);
    assert.equal(
      line,
      "RPC: https://rpc.example.test:8443, from the rpcUrl argument: not Wasit's default for stellar:testnet, " +
        "so every chain read of this run is this RPC's word.",
    );
    for (const part of [SECRET_PATH, "apikey", "abc123", "frag"]) assert.ok(!line.includes(part), part);
  });

  it("says when the RPC was fixed at start-up, and names the variable", () => {
    const rpc = rpcInUse("mpp", "stellar:testnet", { url: `http://127.0.0.1:8000${SECRET_PATH}`, source: "start-up" });
    assert.deepEqual(rpc, { origin: "http://127.0.0.1:8000", source: "start-up", isDefault: false });
    assert.equal(
      describeRpcInUse("stellar:testnet", rpc!),
      "RPC: http://127.0.0.1:8000, fixed when this server started (WASIT_RPC_URL): not Wasit's default for " +
        "stellar:testnet, so every chain read of this run is this RPC's word.",
    );
  });

  it("is not flagged when the given RPC is the default itself", () => {
    const rpc = rpcInUse("x402", "stellar:testnet", { url: `${STELLAR_DEFAULT}/`, source: "argument" });
    assert.deepEqual(rpc, { origin: STELLAR_DEFAULT, source: "argument", isDefault: true });
    assert.equal(describeRpcInUse("stellar:testnet", rpc!), `RPC: ${STELLAR_DEFAULT}, from the rpcUrl argument (Wasit's default for stellar:testnet).`);
  });

  it("is not named on a network that is not a test network: nothing is read there", () => {
    for (const network of ["stellar:pubnet", "eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "nope"]) {
      for (const protocol of ["x402", "mpp"] as const) {
        assert.equal(rpcInUse(protocol, network), undefined, `${protocol} ${network}`);
        assert.equal(rpcInUse(protocol, network, { url: "https://rpc.example.test", source: "argument" }), undefined, `${protocol} ${network}`);
      }
    }
  });

  it("is not named on stellar:pubnet even when an adapter offers a default RPC there", () => {
    setPaymentChainsForTesting([{ ...stellarChain, resolveRpcUrl: (_network, override) => override || "https://mainnet-rpc.example.test" }]);
    try {
      assert.equal(rpcInUse("x402", "stellar:pubnet"), undefined);
      assert.equal(rpcInUse("x402", "stellar:pubnet", { url: "https://rpc.example.test", source: "start-up" }), undefined);
    } finally {
      setPaymentChainsForTesting(undefined);
    }
  });

  it("is not named for MPP on a test network MPP does not pay on", () => {
    assert.equal(rpcInUse("mpp", "eip155:84532"), undefined);
  });
});

describe("the start-up RPC lock, WASIT_RPC_URL (D-023c)", () => {
  it("is off when the variable is unset or blank", () => {
    assert.equal(readRpcLock({}), undefined);
    assert.equal(readRpcLock({ WASIT_RPC_URL: "" }), undefined);
    assert.equal(readRpcLock({ WASIT_RPC_URL: "   " }), undefined);
  });

  it("holds an http or https URL", () => {
    assert.deepEqual(readRpcLock({ WASIT_RPC_URL: `https://rpc.example.test${SECRET_PATH}` }), { url: `https://rpc.example.test${SECRET_PATH}` });
    assert.deepEqual(readRpcLock({ WASIT_RPC_URL: "http://127.0.0.1:8000" }), { url: "http://127.0.0.1:8000" });
  });

  it("refuses anything else, without quoting the value", () => {
    for (const value of ["rpc.example.test/key-123", "ftp://rpc.example.test/key-123", "file:///etc/key-123", "https://"]) {
      const lock = readRpcLock({ WASIT_RPC_URL: value });
      assert.ok(lock !== undefined && "problem" in lock, value);
      assert.match(lock.problem, /^WASIT_RPC_URL /);
      assert.ok(!lock.problem.includes("key-123"), lock.problem);
    }
  });
});
