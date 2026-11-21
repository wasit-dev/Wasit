/**
 * How `preparePayment` uses the signed-terms gate (spec B17.2), written before
 * the code (B11): it arms the gate with the terms L2 checked and charged, right
 * before the client builds the payment; it reads the chain's latest unit once
 * per run as the anchor; and it discards, unsent, a payload the adapter cannot
 * bind to what was signed.
 *
 * Offline: the recording chain of `../support/recording-chain.ts`, with a
 * gate whose scheme asks it for one signature per payment, as the Stellar
 * signer does.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { PaymentGuardRefusedError, RunBudget } from "../../src/guard/budget.js";
import type { SigningTerms } from "../../src/guard/signed-terms.js";
import { setRpcIdentityTransportForTesting } from "../../src/guard/rpc-identity.js";
import { setPaymentChainsForTesting } from "../../src/x402/chains/index.js";
import type { PaymentChain } from "../../src/x402/chains/types.js";
import { runX402PaymentChecks } from "../../src/x402/simulator.js";
import type { CheckResult } from "../../src/check.js";
import {
  NETWORK,
  PAYER,
  PAY_TO,
  USDC,
  option,
  paywall,
  recordingChain,
  type Paywall,
  type Recorder,
} from "../support/recording-chain.js";

interface Seen {
  readonly terms: SigningTerms[];
  latestReads: number;
  binds: number;
}

function gatedChain(recorder: Recorder, seen: Seen, bind: () => void = () => undefined): PaymentChain {
  const base = recordingChain(recorder);
  return {
    ...base,
    registerPayer(client, _network, _payerKey, _rpcUrl, gate) {
      client.register(NETWORK, {
        scheme: "exact",
        findDefaultAsset: (asset, network) =>
          network === NETWORK && asset.toLowerCase() === USDC.toLowerCase()
            ? { asset: USDC, decimals: 6, symbol: "USDC" }
            : undefined,
        async createPaymentPayload(version, requirements) {
          // As the Stellar signer does: the key signs only through the gate.
          seen.terms.push(gate.take());
          recorder.signed.push(requirements);
          return { x402Version: version, payload: { signature: `sig-${recorder.signed.length}` } };
        },
      });
    },
    signedTerms: {
      unitSeconds: 5,
      async latestUnit() {
        seen.latestReads += 1;
        return 1000;
      },
      bind() {
        seen.binds += 1;
        bind();
      },
    },
  };
}

let recorder: Recorder;
let seen: Seen;
const walls: Paywall[] = [];

function install(bind?: () => void): void {
  setPaymentChainsForTesting([gatedChain(recorder, seen, bind)]);
  setRpcIdentityTransportForTesting(async (_url, method) => (method === "eth_chainId" ? "0x14a34" : undefined));
}

beforeEach(() => {
  recorder = { signed: [] };
  seen = { terms: [], latestReads: 0, binds: 0 };
});

afterEach(async () => {
  setPaymentChainsForTesting(undefined);
  setRpcIdentityTransportForTesting(undefined);
  await Promise.all(walls.splice(0).map((wall) => wall.close()));
});

async function wall(amount: string): Promise<Paywall> {
  const created = await paywall([option({ amount })]);
  walls.push(created);
  return created;
}

function byId(results: readonly CheckResult[], id: string): CheckResult {
  const found = results.find((result) => result.id === id);
  assert.ok(found, `no ${id} in ${results.map((result) => result.id).join(", ")}`);
  return found;
}

const run = (target: string, budget = new RunBudget()) =>
  runX402PaymentChecks({ target, network: NETWORK, payerSecretKey: "test-payer-key", budget });

describe("preparePayment and the signed-terms gate", () => {
  it("arms the gate with the terms checked and charged, for each signature of the run", async () => {
    install();
    const target = await wall("10000");
    const results = await run(target.url);
    assert.equal(byId(results, "X402-06").pass, true, byId(results, "X402-06").detail);

    assert.deepEqual(
      seen.terms.map((entry) => entry.amount),
      recorder.signed.map((requirement) => requirement.amount),
    );
    assert.deepEqual(
      seen.terms.map((entry) => entry.amount),
      ["10000", "10000", "5000", "10000"],
      "X402-06, X402-07, X402-09 (half), X402-10",
    );
    for (const entry of seen.terms) {
      assert.equal(entry.network, NETWORK);
      assert.equal(entry.payer, PAYER);
      assert.equal(entry.payTo, PAY_TO);
      assert.equal(entry.asset, USDC);
    }
    // 60 s lifetime: 12 ledgers of 5 s and 2 of slack over the anchor, plus the time since it.
    const [first, , , expired] = seen.terms;
    assert.ok(first!.maxExpiration >= 1014 && first!.maxExpiration <= 1016, String(first!.maxExpiration));
    // X402-10 signs with a one-second lifetime.
    assert.ok(expired!.maxExpiration >= 1003 && expired!.maxExpiration <= 1005, String(expired!.maxExpiration));
    assert.equal(seen.binds, 4, "every payload is bound before it is used");
  });

  it("reads the anchor once per run, not once per signature", async () => {
    install();
    const budget = new RunBudget();
    await run((await wall("10000")).url, budget);
    await run((await wall("10000")).url, budget);
    assert.equal(seen.latestReads, 1);
  });

  it("discards, unsent, a payload the adapter cannot bind to what was signed", async () => {
    install(() => {
      throw new PaymentGuardRefusedError("signed-terms", "The payment names another invocation than the one signed.", {
        signed: true,
      });
    });
    const target = await wall("10000");
    const results = await run(target.url);
    const first = byId(results, "X402-06");
    assert.equal(first.error?.kind, "setup", first.detail);
    assert.match(first.detail, /it was not sent/);
    assert.equal(target.paid, 0, "no payload reached the service");
  });

  it("signs nothing when the anchor cannot be read", async () => {
    const chain = gatedChain(recorder, seen);
    setPaymentChainsForTesting([
      {
        ...chain,
        signedTerms: {
          ...chain.signedTerms!,
          async latestUnit() {
            throw new Error("rpc down");
          },
        },
      },
    ]);
    setRpcIdentityTransportForTesting(async (_url, method) => (method === "eth_chainId" ? "0x14a34" : undefined));
    const target = await wall("10000");
    const results = await run(target.url);
    const first = byId(results, "X402-06");
    assert.equal(first.error?.kind, "setup", first.detail);
    assert.match(first.detail, /Nothing was signed\./);
    assert.equal(recorder.signed.length, 0);
    assert.equal(target.paid, 0);
  });
});
