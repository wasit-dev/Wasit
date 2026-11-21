/**
 * The parts of a mainnet run that the front ends share (spec B5, B18 O2),
 * written before the code (B11):
 *
 * - `planMainnetDryRun`: the dry run on stellar:pubnet. No key, no opt-in, no
 *   read of the chain, the RPC or Horizon: only each endpoint's unpaid
 *   challenge, by the mainnet rules, against the caps. Signs nothing.
 * - `mainnetOpeningLine`: the first line of a mainnet run, printed when the
 *   opt-in opens, before the target is asked anything.
 * - `closeMainnetRun` (L4): waits until every authorization the run may have
 *   signed has expired, reads the payer's balances after on public Horizon,
 *   closes the ledger with them, and closes the opt-in (its lock released).
 * - `githubDefaultBranch`: the default branch an event names, for the job rules.
 *
 * Offline: test/support/pubnet-chain.ts. No key here has ever held funds.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import { githubDefaultBranch } from "../../src/guard/ci-event.js";
import { closeMainnetRun, openMainnetOptIn } from "../../src/guard/mainnet-run.js";
import type { MainnetOptIn } from "../../src/guard/optin.js";
import { formatUsd } from "../../src/guard/budget.js";
import { MAINNET_RUN_LOCK_FILE } from "../../src/guard/run-lock.js";
import { mainnetFirstLine, mainnetOpeningLine, planMainnetDryRun, planX402Run } from "../../src/x402/plan.js";
import { runX402PaymentChecks } from "../../src/x402/simulator.js";
import { paywall, type Paywall } from "../support/recording-chain.js";
import { PUBNET, PUBNET_RPC, PUBNET_USDC, TESTNET, installPubnetWorld, pubnetOption, type PubnetWorld } from "../support/pubnet-chain.js";

const PAYER_KEY = Keypair.random();
const PAY_TO = Keypair.random().publicKey();
const CENT = 100_000n;
const VERSIONS = { wasit: "test", core: "test" };
const REJECT = { headers: { "x-lang": "xx" } };

let world: PubnetWorld;
let dir: string;
let walls: Paywall[] = [];

beforeEach(async () => {
  world = await installPubnetWorld();
  dir = mkdtempSync(path.join(tmpdir(), "wasit-close-"));
});

afterEach(async () => {
  for (const created of walls) await created.close();
  walls = [];
  await world.close();
  rmSync(dir, { recursive: true, force: true });
});

async function wall(amount: bigint, overrides: Parameters<typeof pubnetOption>[2] = {}): Promise<Paywall> {
  const created = await paywall([pubnetOption(PAY_TO, amount, overrides)]);
  walls.push(created);
  return created;
}

function open(): Promise<MainnetOptIn> {
  return openMainnetOptIn({
    frontEnd: "cli",
    env: { WASIT_MAINNET_PAYER_SECRET: PAYER_KEY.secret() },
    environment: "mainnet",
    network: PUBNET,
    operatedByMe: true,
    pin: { payTo: PAY_TO, asset: PUBNET_USDC },
    rpcUrl: PUBNET_RPC,
    ledgerDir: dir,
  });
}

describe("planMainnetDryRun: the dry run on stellar:pubnet (B5)", () => {
  const pin = { payTo: PAY_TO, asset: PUBNET_USDC };

  it("plans by the mainnet rules with no key and no opt-in, and reads nothing but each challenge", async () => {
    const target = await wall(CENT);
    const plan = await planMainnetDryRun({ pin, endpoints: [{ name: "weather", target: target.url, reject: REJECT }] });
    assert.equal(plan.refusal, undefined, plan.refusal ?? "");
    assert.equal(plan.network, PUBNET);
    const [entry] = plan.endpoints;
    assert.equal(entry?.status, "planned");
    assert.equal(entry?.url, new URL(target.url).origin + new URL(target.url).pathname);
    assert.equal(entry?.option?.asset, PUBNET_USDC);
    assert.equal(entry?.option?.payTo, PAY_TO);
    // The stand-in chain has no authorization reader, so X402-11 is not counted: 3.5 times the price.
    assert.equal(entry?.worstCase, 350_000n);
    assert.equal(plan.mainnet, undefined, "a dry run reads no balance and no ledger");
    assert.deepEqual(world.reads, []);
    assert.deepEqual(world.horizonRequests, []);
    assert.deepEqual(world.identityCalls, []);
    assert.equal(world.signed.length, 0);
    assert.equal(target.paid, 0);
  });

  it("says in its plan which reads a paid run makes first, and that it read none of them", async () => {
    const target = await wall(CENT);
    const plan = await planMainnetDryRun({ pin, endpoints: [{ name: "weather", target: target.url }] });
    assert.equal(plan.mainnetDryRun, true);
  });

  it("refuses without a pin, or with a pin that is not mainnet USDC, before any endpoint is asked", async () => {
    const target = await wall(CENT);
    let asked = 0;
    target.onChallenge = () => {
      asked += 1;
    };
    for (const wrong of [undefined, { payTo: PAY_TO, asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" }, { payTo: "not-an-address", asset: PUBNET_USDC }]) {
      const plan = await planMainnetDryRun({ ...(wrong === undefined ? {} : { pin: wrong }), endpoints: [{ name: "weather", target: target.url }] });
      assert.ok(plan.refusal !== undefined, JSON.stringify(wrong));
      assert.match(plan.refusal, /pinned/);
      assert.match(plan.refusal, /Nothing was signed\.$/);
    }
    assert.equal(asked, 0);
  });

  it("refuses the run when any endpoint cannot be planned: a lifetime above 300 s, a price above $1, an http host", async () => {
    const good = await wall(CENT);
    const long = await wall(CENT, { maxTimeoutSeconds: 301 });
    const dear = await wall(10_000_001n);
    for (const [name, target] of [["long", long.url], ["dear", dear.url], ["far", "http://example.com/paid"]] as const) {
      const plan = await planMainnetDryRun({ pin, endpoints: [{ name: "good", target: good.url }, { name, target }] });
      assert.ok(plan.refusal !== undefined, name);
      assert.match(plan.refusal, new RegExp(`Endpoint ${name} could not be planned`));
      assert.equal(plan.endpoints.find((entry) => entry.name === "good")?.status, "planned");
    }
    assert.equal(world.signed.length, 0);
  });

  it("refuses a worst case above the cap, the one maxRunUsd lowers included", async () => {
    const dollar = await wall(10_000_000n);
    const two = await planMainnetDryRun({ pin, endpoints: [{ name: "a", target: dollar.url }, { name: "b", target: dollar.url }] });
    assert.match(two.refusal ?? "", /up to \$7\.00 .* above the \$5\.00 per run/);
    const lowered = await planMainnetDryRun({ pin, maxRunUsd: 1, endpoints: [{ name: "a", target: dollar.url }] });
    assert.match(lowered.refusal ?? "", /above the \$1\.00 per run set by maxRunUsd/);
    const fits = await planMainnetDryRun({ pin, endpoints: [{ name: "a", target: dollar.url }] });
    assert.equal(fits.refusal, undefined);
    assert.equal(formatUsd(fits.worstCaseUsd), "$3.50");
  });
});

describe("mainnetOpeningLine: the first line of a mainnet run (B5)", () => {
  it("names the network, real funds, the payer, the one payee, the caps; it is printed before the plan", async () => {
    const optIn = await open();
    try {
      const line = mainnetOpeningLine(optIn);
      assert.ok(line.startsWith("MAINNET RUN on stellar:pubnet: real funds. "), line);
      assert.ok(line.includes(`Payer ${PAYER_KEY.publicKey()}`), line);
      assert.ok(line.includes(`pays only ${PAY_TO} in USDC`), line);
      assert.ok(line.includes("at most $1.00 per payment"), line);
      assert.ok(line.includes("at most $5.00 this run"), line);
      assert.match(line, /nothing is signed before it passes\.$/);
      assert.ok(!line.includes(PAYER_KEY.secret()));
      assert.deepEqual(world.horizonRequests, [], "the opening line reads nothing");
    } finally {
      optIn.close();
    }
  });

  it("is made for an opt-in core made only", () => {
    assert.throws(() => mainnetOpeningLine({ network: PUBNET, payer: PAYER_KEY.publicKey() } as unknown as MainnetOptIn), /Not a mainnet opt-in/);
  });
});

describe("closeMainnetRun: L4 (B3, B5)", () => {
  async function paidRun(amount = CENT) {
    const optIn = await open();
    const target = await wall(amount);
    const plan = await planX402Run({ network: PUBNET, endpoints: [{ name: "weather", target: target.url }], mainnet: optIn });
    assert.equal(plan.refusal, undefined, plan.refusal ?? "");
    const ledger = optIn.openLedger(VERSIONS);
    const entry = plan.endpoints[0]!;
    const results = await runX402PaymentChecks({ target: target.url, network: PUBNET, payerSecretKey: PAYER_KEY.secret(), plan: entry, mainnet: optIn });
    assert.ok(world.signed.length > 0, JSON.stringify(results));
    return { optIn, ledger, plan, target };
  }

  /** A sleep that lets `ledgers` close on the stand-in chain each time it is called. */
  function clock(ledgers = 1) {
    const calls: number[] = [];
    return {
      calls,
      sleep: async (ms: number) => {
        calls.push(ms);
        world.state.rpcLatest += ledgers;
        world.state.horizonLatest = world.state.rpcLatest;
      },
    };
  }

  it("waits until every authorization may have expired, reads the balances after on Horizon, closes the ledger and the opt-in", async () => {
    const { optIn, ledger } = await paidRun();
    // The stand-in signs outside the gate: no expiry is known, so L4 waits the anchor's bound for 300 s.
    const settled = ledger.entries.filter((entry) => entry.settlement?.verified === true).reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
    world.state.horizonUsdc = world.state.horizonUsdc! - settled;
    const anchor = 61_000_000;
    // One ledger at a time, so a wait that stops on the expiry ledger itself, not past it, is seen.
    const time = clock(1);
    const lines: string[] = [];
    const result = await closeMainnetRun(optIn, { sleep: time.sleep, onProgress: (line) => lines.push(line) });
    assert.ok(result.waitedUntil !== undefined && result.waitedUntil >= anchor + 60, String(result.waitedUntil));
    assert.ok(world.state.rpcLatest > result.waitedUntil!, "closed before the last authorization could have expired");
    assert.equal(result.problem, undefined);
    assert.equal(result.consistency?.consistent, true, result.consistency?.reasons.join(" | ") ?? "");
    assert.equal(result.ledgerPath, ledger.path);
    assert.ok(time.calls.length > 0);
    assert.match(lines.join("\n"), /Waiting until ledger \d+ has closed/);
    const file = JSON.parse(readFileSync(ledger.path, "utf8")) as Record<string, unknown>;
    assert.ok(file["balancesAfter"] !== undefined, "the ledger has no balances after");
    assert.equal(file["result"], "consistent");
    assert.ok(file["closedAt"] !== undefined);
    assert.equal(optIn.closed, true);
    assert.ok(!existsSync(path.join(dir, MAINNET_RUN_LOCK_FILE)), "the lock was not released");
    assert.ok(world.horizonRequests.some((url) => url === `/accounts/${PAYER_KEY.publicKey()}`));
  });

  it("says inconsistent when the payer's USDC did not go down by exactly what settled", async () => {
    const { optIn } = await paidRun();
    const result = await closeMainnetRun(optIn, { sleep: clock(10).sleep });
    assert.equal(result.consistency?.consistent, false);
    assert.match(result.consistency?.reasons.join(" ") ?? "", /went down by 0 base units/);
    assert.equal(optIn.closed, true);
  });

  it("waits for Horizon to catch up with the ledger it waited for before it reads the balances after", async () => {
    const { optIn } = await paidRun();
    let sleeps = 0;
    const result = await closeMainnetRun(optIn, {
      sleep: async () => {
        sleeps += 1;
        world.state.rpcLatest += 10;
        // The RPC passes the bound after about 7 sleeps; Horizon stays behind until the 13th.
        world.state.horizonLatest = sleeps > 12 ? world.state.rpcLatest : 61_000_002;
      },
    });
    assert.equal(result.problem, undefined, result.problem ?? "");
    assert.ok(sleeps > 12, `read the balances after while Horizon was behind (${sleeps} sleeps)`);
    assert.ok(world.state.horizonLatest > result.waitedUntil!);
  });

  it("does not wait when nothing was signed, and still closes the opt-in", async () => {
    const optIn = await open();
    const time = clock();
    const result = await closeMainnetRun(optIn, { sleep: time.sleep });
    assert.equal(result.consistency, undefined);
    assert.equal(result.waitedUntil, undefined);
    assert.deepEqual(time.calls, []);
    assert.equal(optIn.closed, true);
    assert.ok(!existsSync(path.join(dir, MAINNET_RUN_LOCK_FILE)));
  });

  it("closes the ledger without balances after when the RPC cannot be read, and says to wait and compare by hand", async () => {
    const { optIn, ledger } = await paidRun();
    world.state.rpcLatest = Number.NaN;
    const result = await closeMainnetRun(optIn, { sleep: async () => undefined });
    assert.ok(result.problem !== undefined);
    assert.match(result.problem, /could not be confirmed/);
    assert.match(result.problem, /wait until ledger \d+ has closed/);
    assert.equal(result.consistency?.consistent, false);
    assert.match(result.consistency?.reasons.join(" ") ?? "", /not both read/);
    const file = JSON.parse(readFileSync(ledger.path, "utf8")) as Record<string, unknown>;
    assert.equal(file["balancesAfter"], undefined);
    assert.equal(file["result"], "inconsistent");
    assert.equal(optIn.closed, true);
  });

  it("gives up when the RPC's latest ledger stops moving, without reading balances it cannot trust", async () => {
    const { optIn } = await paidRun();
    let calls = 0;
    const result = await closeMainnetRun(optIn, { sleep: async () => { calls += 1; } });
    assert.ok(calls > 0 && calls <= 500, String(calls));
    assert.match(result.problem ?? "", /could not be confirmed/);
    assert.equal(result.consistency?.consistent, false);
    assert.equal(optIn.closed, true);
  });

  it("closes the ledger once: a second close only closes nothing more", async () => {
    const { optIn } = await paidRun();
    await closeMainnetRun(optIn, { sleep: clock(10).sleep });
    const again = await closeMainnetRun(optIn, { sleep: clock(10).sleep });
    assert.equal(again.consistency, undefined);
    assert.match(again.problem ?? "", /already closed/);
  });

  it("is made for an opt-in core made only", async () => {
    await assert.rejects(closeMainnetRun({ network: PUBNET } as unknown as MainnetOptIn), /Not a mainnet opt-in/);
  });

  it("the first line after the plan keeps the worst case (O1), beside the opening line", async () => {
    const optIn = await open();
    const target = await wall(CENT);
    const plan = await planX402Run({ network: PUBNET, endpoints: [{ name: "weather", target: target.url }], mainnet: optIn });
    assert.match(mainnetFirstLine(plan), /this run could spend up to \$0\.035 of the \$5\.00 cap\.$/);
    optIn.close();
  });
});

describe("githubDefaultBranch", () => {
  it("reads repository.default_branch in a shape safe to echo, and nothing else", () => {
    assert.equal(githubDefaultBranch({ repository: { default_branch: "main" } }), "main");
    assert.equal(githubDefaultBranch({ repository: { default_branch: "release/1.x" } }), "release/1.x");
    for (const event of [undefined, null, {}, { repository: null }, { repository: { default_branch: 7 } }, { repository: { default_branch: "a b" } }, { repository: { default_branch: "x\ny" } }]) {
      assert.equal(githubDefaultBranch(event), undefined, JSON.stringify(event));
    }
  });
});

describe("the dry run is for stellar:pubnet only", () => {
  it("is never handed another network: it has no network option at all", async () => {
    const target = await wall(CENT);
    const plan = await planMainnetDryRun({ pin: { payTo: PAY_TO, asset: PUBNET_USDC }, endpoints: [{ name: "weather", target: target.url }] });
    assert.equal(plan.network, PUBNET);
    assert.notEqual(plan.network, TESTNET);
  });
});
