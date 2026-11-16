/**
 * L1 (the plan) and L2 (every signature) on a test network, spec B3 and B4,
 * written before the code they test (B11).
 *
 * L2 sits in `preparePayment`, the one function every x402 signature goes
 * through: after the fresh challenge is read and before the SDK signs. It
 * refuses a payment above $1, in an asset Wasit cannot value, to anyone but the
 * pin in ANY `exact` option, above what the plan allowed, or past the run's
 * cap; it charges the run before the signature and never credits it back; it
 * hands the SDK exactly the one option it checked; and it discards, unsent, a
 * payload whose `accepted` is not that option.
 *
 * Offline: a recording chain (it holds nothing, it only records what it is
 * asked to sign) and a loopback paywall that settles everything.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { RunBudget, formatUsd } from "../../src/guard/budget.js";
import { planX402Run } from "../../src/x402/plan.js";
import { runX402PaymentChecks } from "../../src/x402/simulator.js";
import type { CheckResult } from "../../src/check.js";
import {
  NETWORK,
  OTHER_PAY_TO,
  PAY_TO,
  USDC,
  installRecordingChain,
  option,
  paywall,
  signedTotal,
  type Paywall,
  type Recorder,
} from "../support/recording-chain.js";

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

async function wall(...accepts: Parameters<typeof option>[0][]): Promise<Paywall> {
  const created = await paywall(accepts.map(option));
  walls.push(created);
  return created;
}

function byId(results: readonly CheckResult[], id: string): CheckResult {
  const found = results.find((result) => result.id === id);
  assert.ok(found, `no ${id} in ${results.map((result) => result.id).join(", ")}`);
  return found;
}

function refusedSetup(result: CheckResult, pattern: RegExp): void {
  assert.equal(result.error?.kind, "setup", `${result.id}: ${result.detail}`);
  assert.match(result.detail, pattern);
  assert.match(result.detail, /Nothing was signed\./);
}

const run = (target: string, extra: Partial<Parameters<typeof runX402PaymentChecks>[0]> = {}) =>
  runX402PaymentChecks({ target, network: NETWORK, payerSecretKey: "test-payer-key", ...extra });

describe("L2: $1 a payment", () => {
  it("signs nothing for a price one base unit above $1, and sends nothing", async () => {
    const target = await wall({ amount: "1000001" });
    const results = await run(target.url);
    refusedSetup(byId(results, "X402-06"), /\$1\.00/);
    assert.equal(recorder.signed.length, 0);
    assert.equal(target.paid, 0);
  });

  it("signs a price of exactly $1: 3.5 times the price over the run, within $5", async () => {
    const target = await wall({ amount: "1000000" });
    const budget = new RunBudget();
    const results = await run(target.url, { budget });
    assert.equal(byId(results, "X402-06").pass, true, byId(results, "X402-06").detail);
    assert.deepEqual(
      recorder.signed.map((requirement) => requirement.amount),
      ["1000000", "1000000", "500000", "1000000"],
    );
    assert.equal(formatUsd(budget.spentUsd), "$3.50");
  });

  it("signs nothing in an asset Wasit cannot hold to a dollar cap", async () => {
    const target = await wall({ amount: "1", asset: "0x3333333333333333333333333333333333333333" });
    const results = await run(target.url);
    refusedSetup(byId(results, "X402-06"), /does not value|US dollar/);
    assert.equal(recorder.signed.length, 0);
  });
});

describe("L2: the run's cap", () => {
  it("is shared across endpoints: once reached, nothing more is signed in the run", async () => {
    const first = await wall({ amount: "1000000" });
    const second = await wall({ amount: "1000000" });
    const budget = new RunBudget();
    await run(first.url, { budget });
    const results = await run(second.url, { budget });

    assert.equal(byId(results, "X402-06").pass, true);
    refusedSetup(byId(results, "X402-07"), /\$5\.00/);
    for (const id of ["X402-09", "X402-10"]) refusedSetup(byId(results, id), /cap/);
    assert.equal(signedTotal(recorder), 4_500_000n);
    assert.equal(formatUsd(budget.spentUsd), "$4.50");
  });

  it("maxRunUsd lowers it: $1.50 lets X402-06 sign and refuses X402-07", async () => {
    const target = await wall({ amount: "1000000" });
    const results = await run(target.url, { budget: new RunBudget({ maxRunUsd: 1.5 }) });
    assert.equal(byId(results, "X402-06").pass, true);
    refusedSetup(byId(results, "X402-07"), /\$1\.50/);
    assert.equal(signedTotal(recorder), 1_000_000n);
  });
});

describe("L2: the pin", () => {
  const pin = { payTo: PAY_TO, asset: USDC };

  it("refuses a challenge with a second exact option that pays someone else, and signs nothing", async () => {
    const target = await wall({ amount: "10000" }, { amount: "10000", payTo: OTHER_PAY_TO });
    const results = await run(target.url, { pin });
    refusedSetup(byId(results, "X402-06"), /payTo/);
    assert.equal(recorder.signed.length, 0);
    assert.equal(target.paid, 0);
  });

  it("accepts an EVM pin in another letter case, and options on other networks", async () => {
    const target = await wall(
      { amount: "10000", payTo: PAY_TO.toLowerCase() },
      { amount: "10000", payTo: "GDPAPDZWAKBXUPCNMI4YHAZ7DS7UOUTPGXAFDSWZG4URRMWHFSQTDQBM", network: "stellar:testnet", asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" },
    );
    const results = await run(target.url, { pin });
    assert.equal(byId(results, "X402-06").pass, true, byId(results, "X402-06").detail);
  });

  it("is re-checked on every signature: a payee changed after X402-06 stops X402-07", async () => {
    const target = await wall({ amount: "10000" });
    target.onChallenge = (count) => {
      if (count >= 2) target.accepts = [option({ amount: "10000", payTo: OTHER_PAY_TO })];
    };
    const results = await run(target.url, { pin });
    assert.equal(byId(results, "X402-06").pass, true);
    refusedSetup(byId(results, "X402-07"), /payTo/);
    assert.ok(recorder.signed.every((requirement) => requirement.payTo === PAY_TO));
  });
});

describe("L1 then L2: a challenge that changes after the plan", () => {
  it("the plan reads the price without paying, and signs nothing", async () => {
    const target = await wall({ amount: "100000" });
    const plan = await planX402Run({ network: NETWORK, endpoints: [{ name: "weather", target: target.url }] });
    assert.equal(plan.refusal, undefined);
    assert.equal(plan.endpoints[0]?.status, "planned");
    assert.equal(formatUsd(plan.worstCaseUsd), "$0.35");
    assert.equal(recorder.signed.length, 0);
    assert.equal(target.paid, 0);
  });

  it("a price raised after the plan is refused, not signed", async () => {
    const target = await wall({ amount: "100000" });
    const plan = await planX402Run({ network: NETWORK, endpoints: [{ name: "weather", target: target.url }] });
    target.accepts = [option({ amount: "200000" })];
    const results = await run(target.url, { plan: plan.endpoints[0]! });
    refusedSetup(byId(results, "X402-06"), /plan/);
    assert.equal(recorder.signed.length, 0);
  });

  it("a payee changed after the plan is refused even without a pin", async () => {
    const target = await wall({ amount: "100000" });
    const plan = await planX402Run({ network: NETWORK, endpoints: [{ name: "weather", target: target.url }] });
    target.accepts = [option({ amount: "100000", payTo: OTHER_PAY_TO })];
    const results = await run(target.url, { plan: plan.endpoints[0]! });
    refusedSetup(byId(results, "X402-06"), /plan/);
    assert.equal(recorder.signed.length, 0);
  });

  it("refuses the whole run before anything is signed when its worst case is above the cap", async () => {
    const weather = await wall({ amount: "1000000" });
    const summarize = await wall({ amount: "1000000" });
    const plan = await planX402Run({
      network: NETWORK,
      endpoints: [
        { name: "weather", target: weather.url },
        { name: "summarize", target: summarize.url },
      ],
    });
    assert.equal(formatUsd(plan.worstCaseUsd), "$7.00");
    assert.match(plan.refusal ?? "", /\$7\.00 \(weather \$3\.50, summarize \$3\.50\), above the \$5\.00 per run\. Nothing was signed\./);
    assert.equal(recorder.signed.length, 0);
  });

  it("on a test network, an endpoint above $1 is refused in the plan and the others are still planned", async () => {
    const cheap = await wall({ amount: "10000" });
    const dear = await wall({ amount: "2000000" });
    const plan = await planX402Run({
      network: NETWORK,
      endpoints: [
        { name: "cheap", target: cheap.url },
        { name: "dear", target: dear.url },
      ],
    });
    assert.equal(plan.refusal, undefined);
    assert.equal(plan.endpoints[0]?.status, "planned");
    assert.equal(plan.endpoints[1]?.status, "refused");
    assert.match(plan.endpoints[1]?.reason ?? "", /\$2\.00.*\$1\.00/);
  });

  it("refuses a pinned run whose challenge has any exact option off the pin", async () => {
    const target = await wall({ amount: "10000" }, { amount: "10000", payTo: OTHER_PAY_TO });
    const plan = await planX402Run({
      network: NETWORK,
      pin: { payTo: PAY_TO, asset: USDC },
      endpoints: [{ name: "weather", target: target.url }],
    });
    assert.equal(plan.endpoints[0]?.status, "refused");
    assert.match(plan.endpoints[0]?.reason ?? "", /payTo/);
  });

  it("plans nothing on a network that is not a test network", async () => {
    await assert.rejects(
      planX402Run({ network: "stellar:pubnet", endpoints: [{ name: "weather", target: "http://127.0.0.1:9/x" }] }),
      /mainnet opt-in is not part of this version/,
    );
  });
});

describe("L2: the SDK signs only the option Wasit checked", () => {
  it("hands the SDK one option: a first option it would drop never lets it sign the second", async () => {
    const target = await wall(
      { amount: "10000", extra: { name: "USDC", version: "2", paymentFlow: "not-a-known-flow" } },
      { amount: "20000" },
    );
    await run(target.url);
    assert.ok(
      recorder.signed.every((requirement) => requirement.amount !== "20000"),
      `signed: ${recorder.signed.map((requirement) => requirement.amount).join(", ")}`,
    );
  });

  it("refuses X402-10 before signing when the chain's expired terms change the payee (review R6, K2)", async () => {
    undo?.();
    undo = installRecordingChain(recorder, { expiredTerms: { maxTimeoutSeconds: 1, payTo: OTHER_PAY_TO } });
    const target = await wall({ amount: "10000" });
    const expired = byId(await run(target.url), "X402-10");
    assert.equal(expired.error?.kind, "setup", expired.detail);
    assert.match(expired.detail, /would sign different payTo terms than the target's/);
    assert.ok(recorder.signed.every((requirement) => requirement.payTo !== OTHER_PAY_TO), "signed for another payee");
  });

  it("discards, unsent, a payload whose accepted option is not the one checked", async () => {
    undo?.();
    undo = installRecordingChain(recorder, { swapPayTo: OTHER_PAY_TO });
    const target = await wall({ amount: "10000" });
    const budget = new RunBudget();
    const results = await run(target.url, { budget });
    const honest = byId(results, "X402-06");
    assert.equal(honest.error?.kind, "setup", honest.detail);
    assert.match(honest.detail, /accepted/);
    // It was signed: the message must not say otherwise (review R2).
    assert.doesNotMatch(honest.detail, /Nothing was signed/);
    assert.match(honest.detail, /It was signed and discarded; it was not sent\./);
    assert.equal(target.paid, 0, "the payload signed for another payee was sent");
    // It was signed, so it stays charged.
    assert.equal(formatUsd(budget.spentUsd), "$0.01");
  });

  it("L3: with a pin, the SDK's own policy drops another payee before it signs", async () => {
    undo?.();
    undo = installRecordingChain(recorder, { swapPayTo: OTHER_PAY_TO });
    const target = await wall({ amount: "10000" });
    const results = await run(target.url, { pin: { payTo: PAY_TO, asset: USDC } });
    assert.equal(byId(results, "X402-06").pass, false);
    assert.equal(recorder.signed.length, 0);
    assert.equal(target.paid, 0);
  });
});
