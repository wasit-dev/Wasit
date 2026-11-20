/**
 * The "no allow path" property test of spec B11 and B12, in core: for random
 * combinations of the options a caller can give, a payment on `stellar:pubnet`
 * is refused before any request, and the signer is never called.
 *
 * The chain under test stands in for Stellar's adapter and makes every gate
 * that is not Wasit's own permissive: it takes any key, its RPC answers the
 * mainnet passphrase, its scheme signs whatever it is asked and records it, and
 * the paywall settles every paid request. So the only thing between a caller
 * and a mainnet signature is the guard. A control run on stellar:testnet with
 * the same chain shows that the recorder does see a signature when one is made.
 *
 * Seeded, so a failure is reproducible: the seed is in the message.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Keypair, Networks } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";

import { checkStatus } from "../../src/check.js";
import { RunBudget } from "../../src/guard/budget.js";
import { PaymentNetworkRefusedError } from "../../src/guard/networks.js";
import { setRpcIdentityTransportForTesting } from "../../src/guard/rpc-identity.js";
import { setPaymentChainsForTesting } from "../../src/x402/chains/index.js";
import type { PaymentChain } from "../../src/x402/chains/types.js";
import type { EndpointPlan } from "../../src/x402/plan.js";
import { planX402Run } from "../../src/x402/plan.js";
import { runX402PaymentChecks } from "../../src/x402/simulator.js";
import { paywall, type Paywall } from "../support/recording-chain.js";

const PUBNET = "stellar:pubnet";
const TESTNET = "stellar:testnet";
/** Stellar mainnet USDC (Circle), as the MCP tests use it. */
const PUBNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
/** Stellar testnet USDC, the asset of guard/budget.ts. */
const TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAY_TO = Keypair.random().publicKey();
const PAYER = Keypair.random().publicKey();
const PASSPHRASES: Record<string, string> = { [PUBNET]: Networks.PUBLIC, [TESTNET]: Networks.TESTNET };

/** mulberry32: small, seeded, good enough to pick test cases. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const signed: PaymentRequirements[] = [];

/** Stellar's two networks, every gate but Wasit's own open. */
function permissiveStellar(): PaymentChain {
  const asset = (network: string): string => (network === PUBNET ? PUBNET_USDC : TESTNET_USDC);
  return {
    name: "Recording Stellar",
    networks: [TESTNET, PUBNET],
    payerKeyEnv: "STELLAR_PRIVATE_KEY",
    referenceKind: "a test reference",
    resolveRpcUrl: (network, override) => override || `http://127.0.0.1:9/${network}`,
    registerPayer(client) {
      for (const network of [TESTNET, PUBNET] as const) {
        client.register(network, {
          scheme: "exact",
          findDefaultAsset: (wanted, on) => (on === network && wanted === asset(network) ? { asset: wanted, decimals: 7, symbol: "USDC" } : undefined),
          async createPaymentPayload(version, requirements) {
            signed.push(requirements);
            return { x402Version: version, payload: { signature: `sig-${signed.length}` } };
          },
        });
      }
    },
    expiredSigning: async () => ({ terms: { maxTimeoutSeconds: 1 }, holdMs: 0 }),
    payerAddress: () => PAYER,
    generatePayerKey: () => Keypair.random().secret(),
    payerBalance: async () => 10n ** 30n,
    isSettlementReference: (reference) => reference.startsWith("tx-"),
    verifySettlement: async () => ({ pass: true, detail: "settled (recording chain)" }),
    corruptPayload: (payload) => ({ ...payload, signature: "corrupted" }),
  };
}

function challengeOption(network: string, amount: bigint): PaymentRequirements {
  return {
    scheme: "exact",
    network: network as PaymentRequirements["network"],
    amount: amount.toString(),
    asset: network === PUBNET ? PUBNET_USDC : TESTNET_USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)]!;
}

/** A plan entry as a caller could hand one in, planned for pubnet: core must not take it as permission. */
function forgedPlan(name: string, amount: bigint): EndpointPlan {
  return {
    name,
    status: "planned",
    option: { scheme: "exact", network: PUBNET, payTo: PAY_TO, asset: PUBNET_USDC, amount, maxTimeoutSeconds: 60 },
    signatures: ["X402-06", "X402-07", "X402-09", "X402-10", "X402-11"].map((check) => ({ check, amount })),
    worstCase: amount * 5n,
    worstCaseUsd: 0n,
  };
}

let wall: Paywall | undefined;

beforeEach(() => {
  signed.length = 0;
  setPaymentChainsForTesting([permissiveStellar()]);
  setRpcIdentityTransportForTesting(async (url, method) => {
    if (method !== "getNetwork") return undefined;
    const network = new URL(url).pathname.slice(1);
    return { passphrase: PASSPHRASES[network] ?? Networks.PUBLIC };
  });
});

afterEach(async () => {
  setPaymentChainsForTesting(undefined);
  setRpcIdentityTransportForTesting(undefined);
  await wall?.close();
  wall = undefined;
});

