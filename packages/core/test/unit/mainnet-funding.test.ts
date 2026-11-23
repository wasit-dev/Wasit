/**
 * The payer's funds in the plan of a mainnet run (decided by Najmi on
 * 2026-11-23), written before the code: the plan already reads the payer's
 * USDC (through the RPC and on public Horizon, the two equal); it now holds
 * that balance to what the run needs to finish its checks.
 *
 * - minimum = the prices of the planned endpoints + the highest price again
 *   (every endpoint settles once at X402-06, and its later checks still need
 *   one more price in the account to be signed);
 * - balance below the minimum: the run is refused before anything is signed,
 *   saying how much is missing and what the minimum is;
 * - at or above the minimum, below the run's own worst case: a warning that
 *   funds can be lost if the service settles what it should refuse;
 * - at or above the worst case: no warning;
 * - always shown: the balance, the minimum, the worst case, what is left above
 *   the minimum (or how much is short);
 * - the dry run reads no balance and says what a paying run will hold it to.
 *
 * Seen on mainnet (B13 V5, attempt 2): a payer holding $1.27 against one
 * endpoint at $1.00 paid X402-06 and then could not sign the later checks, so
 * the run ended without a verdict half way.
 *
 * Offline: test/support/pubnet-chain.ts (its chain reads no authorizations, so
 * no X402-11 is planned here: the worst case is 3.5 times the price).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import { formatUsd } from "../../src/guard/budget.js";
import { openMainnetOptIn } from "../../src/guard/mainnet-run.js";
import type { MainnetOptIn } from "../../src/guard/optin.js";
import { describePlan, planMainnetDryRun, planX402Run } from "../../src/x402/plan.js";
import { paywall, type Paywall } from "../support/recording-chain.js";
import { PUBNET, PUBNET_RPC, PUBNET_USDC, installPubnetWorld, pubnetOption, type PubnetWorld } from "../support/pubnet-chain.js";

const PAYER_KEY = Keypair.random();
const PAY_TO = Keypair.random().publicKey();
const DOLLAR = 10_000_000n;

let world: PubnetWorld;
let dir: string;
let walls: Paywall[] = [];
let optIn: MainnetOptIn;

async function wall(amount: bigint): Promise<Paywall> {
  const created = await paywall([pubnetOption(PAY_TO, amount)]);
  walls.push(created);
  return created;
}

/** The payer's USDC on both readings (they must agree). */
function holds(units: bigint): void {
  world.state.rpcUsdc = units;
  world.state.horizonUsdc = units;
}

beforeEach(async () => {
  world = await installPubnetWorld();
  dir = mkdtempSync(path.join(tmpdir(), "wasit-funding-"));
  optIn = await openMainnetOptIn({
    frontEnd: "cli",
    env: { WASIT_MAINNET_PAYER_SECRET: PAYER_KEY.secret() },
    environment: "mainnet",
    network: PUBNET,
    operatedByMe: true,
    pin: { payTo: PAY_TO, asset: PUBNET_USDC },
    rpcUrl: PUBNET_RPC,
    ledgerDir: dir,
  });
});

afterEach(async () => {
  optIn.close();
  for (const created of walls) await created.close();
  walls = [];
  await world.close();
  rmSync(dir, { recursive: true, force: true });
});

async function planOne(price: bigint) {
  const target = await wall(price);
  return planX402Run({ network: PUBNET, endpoints: [{ name: "quote", target: target.url }], mainnet: optIn });
}

