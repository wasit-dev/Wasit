/**
 * MPP-01 signs only for the run's network, through the run's RPC endpoint,
 * and pays once at most, offline.
 *
 * The SDK's charge client signs for whatever network the challenge names and
 * reaches pubnet through its own default endpoint, so a target asking for
 * `stellar:pubnet` would otherwise get a mainnet transfer signed from a key the
 * run meant for testnet. The targets here are the official @stellar/mpp charge
 * server in process, issuing its own challenges; the RPC endpoint is a local
 * stand-in that counts the connections reaching it. Nothing leaves 127.0.0.1.
 */

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";
import { charge as chargeClient } from "@stellar/mpp/charge/client";
import { Mppx, Store, charge } from "@stellar/mpp/charge/server";

import { classifyCheckError } from "../../src/errors.js";
import { payCharge, runMppChargeChecks } from "../../src/mpp/charge.js";
import type { MppNetwork } from "../../src/mpp/network.js";

const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

interface Listening {
  readonly url: string;
  readonly close: () => Promise<void>;
}

async function listen(handler: http.RequestListener): Promise<Listening> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The official charge server's listener for a 0.001 USDC resource on `network`. */
function officialCharge(network: MppNetwork): http.RequestListener {
  const recipient = Keypair.random().publicKey();
  const mppx = Mppx.create({
    secretKey: "wasit-unit-test-challenge-secret",
    methods: [charge({ recipient, currency: USDC_SAC, network, store: Store.memory() })],
  });
  return async (req, res) => {
    const result = await Mppx.toNodeListener(mppx.charge({ amount: "0.001", currency: USDC_SAC, recipient }))(req, res);
    if (result.status !== 402) res.end("paid");
  };
}

/**
 * A charge target answering with `pick(n)`'s official challenge on its n-th
 * request, counting requests and those that carried a credential.
 */
async function chargeTarget(pick: (request: number) => MppNetwork) {
  const listeners = new Map<MppNetwork, http.RequestListener>();
  let requests = 0;
  let credentials = 0;
  const target = await listen((req, res) => {
    requests += 1;
    if (req.headers.authorization) credentials += 1;
    const network = pick(requests);
    if (!listeners.has(network)) listeners.set(network, officialCharge(network));
    return listeners.get(network)!(req, res);
  });
  return { ...target, requests: () => requests, credentials: () => credentials };
}

/**
 * An https RPC address on 127.0.0.1 that counts connections and drops each one.
 *
 * The SDK's client accepts only https, and the test cannot hold a certificate
 * it would trust, so nothing answers: a connection arriving is the evidence
 * that the SDK used this endpoint, and dropping it fails the payment before
 * anything is signed.
 */
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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the run to throw");
}

describe("MPP-01 and the challenge's network", () => {
  for (const [asked, run] of [
    ["stellar:pubnet", "stellar:testnet"],
    ["stellar:testnet", "stellar:pubnet"],
  ] as const) {
    it(`refuses a ${asked} challenge on a ${run} run before anything is signed`, async () => {
      const target = await chargeTarget(() => asked);
      const rpc = await countingRpc();
      try {
        const error = await rejection(
          runMppChargeChecks({ target: target.url, network: run, payerSecretKey: Keypair.random().secret(), rpcUrl: rpc.url }),
        );
        assert.match(String((error as Error).message), new RegExp(`asks to be paid on ${asked}, and this run pays on ${run} only, so nothing was signed`));
        assert.equal(classifyCheckError(error).kind, "configuration");
        // Stopped at the unpaid read: the SDK never asked the target for a
        // challenge to pay, nor the RPC for the payer's account.
        assert.equal(target.requests(), 1);
        assert.equal(target.credentials(), 0);
        assert.equal(rpc.calls(), 0);
      } finally {
        await target.close();
        await rpc.close();
      }
    });
  }

  it("refuses when the challenge it is about to pay switches to another network", async () => {
    // Testnet for the unpaid read, pubnet for the request mppx pays.
    const target = await chargeTarget((request) => (request === 1 ? "stellar:testnet" : "stellar:pubnet"));
    const rpc = await countingRpc();
    try {
      const error = await rejection(
        runMppChargeChecks({
          target: target.url,
          network: "stellar:testnet",
          payerSecretKey: Keypair.random().secret(),
          rpcUrl: rpc.url,
        }),
      );
      assert.match(String((error as Error).message), /asks to be paid on stellar:pubnet, and this run pays on stellar:testnet only/);
      assert.equal(classifyCheckError(error).kind, "configuration");
      assert.equal(target.requests(), 2);
      assert.equal(target.credentials(), 0);
      assert.equal(rpc.calls(), 0);
    } finally {
      await target.close();
      await rpc.close();
    }
  });

  it("builds the payment through the run's RPC endpoint, not the SDK's default", async () => {
    const target = await chargeTarget(() => "stellar:testnet");
    const rpc = await countingRpc();
    try {
      // The stand-in drops the payer's account lookup, so the payment fails
      // before anything is signed; what matters is where the lookup went.
      const error = await rejection(
        runMppChargeChecks({
          target: target.url,
          network: "stellar:testnet",
          payerSecretKey: Keypair.random().secret(),
          rpcUrl: rpc.url,
        }),
      );
      assert.ok(rpc.calls() > 0, `the SDK never reached the run's RPC endpoint: ${(error as Error).message}`);
      assert.equal(target.credentials(), 0);
    } finally {
      await target.close();
      await rpc.close();
    }
  });

  it("refuses an http RPC endpoint, which the SDK cannot pay through, before sending anything", async () => {
    const target = await chargeTarget(() => "stellar:testnet");
    try {
      const error = await rejection(
        runMppChargeChecks({
          target: target.url,
          network: "stellar:testnet",
          payerSecretKey: Keypair.random().secret(),
          rpcUrl: "http://127.0.0.1:1",
        }),
      );
      assert.match(String((error as Error).message), /accepts only an https RPC endpoint, and http:\/\/127\.0\.0\.1:1 is http/);
      assert.equal(classifyCheckError(error).kind, "configuration");
      assert.equal(target.requests(), 0);
    } finally {
      await target.close();
    }
  });
});

describe("payCharge", () => {
  it("pays once when the target answers 402 again after being paid", async () => {
    // A target that ignores every credential, so each paid request is met
    // with a fresh challenge, as a target fishing for more payments would.
    const official = officialCharge("stellar:testnet");
    let credentials = 0;
    const target = await listen((req, res) => {
      if (req.headers.authorization) credentials += 1;
      delete req.headers.authorization;
      return official(req, res);
    });
    let signed = 0;
    const sdk = chargeClient({ secretKey: Keypair.random().secret() });
    const method = {
      ...sdk,
      createCredential: async () => {
        signed += 1;
        return "wasit-unit-test-credential";
      },
    } as typeof sdk;
    try {
      const response = await payCharge(target.url, "stellar:testnet", method);
      assert.equal(response.status, 402);
      assert.equal(signed, 1);
      assert.equal(credentials, 1);
    } finally {
      await target.close();
    }
  });
});