describe("no allow path for stellar:pubnet (B11, B12), in core", () => {
  it("control: the same chain on stellar:testnet signs, so the recorder sees a signature when one is made", async () => {
    wall = await paywall([challengeOption(TESTNET, 100_000n)]);
    await runX402PaymentChecks({ target: wall.url, network: TESTNET, payerSecretKey: Keypair.random().secret() });
    assert.ok(signed.length > 0, "the control signed nothing: the test below would prove nothing");
    assert.ok(wall.paid > 0, "the control sent no payment");
  });

  it("refuses every random combination of options: no signature, no paid request, no payment check passes", async () => {
    const seed = Number(process.env.WASIT_PROPERTY_SEED ?? Date.now() % 2 ** 31);
    const next = random(seed);
    for (let round = 0; round < 60; round += 1) {
      const amount = BigInt(1 + Math.floor(next() * 10_000_000));
      const accepts = pick(next, [
        [challengeOption(PUBNET, amount)],
        [challengeOption(PUBNET, amount), challengeOption(TESTNET, amount)],
        [challengeOption(TESTNET, amount), challengeOption(PUBNET, amount)],
      ]);
      wall = await paywall(accepts);
      let challenges = 0;
      wall.onChallenge = () => {
        challenges += 1;
      };
      const method = pick(next, ["GET", "POST"] as const);
      const options = {
        target: wall.url,
        network: PUBNET,
        payerSecretKey: pick(next, [Keypair.random().secret(), "SNOTAKEY", "x"]),
        ...(next() < 0.5 ? { rpcUrl: pick(next, [`http://127.0.0.1:9/${PUBNET}`, `http://127.0.0.1:9/${TESTNET}`, "https://rpc.example.test/key"]) } : {}),
        ...(next() < 0.5 ? { budget: new RunBudget({ maxRunUsd: pick(next, [0.01, 1, 5]) }) } : {}),
        ...(next() < 0.5 ? { pin: { payTo: PAY_TO, asset: PUBNET_USDC } } : {}),
        ...(next() < 0.5 ? { plan: forgedPlan("paid", amount) } : {}),
        ...(next() < 0.5 ? { reject: { headers: { "x-wasit-invalid": "1" } } } : {}),
        method,
        ...(method === "POST" ? { body: "{}" } : {}),
      };
      const results = await runX402PaymentChecks(options);
      const { budget: _budget, plan: _plan, payerSecretKey: _key, ...shown } = options as typeof options & { budget?: unknown; plan?: unknown };
      const label = `seed ${seed}, round ${round}: ${JSON.stringify({ ...shown, budget: "budget" in options, plan: "plan" in options })}`;
      assert.equal(signed.length, 0, `${label}: signed ${signed.length}`);
      assert.equal(wall.paid, 0, `${label}: a paid request reached the paywall`);
      assert.equal(challenges, 0, `${label}: the target was asked for its challenge before the refusal`);
      assert.ok(!results.some((result) => result.id !== "PREFLIGHT" && checkStatus(result) === "PASS"), `${label}: a payment check passed`);
      const preflight = results.find((result) => result.id === "PREFLIGHT");
      assert.ok(preflight !== undefined && checkStatus(preflight) === "ERROR", `${label}: no PREFLIGHT error`);
      assert.match(preflight.detail, /stellar:pubnet is Stellar mainnet/, label);
      await wall.close();
      wall = undefined;
    }
  });

  it("refuses the plan of a pubnet run before any request, whatever its endpoints", async () => {
    const seed = Number(process.env.WASIT_PROPERTY_SEED ?? Date.now() % 2 ** 31);
    const next = random(seed);
    for (let round = 0; round < 20; round += 1) {
      wall = await paywall([challengeOption(PUBNET, BigInt(1 + Math.floor(next() * 10_000_000)))]);
      let challenges = 0;
      wall.onChallenge = () => {
        challenges += 1;
      };
      const count = 1 + Math.floor(next() * 4);
      const endpoints = Array.from({ length: count }, (_, index) => ({
        name: `e${index}`,
        target: wall!.url,
        ...(next() < 0.5 ? { reject: { headers: { "x-wasit-invalid": "1" } } } : {}),
      }));
      await assert.rejects(
        planX402Run({
          network: PUBNET,
          ...(next() < 0.5 ? { pin: { payTo: PAY_TO, asset: PUBNET_USDC } } : {}),
          ...(next() < 0.5 ? { maxRunUsd: pick(next, [0.5, 1, 5]) } : {}),
          endpoints,
        }),
        PaymentNetworkRefusedError,
        `seed ${seed}, round ${round}`,
      );
      assert.equal(signed.length, 0);
      assert.equal(wall.paid, 0);
      assert.equal(challenges, 0, `seed ${seed}, round ${round}: a request was sent before the refusal`);
      await wall.close();
      wall = undefined;
    }
  });
});