describe("the payer's funds in a mainnet plan", () => {
  it("refuses a payer below the minimum before anything is signed, and says how much is missing (B13 V5: $1.27 against $1.00)", async () => {
    holds(12_733_706n);
    const plan = await planOne(DOLLAR);
    assert.equal(
      plan.refusal,
      "This mainnet run does not start: the payer holds $1.2733706 in USDC, and this run needs at least $2.00 to finish " +
        "its checks (the prices, $1.00, plus the highest price again, $1.00): $0.7266294 short. Nothing was signed. Add " +
        "USDC to the payer (it may hold at most $10.00), or select fewer or cheaper endpoints.",
    );
    assert.equal(optIn.stopped, plan.refusal, "the refusal stops the run");
    assert.equal(optIn.plan, undefined, "a refused plan is not recorded");
    assert.equal(world.signed.length, 0);
    assert.equal(plan.funding?.minimum, 20_000_000n);
    assert.equal(plan.funding?.balance, 12_733_706n);
    const lines = describePlan(plan);
    assert.ok(
      lines.includes(
        "Mainnet: funds: the payer holds $1.2733706 in USDC; this run needs at least $2.00 to finish its checks (the prices, " +
          "$1.00, plus the highest price again, $1.00): $0.7266294 short; worst case $3.50.",
      ),
      lines.join("\n"),
    );
    assert.equal(lines.at(-1), `Refused: ${plan.refusal}`);
  });

  it("refuses one base unit below the minimum, and passes at exactly the minimum", async () => {
    holds(19_999_999n);
    const short = await planOne(DOLLAR);
    assert.match(short.refusal ?? "", /: \$0\.0000001 short\. Nothing was signed\./);
    optIn.close();
    optIn = await openMainnetOptIn({
      frontEnd: "cli",
      env: { WASIT_MAINNET_PAYER_SECRET: PAYER_KEY.secret() },
      environment: "mainnet",
      network: PUBNET,
      operatedByMe: true,
      pin: { payTo: PAY_TO, asset: PUBNET_USDC },
      rpcUrl: PUBNET_RPC,
      ledgerDir: dir,
    });
    holds(20_000_000n);
    const exact = await planOne(DOLLAR);
    assert.equal(exact.refusal, undefined, exact.refusal ?? "");
    assert.equal(optIn.stopped, undefined);
  });

  it("warns at or above the minimum and below the run's own worst case: funds can be lost, and the later checks may run short", async () => {
    holds(20_000_000n);
    const plan = await planOne(DOLLAR);
    assert.equal(plan.refusal, undefined);
    const warning =
      "Warning: the payer holds $2.00, less than this run's worst case of $3.50. A service that settles payments it should " +
      "refuse can take more than the $2.00 this run needs: funds can be lost that way, and the later checks may then have " +
      "too little left to run.";
    assert.equal(plan.funding?.warning, warning);
    const lines = describePlan(plan);
    assert.ok(lines.includes(warning), lines.join("\n"));
    assert.ok(
      lines.includes(
        "Mainnet: funds: the payer holds $2.00 in USDC; this run needs at least $2.00 to finish its checks (the prices, " +
          "$1.00, plus the highest price again, $1.00): $0.00 above it; worst case $3.50.",
      ),
      lines.join("\n"),
    );
  });

  it("does not warn at or above the worst case, and always shows the funds line", async () => {
    holds(35_000_000n);
    const at = await planOne(DOLLAR);
    assert.equal(at.refusal, undefined);
    assert.equal(at.funding?.warning, undefined);
    const lines = describePlan(at);
    assert.ok(!lines.some((line) => line.startsWith("Warning:")), lines.join("\n"));
    assert.ok(
      lines.includes(
        "Mainnet: funds: the payer holds $3.50 in USDC; this run needs at least $2.00 to finish its checks (the prices, " +
          "$1.00, plus the highest price again, $1.00): $1.50 above it; worst case $3.50.",
      ),
      lines.join("\n"),
    );
  });

  it("counts the prices of every endpoint plus the highest one again", async () => {
    holds(6_999_999n);
    const a = await wall(1_000_000n);
    const b = await wall(3_000_000n);
    const endpoints = [
      { name: "a", target: a.url },
      { name: "b", target: b.url },
    ];
    const short = await planX402Run({ network: PUBNET, endpoints, mainnet: optIn });
    assert.match(short.refusal ?? "", /needs at least \$0\.70 to finish its checks \(the prices, \$0\.40, plus the highest price again, \$0\.30\): \$0\.0000001 short/);
    assert.equal(short.funding?.worstCase, 14_000_000n, "3.5 times $0.10 and $0.30");
  });

  it("leaves the other refusals first: an endpoint that cannot be planned, or a worst case above the cap", async () => {
    holds(0n);
    const two = [await wall(DOLLAR), await wall(DOLLAR)];
    const plan = await planX402Run({
      network: PUBNET,
      endpoints: two.map((target, index) => ({ name: `e${index}`, target: target.url })),
      mainnet: optIn,
    });
    assert.match(plan.refusal ?? "", /^This run could spend up to \$7\.00/);
  });

  it("does not warn on a run refused for its cap: nothing is signed, so no funds can be lost (B13 V2c)", async () => {
    // Two endpoints at $1.00: minimum $3.00, worst case $7.00 here (above the $5.00 cap). $3.50 sits between the two.
    holds(35_000_000n);
    const two = [await wall(DOLLAR), await wall(DOLLAR)];
    const plan = await planX402Run({
      network: PUBNET,
      endpoints: two.map((target, index) => ({ name: `e${index}`, target: target.url })),
      mainnet: optIn,
    });
    assert.match(plan.refusal ?? "", /^This run could spend up to \$7\.00/);
    assert.equal(plan.funding?.warning, undefined);
    const lines = describePlan(plan);
    assert.ok(!lines.some((line) => line.startsWith("Warning:")), lines.join("\n"));
    assert.ok(
      lines.includes(
        "Mainnet: funds: the payer holds $3.50 in USDC; this run needs at least $3.00 to finish its checks (the prices, " +
          "$2.00, plus the highest price again, $1.00): $0.50 above it; worst case $7.00.",
      ),
      lines.join("\n"),
    );
    assert.equal(lines.at(-1), `Refused: ${plan.refusal}`);
  });

  it("does not warn on a run refused for an endpoint it cannot plan", async () => {
    // quote plans at $1.00 (minimum $2.00, worst case $3.50); dear is priced above $1.00 a payment and is refused.
    holds(25_000_000n);
    const quote = await wall(DOLLAR);
    const dear = await wall(DOLLAR + 1n);
    const plan = await planX402Run({
      network: PUBNET,
      endpoints: [
        { name: "quote", target: quote.url },
        { name: "dear", target: dear.url },
      ],
      mainnet: optIn,
    });
    assert.notEqual(plan.refusal, undefined);
    assert.equal(world.signed.length, 0);
    assert.equal(plan.funding?.warning, undefined);
    const lines = describePlan(plan);
    assert.ok(!lines.some((line) => line.startsWith("Warning:")), lines.join("\n"));
  });

  it("is a refusal only of a paying run: the dry run reads no balance and says what a paying run will hold it to", async () => {
    const target = await wall(DOLLAR);
    const plan = await planMainnetDryRun({ pin: { payTo: PAY_TO, asset: PUBNET_USDC }, endpoints: [{ name: "quote", target: target.url }] });
    assert.equal(plan.refusal, undefined);
    assert.equal(plan.funding?.minimum, 20_000_000n);
    assert.equal(plan.funding?.balance, undefined);
    assert.equal(formatUsd(plan.worstCaseUsd), "$3.50");
    const lines = describePlan(plan);
    assert.ok(
      lines.includes(
        "Mainnet dry run: a paying run also refuses when the payer holds less than $2.00 in USDC (the prices, $1.00, plus " +
          "the highest price again, $1.00: what it needs to finish its checks), and warns below the worst case of $3.50.",
      ),
      lines.join("\n"),
    );
    assert.ok(!lines.some((line) => line.startsWith("Mainnet: funds:")), "a dry run has no balance to show");
  });
});
