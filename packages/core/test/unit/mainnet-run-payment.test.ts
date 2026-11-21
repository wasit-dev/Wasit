/**
 * L2 of a mainnet run (spec B3, B5, B18 O1), written before the code (B11):
 * with a live opt-in whose plan passed and whose ledger is open, the x402
 * payment checks pay on stellar:pubnet through the opt-in's own budget, pin,
 * plan, ledger and RPC, and nothing a caller hands in beside it. A guard
 * refusal stops the whole run: the remaining checks, and every later
 * endpoint's, are skipped with the reason, and nothing more is signed.
 *
 * Offline: test/support/pubnet-chain.ts (a scheme that records and signs
 * nothing real; a paywall that settles every paid request). No key here has
 * ever held funds.
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import type { CheckResult } from "../../src/check.js";
import { ConfigurationError } from "../../src/errors.js";
import { RunBudget, formatUsd } from "../../src/guard/budget.js";
import { openMainnetOptIn } from "../../src/guard/mainnet-run.js";
import { SigningGate } from "../../src/guard/signed-terms.js";
import type { MainnetOptIn } from "../../src/guard/optin.js";
import { stellarChain } from "../../src/x402/chains/stellar.js";
import { planX402Run, type RunPlan } from "../../src/x402/plan.js";
import { runX402PaymentChecks } from "../../src/x402/simulator.js";
import { paywall, type Paywall } from "../support/recording-chain.js";
import { PUBNET, PUBNET_RPC, PUBNET_USDC, installPubnetWorld, pubnetOption, type PubnetWorld } from "../support/pubnet-chain.js";

const PAYER_KEY = Keypair.random();
const PAY_TO = Keypair.random().publicKey();
const CENT = 100_000n;
const VERSIONS = { wasit: "test", core: "test" };

let world: PubnetWorld;
let dir: string;
let walls: Paywall[] = [];
let optIn: MainnetOptIn;

beforeEach(async () => {
  world = await installPubnetWorld();
  dir = mkdtempSync(path.join(tmpdir(), "wasit-pay-"));
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

async function wall(amount: bigint): Promise<Paywall> {
  const created = await paywall([pubnetOption(PAY_TO, amount)]);
  walls.push(created);
  return created;
}

/** Opens a planned run over `names`, each its own paywall at `amount`; the ledger is opened unless asked not to. */
async function plannedRun(names: string[], amount = CENT, options: { readonly ledger?: boolean } = {}) {
  const targets = new Map<string, Paywall>();
  for (const name of names) targets.set(name, await wall(amount));
  const plan = await planX402Run({
    network: PUBNET,
    endpoints: names.map((name) => ({ name, target: targets.get(name)!.url })),
    mainnet: optIn,
  });
  assert.equal(plan.refusal, undefined, plan.refusal ?? "");
  if (options.ledger !== false) optIn.openLedger(VERSIONS);
  return { plan, targets };
}

function entryOf(plan: RunPlan, name: string) {
  const entry = plan.endpoints.find((endpoint) => endpoint.name === name);
  assert.ok(entry !== undefined);
  return entry;
}

function pay(plan: RunPlan, name: string, target: Paywall, extra: Record<string, unknown> = {}) {
  return runX402PaymentChecks({
    target: target.url,
    network: PUBNET,
    payerSecretKey: PAYER_KEY.secret(),
    plan: entryOf(plan, name),
    mainnet: optIn,
    ...extra,
  });
}

function byId(results: readonly CheckResult[], id: string): CheckResult {
  const result = results.find((entry) => entry.id === id);
  assert.ok(result !== undefined, `no ${id} in ${results.map((entry) => entry.id).join(", ")}`);
  return result;
}

/** A run that was refused before its first check: one PREFLIGHT error, nothing signed or paid. */
function refusedAtPreflight(results: readonly CheckResult[], target: Paywall): void {
  assert.equal(results.length, 1, JSON.stringify(results));
  assert.equal(results[0]?.id, "PREFLIGHT");
  assert.ok(results[0]?.error !== undefined);
  assert.equal(world.signed.length, 0);
  assert.equal(target.paid, 0);
}

