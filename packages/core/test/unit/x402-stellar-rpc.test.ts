/**
 * The RPC a Stellar x402 payment is built through (spec B17.3), written before
 * the code (B11). The x402 Stellar client builds and simulates the payment
 * through the run's RPC, the one whose network Wasit checked and reads the
 * settlement from; it accepts only an https RPC, so an http one is refused
 * before the RPC is asked anything or the target is sent anything.
 *
 * Offline: the RPC identity check answers through its test seam, and the
 * target is a loopback server that counts requests. The payer is a fresh
 * random key that holds nothing.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";

import { Keypair, Networks } from "@stellar/stellar-sdk";

import { RpcIdentityError, setRpcIdentityTransportForTesting } from "../../src/guard/rpc-identity.js";
import { assertX402PaymentRpc, runX402PaymentChecks } from "../../src/x402/simulator.js";

let asked: string[] = [];
const servers: http.Server[] = [];

function identity(answer: Record<string, string>): void {
  asked = [];
  setRpcIdentityTransportForTesting(async (url, method) => {
    asked.push(`${method} ${url}`);
    return method === "getNetwork" ? { passphrase: answer["stellar"] } : answer["evm"];
  });
}

afterEach(async () => {
  setRpcIdentityTransportForTesting(undefined);
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function countingTarget(): Promise<{ readonly url: string; readonly requests: () => number }> {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(500);
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/paid`, requests: () => requests };
}

describe("the RPC a Stellar x402 payment is built through", () => {
  it("refuses an http RPC in the preflight: the RPC is not asked, the target is sent nothing", async () => {
    identity({ stellar: Networks.TESTNET });
    const target = await countingTarget();
    const results = await runX402PaymentChecks({
      target: target.url,
      network: "stellar:testnet",
      payerSecretKey: Keypair.random().secret(),
      rpcUrl: "http://127.0.0.1:9/soroban/rpc",
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, "PREFLIGHT");
    assert.equal(results[0]?.error?.kind, "configuration", results[0]?.detail);
    assert.match(results[0]?.detail ?? "", /https/);
    assert.match(results[0]?.detail ?? "", /nothing was signed/i);
    assert.deepEqual(asked, []);
    assert.equal(target.requests(), 0);
  });

  it("goes on to the identity check with an https RPC", async () => {
    identity({ stellar: Networks.TESTNET });
    await assertX402PaymentRpc("stellar:testnet", "https://rpc.example.invalid/soroban");
    assert.deepEqual(asked, ["getNetwork https://rpc.example.invalid/soroban"]);
  });

  it("still refuses an https RPC of another network", async () => {
    identity({ stellar: Networks.PUBLIC });
    await assert.rejects(assertX402PaymentRpc("stellar:testnet", "https://rpc.example.invalid/soroban"), RpcIdentityError);
  });

  it("does not echo the RPC's address, which may carry a key", async () => {
    identity({ stellar: Networks.TESTNET });
    await assert.rejects(assertX402PaymentRpc("stellar:testnet", "http://user:pass-1234@127.0.0.1:9/rpc?apikey=key-5678"), (error) => {
      assert.ok(error instanceof RpcIdentityError);
      assert.doesNotMatch(error.message, /pass-1234|key-5678/);
      return true;
    });
  });

  it("leaves EVM as it is: an http RPC there reaches the identity check", async () => {
    identity({ evm: "0x14a34" });
    await assertX402PaymentRpc("eip155:84532", "http://127.0.0.1:9/");
    assert.deepEqual(asked, ["eth_chainId http://127.0.0.1:9/"]);
  });
});
