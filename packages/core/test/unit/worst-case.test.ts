/**
 * The worst-case property test of spec B11: random endpoint sets and prices,
 * run against a recording signer and a paywall that settles everything signed.
 * Whatever the terms, and whatever the paywalls change after the plan:
 *
 * - the dollars signed never exceed the run's cap;
 * - they never exceed the worst case the plan computed before anything was
 *   signed;
 * - nothing is signed for a payee the plan did not see, or above what the plan
 *   allowed for that check;
 * - a plan refused for its worst case is refused before any signature.
 *
 * Seeded, so a failure is reproducible: the seed is in the message.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { PER_RUN_CAP_USD, RunBudget, formatUsd, usdFromDollars } from "../../src/guard/budget.js";
import { planX402Run } from "../../src/x402/plan.js";
import { runX402PaymentChecks } from "../../src/x402/simulator.js";
import {
  NETWORK,
  installRecordingChain,
  option,
  paywall,
  type Paywall,
  type Recorder,
} from "../support/recording-chain.js";

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

/** 6 decimals: one base unit is a millionth of a dollar. */
const usdOf = (baseUnits: bigint): bigint => usdFromDollars(1) * baseUnits / 1_000_000n;

function payee(index: number): string {
  return `0x${(0xa0 + index).toString(16).padStart(2, "0").repeat(20)}`;
}

let recorder: Recorder;
let undo: (() => void) | undefined;
const walls: Paywall[] = [];

beforeEach(() => {
  recorder = { signed: [] };
  undo = installRecordingChain(recorder);
});

afterEach(async () => {
  undo?.();
  undo = undefined;
  await Promise.all(walls.splice(0).map((wall) => wall.close()));
});

const CASES = 40;

describe("worst case (B11)", () => {
  it(`holds for ${CASES} random runs`, { timeout: 120_000 }, async () => {
    for (let seed = 1; seed <= CASES; seed += 1) {
      const next = random(seed);
      recorder.signed.length = 0;
      await Promise.all(walls.splice(0).map((wall) => wall.close()));

      const count = 1 + Math.floor(next() * 3);
      const caps = [undefined, 0.25, 1, 2.5, 5];
      const maxRunUsd = caps[Math.floor(next() * caps.length)];
      const endpoints = [];
      for (let index = 0; index < count; index += 1) {
        // From 1 base unit to $1.50: some above the $1 cap.
        const amount = BigInt(1 + Math.floor(next() * 1_500_000));
        const created = await paywall([option({ amount: amount.toString(), payTo: payee(index) })]);
        walls.push(created);
        endpoints.push({ name: `endpoint-${index}`, target: created.url });
      }

      const plan = await planX402Run({
        network: NETWORK,
        endpoints,
        ...(maxRunUsd === undefined ? {} : { maxRunUsd }),
      });
      const label = `seed ${seed}: plan ${formatUsd(plan.worstCaseUsd)}, cap ${formatUsd(plan.capUsd)}`;
      assert.equal(recorder.signed.length, 0, `${label}: the plan signed`);

      // After the plan, a paywall may raise its price or change its payee.
      const changed = new Set<string>();
      for (const [index, created] of walls.entries()) {
        const roll = next();
        const current = created.accepts[0]!;
        if (roll < 0.2) {
          created.accepts = [{ ...current, amount: (BigInt(current.amount) * 2n).toString() }];
        } else if (roll < 0.35) {
          created.accepts = [{ ...current, payTo: payee(index + 10) }];
          changed.add(payee(index + 10));
        }
      }

      // The caller of the plan: a refused plan is not run; one that passes is,
      // endpoint by endpoint, on one budget.
      const budget = new RunBudget(maxRunUsd === undefined ? {} : { maxRunUsd });
      if (plan.refusal === undefined) {
        for (const [index, endpoint] of plan.endpoints.entries()) {
          if (endpoint.status !== "planned") continue;
          await runX402PaymentChecks({
            target: endpoints[index]!.target,
            network: NETWORK,
            payerSecretKey: "test-payer-key",
            budget,
            plan: endpoint,
          });
        }
      }

      const signedUsd = recorder.signed.reduce((sum, requirement) => sum + usdOf(BigInt(requirement.amount)), 0n);
      const cap = usdFromDollars(Math.min(maxRunUsd ?? PER_RUN_CAP_USD, PER_RUN_CAP_USD));
      assert.ok(signedUsd <= cap, `${label}: signed ${formatUsd(signedUsd)}, above the cap`);
      assert.ok(signedUsd <= plan.worstCaseUsd, `${label}: signed ${formatUsd(signedUsd)}, above the plan`);
      assert.equal(signedUsd, budget.spentUsd, `${label}: the budget does not match what was signed`);
      if (plan.refusal !== undefined) assert.equal(recorder.signed.length, 0, `${label}: a refused plan signed`);

      const planned = new Map(
        plan.endpoints.flatMap((endpoint) =>
          endpoint.option === undefined ? [] : [[endpoint.option.payTo.toLowerCase(), endpoint] as const],
        ),
      );
      for (const requirement of recorder.signed) {
        const endpoint = planned.get(requirement.payTo.toLowerCase());
        assert.ok(endpoint, `${label}: signed for ${requirement.payTo}, a payee the plan did not see`);
        assert.ok(!changed.has(requirement.payTo), `${label}: signed for a payee changed after the plan`);
        const most = endpoint.signatures.reduce((max, entry) => (entry.amount > max ? entry.amount : max), 0n);
        assert.ok(BigInt(requirement.amount) <= most, `${label}: signed ${requirement.amount}, above the plan`);
      }
    }
  });
});
