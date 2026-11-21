/**
 * L0, the network guard: a payment is made on a test network or not at all.
 *
 * Before this guard, MPP charge paid on `stellar:pubnet` whenever the caller
 * named it and passed an RPC endpoint, from a CLI flag, an MCP tool argument
 * or `MPP_STELLAR_NETWORK`, and nothing capped what it paid. x402 stopped
 * only because the Stellar SDK refuses pubnet without an RPC endpoint of its
 * own, which Wasit happens not to pass. The guard lives in core, inside every
 * entry point that can sign, so no front end can reach a signature around it.
 *
 * Every test here asserts the refusal AND that nothing left the process: the
 * target counts each request, the RPC stand-in counts each connection. All
 * keys are generated per run and hold nothing. Nothing leaves 127.0.0.1.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";
import { charge as chargeClient } from "@stellar/mpp/charge/client";

import { SigningGate } from "../../src/guard/signed-terms.js";
import { classifyCheckError } from "../../src/errors.js";
import {
  NETWORK_CLASSES,
  PaymentNetworkRefusedError,
  assertPaymentNetworkAllowed,
  networkClass,
} from "../../src/guard/networks.js";
import { payCharge, runMppChargeChecks } from "../../src/mpp/charge.js";
import { runMppChargeSuite } from "../../src/mpp/charge-suite.js";
import {
  runMppChannelCloseCheck,
  runMppChannelCommitmentReplayCheck,
  runMppChannelOrderingCheck,
  runMppChannelReplayCheck,
} from "../../src/mpp/channel.js";
import { runMppChannelSuite } from "../../src/mpp/suite.js";
import { paymentNetworks } from "../../src/x402/chains/index.js";
import { stellarChain } from "../../src/x402/chains/stellar.js";
import { runX402PaymentChecks } from "../../src/x402/simulator.js";

const TEST_NETWORKS = [
  "stellar:testnet",
  "eip155:84532",
  "eip155:11155111",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
];

const REFUSED = /Nothing was sent and nothing was signed/;
const NO_OPT_IN = /the mainnet opt-in is not part of this version/;
const MPP_TEST_ONLY = /MPP stays on test networks/;

/** Any HTTP target, counting every request that reaches it. */
async function countingTarget() {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(402).end();
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

/** Runs `body` against a fresh target and RPC, then asserts neither was reached. */
async function nothingSent(
  body: (target: string, rpcUrl: string) => Promise<void>,
): Promise<void> {
  const target = await countingTarget();
  const rpc = await countingRpc();
  try {
    await body(target.url, rpc.url);
    assert.equal(target.requests(), 0, "a request reached the target");
    assert.equal(rpc.calls(), 0, "a connection reached the RPC endpoint");
  } finally {
    await target.close();
    await rpc.close();
  }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  assert.fail("expected a refusal");
}

describe("network classification", () => {
  it("classifies every network an adapter can pay on", () => {
    for (const network of paymentNetworks()) {
      assert.notEqual(networkClass(network), "unknown", network);
    }
  });

  it("names the four test networks Wasit pays on, and nothing else, as test", () => {
    const tests = [...NETWORK_CLASSES].filter(([, kind]) => kind === "test").map(([network]) => network);
    assert.deepEqual(tests.sort(), [...TEST_NETWORKS].sort());
  });

  it("has stellar:pubnet as its only mainnet", () => {
    const mainnets = [...NETWORK_CLASSES].filter(([, kind]) => kind === "mainnet-optin").map(([network]) => network);
    assert.deepEqual(mainnets, ["stellar:pubnet"]);
  });

  it("calls every other id unknown, including other mainnets and object keys", () => {
    for (const network of [
      "eip155:8453", // Base
      "eip155:1",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", // Solana mainnet
      "stellar:futurenet",
      "Stellar:testnet",
      " stellar:testnet",
      "",
      "constructor",
      "__proto__",
      "toString",
    ]) {
      assert.equal(networkClass(network), "unknown", JSON.stringify(network));
    }
  });
});

describe("assertPaymentNetworkAllowed", () => {
  it("allows the test networks for x402, and stellar:testnet for MPP", () => {
    for (const network of TEST_NETWORKS) assert.doesNotThrow(() => assertPaymentNetworkAllowed("x402", network));
    assert.doesNotThrow(() => assertPaymentNetworkAllowed("mpp-charge", "stellar:testnet"));
    assert.doesNotThrow(() => assertPaymentNetworkAllowed("mpp-channel", "stellar:testnet"));
  });

  it("refuses stellar:pubnet for every protocol, as the run's configuration", () => {
    for (const protocol of ["x402", "mpp-charge", "mpp-channel"] as const) {
      const error = (() => {
        try {
          assertPaymentNetworkAllowed(protocol, "stellar:pubnet");
        } catch (caught) {
          return caught as Error;
        }
        return assert.fail(`${protocol} allowed stellar:pubnet`);
      })();
      assert.ok(error instanceof PaymentNetworkRefusedError, protocol);
      assert.equal(classifyCheckError(error).kind, "configuration", protocol);
      assert.match(error.message, REFUSED, protocol);
      assert.match(error.message, protocol === "x402" ? NO_OPT_IN : MPP_TEST_ONLY, protocol);
    }
  });

  it("refuses an unknown network, and anything that is not a string", () => {
    for (const network of ["eip155:8453", "stellar:futurenet", "", undefined, null, 1, {}]) {
      assert.throws(
        () => assertPaymentNetworkAllowed("x402", network as string),
        (error: unknown) => error instanceof PaymentNetworkRefusedError && REFUSED.test(error.message),
        String(network),
      );
    }
  });
});

describe("MPP charge on stellar:pubnet with an RPC endpoint", () => {
  it("runMppChargeChecks refuses before any request or RPC call", async () => {
    await nothingSent(async (target, rpcUrl) => {
      const error = await rejection(
        runMppChargeChecks({ target, network: "stellar:pubnet", payerSecretKey: Keypair.random().secret(), rpcUrl }),
      );
      assert.ok(error instanceof PaymentNetworkRefusedError, error.message);
      assert.match(error.message, MPP_TEST_ONLY);
    });
  });

  // The shape the CLI's `wasit mpp-charge`, the MCP tool `wasit_mpp_charge_test`
  // and the dashboard pass: through the suite, which reports instead of throwing.
  it("runMppChargeSuite reports MPP-01 as a configuration error and sends nothing", async () => {
    await nothingSent(async (target, rpcUrl) => {
      const results = await runMppChargeSuite({
        target,
        network: "stellar:pubnet",
        payerSecretKey: Keypair.random().secret(),
        rpcUrl,
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.id, "MPP-01");
      assert.equal(results[0]?.error?.kind, "configuration");
      assert.match(results[0]?.detail ?? "", MPP_TEST_ONLY);
    });
  });

  it("refuses even without a usable key, so the refusal does not depend on the key", async () => {
    await nothingSent(async (target, rpcUrl) => {
      const error = await rejection(runMppChargeChecks({ target, network: "stellar:pubnet", payerSecretKey: "", rpcUrl }));
      assert.ok(error instanceof PaymentNetworkRefusedError, error.message);
    });
  });

  it("payCharge, the signing call itself, refuses pubnet and never signs", async () => {
    await nothingSent(async (target) => {
      let signed = 0;
      const sdk = chargeClient({ secretKey: Keypair.random().secret() });
      const method = {
        ...sdk,
        createCredential: async () => {
          signed += 1;
          return "wasit-unit-test-credential";
        },
      } as typeof sdk;
      const error = await rejection(payCharge(target, "stellar:pubnet", method));
      assert.ok(error instanceof PaymentNetworkRefusedError, error.message);
      assert.equal(signed, 0);
    });
  });
});

describe("MPP channel on stellar:pubnet with an RPC endpoint", () => {
  const commitmentSecretHex = randomBytes(32).toString("hex");

  it("runMppChannelSuite stops at preflight and sends nothing", async () => {
    await nothingSent(async (target, rpcUrl) => {
      const seen: string[] = [];
      const results = await runMppChannelSuite({
        target,
        commitmentSecretHex,
        network: "stellar:pubnet",
        rpcUrl,
        allowDestructive: true,
        destructiveChannel: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        onResult: (result) => seen.push(result.id),
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.id, "PREFLIGHT");
      assert.equal(results[0]?.error?.kind, "configuration");
      assert.match(results[0]?.detail ?? "", MPP_TEST_ONLY);
      assert.deepEqual(seen, ["PREFLIGHT"]);
    });
  });

  for (const [id, run] of [
    ["MPP-11", runMppChannelOrderingCheck],
    ["MPP-12", runMppChannelReplayCheck],
    ["MPP-14", runMppChannelCommitmentReplayCheck],
  ] as const) {
    it(`${id}, called on its own, refuses and sends nothing`, async () => {
      await nothingSent(async (target, rpcUrl) => {
        const results = await run({ target, commitmentSecretHex, network: "stellar:pubnet", rpcUrl });
        assert.equal(results.length, 1);
        assert.equal(results[0]?.id, id);
        assert.equal(results[0]?.error?.kind, "configuration");
        assert.match(results[0]?.detail ?? "", MPP_TEST_ONLY);
      });
    });
  }

  it("MPP-13, called on its own with destructive checks enabled, refuses and closes nothing", async () => {
    await nothingSent(async (target, rpcUrl) => {
      const results = await runMppChannelCloseCheck({
        target,
        commitmentSecretHex,
        network: "stellar:pubnet",
        rpcUrl,
        allowDestructive: true,
        expectedChannel: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.id, "MPP-13");
      assert.equal(results[0]?.error?.kind, "configuration");
    });
  });
});

describe("x402 payment checks on stellar:pubnet with an RPC endpoint", () => {
  // With an endpoint, 0.7.0 went on to read the challenge and left the refusal
  // to the SDK. The guard stops the run before the target is even asked.
  it("stops at preflight, before the target is asked for a challenge", async () => {
    await nothingSent(async (target, rpcUrl) => {
      const results = await runX402PaymentChecks({
        target,
        network: "stellar:pubnet",
        payerSecretKey: Keypair.random().secret(),
        rpcUrl,
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.id, "PREFLIGHT");
      assert.equal(results[0]?.error?.kind, "configuration");
      assert.match(results[0]?.detail ?? "", NO_OPT_IN);
    });
  });
});

describe("the Stellar x402 payer (B-A01)", () => {
  // The second barrier on pubnet: the SDK's client scheme refuses pubnet
  // without an RPC endpoint of its own. Wasit must not hand it one until the
  // mainnet opt-in exists; the run's endpoint serves Wasit's own reads only.
  it("builds the SDK scheme for pubnet without an RPC endpoint, whatever the run passes", () => {
    const registered: unknown[] = [];
    const client = { register: (_network: string, scheme: unknown) => registered.push(scheme) };
    stellarChain.registerPayer(client as never, "stellar:pubnet", Keypair.random().secret(), "https://rpc.example.invalid", new SigningGate());
    assert.equal(registered.length, 1);
    assert.equal((registered[0] as { rpcConfig?: unknown }).rpcConfig, undefined);
  });

  it("builds the SDK scheme for testnet through the run's RPC, the one whose network was checked", () => {
    const registered: unknown[] = [];
    const client = { register: (_network: string, scheme: unknown) => registered.push(scheme) };
    stellarChain.registerPayer(client as never, "stellar:testnet", Keypair.random().secret(), "https://rpc.example.invalid", new SigningGate());
    assert.deepEqual((registered[0] as { rpcConfig?: unknown }).rpcConfig, { url: "https://rpc.example.invalid" });
  });
});