describe("paying on stellar:pubnet with a live opt-in", () => {
  it("pays through the opt-in's budget, plan, ledger and RPC, and builds the client with the opt-in", async () => {
    const { plan, targets } = await plannedRun(["weather"]);
    const results = await pay(plan, "weather", targets.get("weather")!);
    assert.equal(byId(results, "X402-06").pass, true, JSON.stringify(byId(results, "X402-06")));
    assert.ok(world.signed.length > 0);
    assert.ok(world.signed.every((option) => option.network === PUBNET && option.payTo === PAY_TO && option.asset === PUBNET_USDC));
    // What was signed is what the opt-in's budget charged, and it is within the plan.
    const signed = world.signed.reduce((sum, option) => sum + BigInt(option.amount), 0n);
    assert.equal(optIn.budget.spentUsd, RunBudget.valueOf(PUBNET, PUBNET_USDC, signed));
    assert.ok(optIn.budget.spentUsd <= plan.worstCaseUsd, `${formatUsd(optIn.budget.spentUsd)} above the plan`);
    // Every signature has its entry in the opt-in's ledger.
    const ledger = optIn.ledger;
    assert.ok(ledger !== undefined);
    assert.equal(ledger.entries.length, world.signed.length);
    assert.ok(ledger.entries.every((entry) => entry.endpoint === "weather" && entry.network === PUBNET));
    const file = readFileSync(ledger.path, "utf-8");
    assert.ok(file.includes(PAYER_KEY.publicKey()));
    assert.ok(!file.includes(PAYER_KEY.secret()), "the ledger holds the key");
    const document = JSON.parse(file) as { balancesBefore?: { usdc: string; native: string; source: string } };
    assert.equal(document.balancesBefore?.usdc, "50000000", "the balances before are not in the ledger");
    assert.equal(document.balancesBefore?.native, "25000000");
    assert.match(document.balancesBefore?.source ?? "", /Horizon/);
    // The client was built for pubnet with the opt-in and the opt-in's RPC.
    assert.ok(world.registered.length > 0);
    assert.ok(world.registered.every((call) => call.network === PUBNET && call.rpcUrl === PUBNET_RPC && call.mainnet === optIn));
    assert.equal(optIn.stopped, undefined);
  });

  it("signs nothing without the opt-in's ledger, and stops the run", async () => {
    const { plan, targets } = await plannedRun(["weather"], CENT, { ledger: false });
    const results = await pay(plan, "weather", targets.get("weather")!);
    refusedAtPreflight(results, targets.get("weather")!);
    assert.ok(optIn.stopped !== undefined);
  });

  it("refuses what a caller hands in beside the opt-in, and signs nothing", async () => {
    const cases: Array<[string, (plan: RunPlan) => Record<string, unknown>]> = [
      ["another budget", () => ({ budget: new RunBudget() })],
      ["another pin", () => ({ pin: { payTo: Keypair.random().publicKey(), asset: PUBNET_USDC } })],
      ["a plan entry the opt-in did not make", (plan) => ({ plan: structuredClone(entryOf(plan, "weather")) })],
      ["no plan entry", () => ({ plan: undefined })],
      ["a ledger of its own", () => ({ ledger: { intent: () => ({}) } })],
      ["another RPC", () => ({ rpcUrl: "https://rpc.other.example/stellar:pubnet" })],
      ["the key of another account", () => ({ payerSecretKey: Keypair.random().secret() })],
    ];
    for (const [label, extra] of cases) {
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
      const { plan, targets } = await plannedRun(["weather"]);
      const results = await pay(plan, "weather", targets.get("weather")!, extra(plan));
      refusedAtPreflight(results, targets.get("weather")!);
      assert.ok(optIn.stopped !== undefined, `${label}: the run was not stopped`);
      assert.ok(!JSON.stringify(results).includes(PAYER_KEY.secret()), `${label}: the key is in the results`);
    }
  });

  it("refuses an opt-in handed to a run on another network, and stops the run", async () => {
    const { plan, targets } = await plannedRun(["weather"]);
    const results = await runX402PaymentChecks({
      target: targets.get("weather")!.url,
      network: "stellar:testnet",
      payerSecretKey: PAYER_KEY.secret(),
      plan: entryOf(plan, "weather"),
      mainnet: optIn,
    });
    refusedAtPreflight(results, targets.get("weather")!);
    assert.match(optIn.stopped ?? "", /another network/);
  });

  it("refuses an opt-in whose plan was never made, and stops the run", async () => {
    const weather = await wall(CENT);
    const forged = {
      name: "weather",
      status: "planned" as const,
      option: { scheme: "exact", network: PUBNET, payTo: PAY_TO, asset: PUBNET_USDC, amount: CENT, maxTimeoutSeconds: 60 },
      signatures: [{ check: "X402-06", amount: CENT }],
      worstCase: CENT,
      worstCaseUsd: 0n,
    };
    const results = await pay({ endpoints: [forged] } as unknown as RunPlan, "weather", weather);
    refusedAtPreflight(results, weather);
    assert.match(optIn.stopped ?? "", /no plan/);
  });

  it("stops the whole run on a refusal: a lifetime raised after the plan stops X402-07, and nothing more is signed", async () => {
    const { plan, targets } = await plannedRun(["weather", "later"]);
    const weather = targets.get("weather")!;
    // Challenge 1 was the plan's, 2 is X402-06's; from 3 on the service asks for a lifetime of 3600 s.
    weather.onChallenge = (count) => {
      if (count >= 3) weather.accepts = [pubnetOption(PAY_TO, CENT, { maxTimeoutSeconds: 3600 })];
    };
    const results = await pay(plan, "weather", weather);
    assert.equal(byId(results, "X402-06").pass, true);
    assert.equal(world.signed.length, 1, "a signature was made after the refusal");
    const refused = byId(results, "X402-07");
    assert.ok(refused.error !== undefined, JSON.stringify(refused));
    assert.ok(optIn.stopped !== undefined);
    for (const id of ["X402-08", "X402-09", "X402-10"]) {
      const skipped = byId(results, id);
      assert.equal(skipped.skipped, true, `${id} ran after the run stopped`);
      assert.match(skipped.detail ?? skipped.skipReason ?? "", /mainnet run stopped/);
    }
    // A later endpoint of the same run: every payment check skipped, nothing signed.
    const later = await pay(plan, "later", targets.get("later")!);
    assert.ok(later.length > 1);
    assert.ok(later.every((result) => result.skipped === true), JSON.stringify(later));
    assert.equal(world.signed.length, 1);
    assert.equal(targets.get("later")!.paid, 0);
  });

  it("pays only the URL the plan recorded: a redirect to another path after the plan stops the run, unsigned", async () => {
    let unpaid = 0;
    let paid = 0;
    const challenge = Buffer.from(
      JSON.stringify({ x402Version: 2, resource: { url: "http://127.0.0.1/paid" }, accepts: [pubnetOption(PAY_TO, CENT)] }),
    ).toString("base64");
    const server = http.createServer((request, response) => {
      request.on("data", () => undefined);
      request.on("end", () => {
        if (typeof request.headers["payment-signature"] === "string") {
          paid += 1;
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        unpaid += 1;
        // The plan's read is answered here; every later one is sent to another path of the same origin.
        if (request.url === "/paid" && unpaid > 1) {
          response.writeHead(307, { location: "/elsewhere" });
          response.end();
          return;
        }
        response.writeHead(402, { "content-type": "application/json", "payment-required": challenge });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}/paid`;
      const plan = await planX402Run({ network: PUBNET, endpoints: [{ name: "moving", target }], mainnet: optIn });
      assert.equal(plan.refusal, undefined, plan.refusal ?? "");
      assert.equal(plan.endpoints[0]?.url, target);
      optIn.openLedger(VERSIONS);
      const results = await runX402PaymentChecks({
        target,
        network: PUBNET,
        payerSecretKey: PAYER_KEY.secret(),
        plan: plan.endpoints[0],
        mainnet: optIn,
      });
      assert.ok(byId(results, "X402-06").error !== undefined, JSON.stringify(byId(results, "X402-06")));
      assert.equal(world.signed.length, 0, "a payment was signed for a URL the plan did not record");
      assert.equal(paid, 0);
      assert.match(optIn.stopped ?? "", /plan recorded/);
      assert.equal(optIn.budget.spentUsd, 0n, "the run was charged for a URL the plan did not record");
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    }
  });

  it("stops the whole run when the payee changes after the plan", async () => {
    const { plan, targets } = await plannedRun(["weather"]);
    const weather = targets.get("weather")!;
    weather.accepts = [pubnetOption(Keypair.random().publicKey(), CENT)];
    const results = await pay(plan, "weather", weather);
    assert.ok(byId(results, "X402-06").error !== undefined);
    assert.equal(world.signed.length, 0);
    assert.ok(optIn.stopped !== undefined);
    const rest = results.filter((result) => result.id !== "X402-06");
    assert.ok(rest.length > 0 && rest.every((result) => result.skipped === true && /mainnet run stopped/.test(result.skipReason ?? "")));
  });

  it("signs nothing once the opt-in is closed", async () => {
    const { plan, targets } = await plannedRun(["weather"]);
    optIn.close();
    const results = await pay(plan, "weather", targets.get("weather")!);
    assert.equal(world.signed.length, 0);
    assert.equal(targets.get("weather")!.paid, 0);
    assert.ok(results.every((result) => result.error !== undefined || result.skipped === true));
  });

  it("refuses the ledger before a plan, and a second time", async () => {
    assert.throws(() => optIn.openLedger(VERSIONS), ConfigurationError);
    const { plan } = await plannedRun(["weather"]);
    assert.ok(plan.refusal === undefined);
    assert.throws(() => optIn.openLedger(VERSIONS), ConfigurationError);
  });

  it("refuses the ledger once the run is stopped or closed, even after a plan that passed", async () => {
    const weather = await wall(CENT);
    await planX402Run({ network: PUBNET, endpoints: [{ name: "weather", target: weather.url }], mainnet: optIn });
    optIn.stop("stopped for the test");
    assert.throws(() => optIn.openLedger(VERSIONS), /stopped or closed/);
  });

  it("refuses the ledger after a refused plan", async () => {
    const dear = await wall(10_000_001n);
    const plan = await planX402Run({ network: PUBNET, endpoints: [{ name: "dear", target: dear.url }], mainnet: optIn });
    assert.ok(plan.refusal !== undefined);
    assert.throws(() => optIn.openLedger(VERSIONS), ConfigurationError);
  });
});

describe("the Stellar adapter's pubnet RPC line (B5 point 4, B-A01)", () => {
  function registered(network: string, rpcUrl: string, mainnet: unknown): unknown {
    const schemes: unknown[] = [];
    const client = { register: (_network: string, scheme: unknown) => schemes.push(scheme) };
    stellarChain.registerPayer(client as never, network, PAYER_KEY.secret(), rpcUrl, new SigningGate(), mainnet as MainnetOptIn);
    return (schemes[0] as { rpcConfig?: unknown }).rpcConfig;
  }

  it("hands the SDK the RPC on stellar:pubnet only with a live opt-in for that RPC", async () => {
    assert.deepEqual(registered(PUBNET, PUBNET_RPC, optIn), { url: PUBNET_RPC });
    assert.equal(registered(PUBNET, "https://rpc.other.example/stellar:pubnet", optIn), undefined);
    assert.equal(registered(PUBNET, PUBNET_RPC, undefined), undefined);
    assert.equal(registered(PUBNET, PUBNET_RPC, { network: PUBNET, rpcUrl: PUBNET_RPC }), undefined);
    optIn.stop("stopped for the test");
    assert.equal(registered(PUBNET, PUBNET_RPC, optIn), undefined);
    // Testnet as before.
    assert.deepEqual(registered("stellar:testnet", "https://rpc.example/stellar:testnet", undefined), {
      url: "https://rpc.example/stellar:testnet",
    });
  });
});
