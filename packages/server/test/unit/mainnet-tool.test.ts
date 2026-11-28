/**
 * The MCP server's mainnet opt-in (spec B5, B18 O3), written before the code
 * (B11), in process: `readMainnetStartup` (the start-up rules, read once) and
 * `runMainnetEndpoint` (one call of `wasit_x402_mainnet_test`).
 *
 * The opt-in is start-up only: `WASIT_MAINNET_OPT_IN=1`, `WASIT_MAINNET_CONFIG`
 * (absolute) and `WASIT_MAINNET_ENVIRONMENT`, all three or none, outside CI,
 * a pubnet environment with operatedByMe, a USDC pin, an https RPC, an x402
 * endpoint and the key variable set. The config is frozen then. Each call
 * opens its own opt-in on the process's one budget ($5, D-018), says MAINNET
 * RUN first, plans, writes the ledger next to the config, runs the checks,
 * waits for every authorization to expire and closes. One call at a time. A
 * call that stops, or whose ledger does not match the payer's balances, locks
 * the tool until the server is restarted; an explained ledger does not.
 *
 * Offline: pubnet-world.ts. Every key is made up; nothing leaves 127.0.0.1.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";
import { checkStatus, formatUsd } from "@wasit-dev/core";

import { MAINNET_TOOL, readMainnetStartup, runMainnetEndpoint, summarizeMainnetRun, type MainnetSetup } from "../../src/mainnet.js";
import { PUBNET_RPC, PUBNET_USDC, TESTNET_USDC, installPubnetWorld, pubnetOption, pubnetWall, type PubnetWall, type PubnetWorld } from "./pubnet-world.js";

const CENT = 100_000n;
const DOLLAR = 10_000_000n;
/** What a run on the stand-in paywall settles: X402-06's price and X402-09's half price (the paywall serves the underpayment). */
const SETTLES = (price: bigint): bigint => price + price / 2n;
const LOCK = "wasit-mainnet.lock";

describe("the MCP server's mainnet opt-in", () => {
  let root: string;
  let world: PubnetWorld;
  let wall: PubnetWall | undefined;
  let payer: Keypair;
  let payTo: string;
  let dir: string;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wasit-mcp-mainnet-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    world = await installPubnetWorld();
    payer = Keypair.random();
    payTo = Keypair.random().publicKey();
    dir = path.join(root, `run-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(async () => {
    await wall?.close();
    wall = undefined;
    await world.close();
  });

  interface Shape {
    network?: string;
    operatedByMe?: boolean;
    pinned?: { payTo: string; asset: string } | null;
    rpcUrl?: string | null;
    maxRunUsd?: number;
    endpoints?: Array<Record<string, unknown>>;
  }

  /** A config with one environment, `mainnet`, in a folder of its own (the ledger's folder). */
  async function config(names: string[], shape: Shape = {}): Promise<string> {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "wasit.config.json");
    const environment: Record<string, unknown> = {
      baseUrl: wall?.base ?? "https://service.example",
      network: shape.network ?? "stellar:pubnet",
      operatedByMe: shape.operatedByMe ?? true,
    };
    if (shape.pinned !== null) environment["pinned"] = shape.pinned ?? { payTo, asset: PUBNET_USDC };
    if (shape.rpcUrl !== null) environment["rpcUrl"] = shape.rpcUrl ?? PUBNET_RPC;
    if (shape.maxRunUsd !== undefined) environment["maxRunUsd"] = shape.maxRunUsd;
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        environments: { mainnet: environment, local: { baseUrl: "http://127.0.0.1:9", network: "stellar:testnet", operatedByMe: true } },
        endpoints: shape.endpoints ?? names.map((name) => ({ name, protocol: "x402", path: `/${name}`, method: "GET" })),
      }),
    );
    return file;
  }

  function startupEnv(file: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return {
      WASIT_MAINNET_OPT_IN: "1",
      WASIT_MAINNET_CONFIG: file,
      WASIT_MAINNET_ENVIRONMENT: "mainnet",
      WASIT_MAINNET_PAYER_SECRET: payer.secret(),
      ...extra,
    };
  }

  function setupOf(file: string, extra: Record<string, string | undefined> = {}): MainnetSetup {
    const startup = readMainnetStartup(startupEnv(file, extra), []);
    assert.equal(startup.kind, "on", startup.kind === "refused" ? startup.reasons.join(" | ") : startup.kind);
    return (startup as { setup: MainnetSetup }).setup;
  }

  function refusedReasons(env: Record<string, string | undefined>, args: string[] = []): string {
    const startup = readMainnetStartup(env, args);
    assert.equal(startup.kind, "refused", `expected a refusal, got ${startup.kind}`);
    const reasons = (startup as { reasons: readonly string[] }).reasons;
    assert.ok(reasons.length > 0);
    return reasons.join(" | ");
  }

  /** The L4 wait: each sleep closes ledgers; the first one also moves `settles` of the payer's USDC, as a settlement does. */
  function sleepFor(settles: bigint): (ms: number) => Promise<void> {
    const sleep = world.sleep(10);
    let moved = settles === 0n;
    return async (ms) => {
      if (!moved) {
        moved = true;
        world.state.horizonUsdc = world.state.horizonUsdc! - settles;
        world.state.rpcUsdc = world.state.horizonUsdc;
      }
      await sleep(ms);
    };
  }

  async function call(
    setup: MainnetSetup,
    endpoint: string,
    env: Record<string, string | undefined> = { WASIT_MAINNET_PAYER_SECRET: payer.secret() },
    settles = 0n,
  ) {
    const lines: string[] = [];
    const result = await runMainnetEndpoint(setup, endpoint, {
      env,
      versions: { "wasit.server": "test" },
      onLine: (line) => lines.push(line),
      sleep: sleepFor(settles),
    });
    return { result, lines };
  }

  function ledgers(): string[] {
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("wasit-ledger-")) : [];
  }

  describe("start-up (read once, before any tool is registered)", () => {
    it("is off without any of its three variables, and without --mainnet", () => {
      assert.deepEqual(readMainnetStartup({}, []), { kind: "off" });
      assert.deepEqual(readMainnetStartup({ WASIT_MAINNET_OPT_IN: "", WASIT_MAINNET_CONFIG: "  " }, ["--allow-destructive"]), { kind: "off" });
    });

    it("is on with all three, a pubnet environment and the key, and lists only the x402 endpoints", async () => {
      wall = await pubnetWall({});
      const file = await config([], {
        endpoints: [
          { name: "weather", protocol: "x402", path: "/weather", method: "GET" },
          { name: "quote", protocol: "x402", path: "/quote", method: "GET" },
        ],
      });
      const setup = setupOf(file);
      assert.equal(MAINNET_TOOL, "wasit_x402_mainnet_test");
      assert.deepEqual([...setup.endpoints], ["weather", "quote"]);
      assert.equal(setup.environment, "mainnet");
      assert.equal(setup.ledgerDir, dir, "the ledger is written next to the config");
      assert.equal(setup.run.network, "stellar:pubnet");
      assert.equal(formatUsd(setup.budget.capUsd), "$5.00");
    });

    it("takes maxRunUsd of the config as the process's cap", async () => {
      const file = await config(["weather"], { maxRunUsd: 2 });
      assert.equal(formatUsd(setupOf(file).budget.capUsd), "$2.00");
    });

    it("compares the names in upper case, as a Windows environment does", async () => {
      const file = await config(["weather"]);
      const startup = readMainnetStartup(
        { wasit_mainnet_opt_in: "1", Wasit_Mainnet_Config: file, WASIT_MAINNET_ENVIRONMENT: "mainnet", WASIT_MAINNET_PAYER_SECRET: payer.secret() },
        [],
      );
      assert.equal(startup.kind, "on");
    });

    it("freezes what it read: an edit of the file after start-up changes nothing", async () => {
      const file = await config(["weather"]);
      const setup = setupOf(file);
      await writeFile(file, JSON.stringify({ version: 1, environments: {}, endpoints: [] }));
      assert.deepEqual([...setup.endpoints], ["weather"]);
      assert.ok(Object.isFrozen(setup));
      assert.ok(Object.isFrozen(setup.run));
      assert.ok(Object.isFrozen(setup.run.endpoints));
      assert.ok(Object.isFrozen(setup.run.endpoints[0]));
      assert.ok(Object.isFrozen(setup.run.pinned));
      assert.ok(Object.isFrozen(setup.endpoints));
      assert.throws(() => {
        (setup.run.pinned as { payTo: string }).payTo = Keypair.random().publicKey();
      }, TypeError);
    });

    it("refuses --mainnet among the server's arguments: it is not read by this server", () => {
      for (const args of [["--mainnet"], ["--mainnet=true"]]) {
        assert.match(refusedReasons({}, args), /^--mainnet is not read by this server: its mainnet opt-in is WASIT_MAINNET_OPT_IN=1 with WASIT_MAINNET_CONFIG and WASIT_MAINNET_ENVIRONMENT/);
      }
    });

    it("needs all three variables, and names the ones that are missing", () => {
      assert.match(refusedReasons({ WASIT_MAINNET_OPT_IN: "1" }), /WASIT_MAINNET_CONFIG and WASIT_MAINNET_ENVIRONMENT (are|is) not set/);
      assert.match(refusedReasons({ WASIT_MAINNET_CONFIG: "/x/wasit.config.json" }), /WASIT_MAINNET_OPT_IN and WASIT_MAINNET_ENVIRONMENT (are|is) not set/);
      assert.match(refusedReasons({ WASIT_MAINNET_ENVIRONMENT: "mainnet", WASIT_MAINNET_OPT_IN: "1" }), /WASIT_MAINNET_CONFIG is not set/);
    });

    it("takes WASIT_MAINNET_OPT_IN=1 only, and never echoes another value", async () => {
      const file = await config(["weather"]);
      for (const value of ["0", "2", "true", "yes-please", "1; id"]) {
        const reasons = refusedReasons(startupEnv(file, { WASIT_MAINNET_OPT_IN: value }));
        assert.match(reasons, /WASIT_MAINNET_OPT_IN must be 1/, value);
        if (value.length > 1) assert.ok(!reasons.includes(value), value);
      }
    });

    it("refuses in CI: the MCP server's opt-in is for a builder's own machine", async () => {
      const file = await config(["weather"]);
      for (const extra of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }, { CI: "1" }]) {
        assert.match(refusedReasons(startupEnv(file, extra)), /refused in CI/, JSON.stringify(extra));
      }
    });

    it("needs an absolute path to the config, and a file it can read as one", async () => {
      assert.match(refusedReasons(startupEnv("wasit.config.json")), /WASIT_MAINNET_CONFIG must be an absolute path/);
      assert.match(refusedReasons(startupEnv(path.join(root, "missing", "wasit.config.json"))), /WASIT_MAINNET_CONFIG could not be read/);
      const bad = path.join(root, "bad.json");
      await writeFile(bad, "{ not json");
      assert.match(refusedReasons(startupEnv(bad)), /WASIT_MAINNET_CONFIG could not be read/);
    });

    it("needs the environment it names to exist", async () => {
      const file = await config(["weather"]);
      assert.match(refusedReasons(startupEnv(file, { WASIT_MAINNET_ENVIRONMENT: "prod" })), /no such environment/);
    });

    it("refuses an environment on a test network, or without operatedByMe", async () => {
      const file = await config(["weather"]);
      assert.match(refusedReasons(startupEnv(file, { WASIT_MAINNET_ENVIRONMENT: "local" })), /stellar:pubnet only/);
      const notMine = await config(["weather"], { operatedByMe: false });
      assert.match(refusedReasons(startupEnv(notMine)), /operatedByMe is not true/);
    });

    it("refuses a missing pin, a pin on another asset, and an RPC that is missing or not https", async () => {
      assert.match(refusedReasons(startupEnv(await config(["weather"], { pinned: null }))), /pin/i);
      assert.match(refusedReasons(startupEnv(await config(["weather"], { pinned: { payTo, asset: TESTNET_USDC } }))), /USDC/);
      assert.match(refusedReasons(startupEnv(await config(["weather"], { rpcUrl: null }))), /needs an RPC/);
      assert.match(refusedReasons(startupEnv(await config(["weather"], { rpcUrl: "http://rpc.example/key-9z" }))), /https/);
    });

    it("refuses a config with no x402 endpoint: MPP stays on test networks", async () => {
      const file = await config([], { endpoints: [{ name: "charge", protocol: "mpp-charge", path: "/charge", method: "GET" }] });
      assert.match(refusedReasons(startupEnv(file)), /x402 endpoint|MPP/);
    });

    it("needs the key variable set before it starts, and never reads another key variable for it", async () => {
      const file = await config(["weather"]);
      const reasons = refusedReasons(startupEnv(file, { WASIT_MAINNET_PAYER_SECRET: undefined, STELLAR_PRIVATE_KEY: payer.secret() }));
      assert.match(reasons, /WASIT_MAINNET_PAYER_SECRET is not set/);
      assert.ok(!reasons.includes(payer.secret()));
    });

    it("names every rule it breaks after the config was read", async () => {
      const file = await config(["weather"], { operatedByMe: false, rpcUrl: null });
      const reasons = refusedReasons(startupEnv(file, { WASIT_MAINNET_PAYER_SECRET: undefined }));
      for (const fragment of [/operatedByMe/, /needs an RPC/, /WASIT_MAINNET_PAYER_SECRET/]) assert.match(reasons, fragment);
    });
  });

  describe("a call of wasit_x402_mainnet_test", () => {
    it("says MAINNET RUN first, plans, writes the ledger next to the config, runs the checks and closes consistent", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      const setup = setupOf(await config(["weather"]));
      const { result, lines } = await call(setup, "weather", { WASIT_MAINNET_PAYER_SECRET: payer.secret() }, SETTLES(CENT));
      assert.equal(result.refused, undefined, result.refused ?? "");
      assert.match(lines[0] ?? "", /^MAINNET RUN on stellar:pubnet: real funds\. Payer G[A-Z2-7]{55}; pays only G[A-Z2-7]{55} in USDC; at most \$1\.00 per payment; at most \$5\.00 this run\./);
      assert.deepEqual(result.lines, lines, "the result carries every line, in order");
      assert.ok(lines.some((line) => /^MAINNET RUN on stellar:pubnet: real funds\..*this run could spend up to \$0\.035 of the \$5\.00 cap\./.test(line)), lines.join("\n"));
      assert.equal(ledgers().length, 1);
      assert.equal(result.ledgerPath, path.join(dir, ledgers()[0]!));
      assert.equal(result.ledgerResult, "consistent");
      assert.ok(lines.some((line) => /^Ledger: consistent/.test(line)), lines.slice(-4).join("\n"));
      const x06 = result.results.find((entry) => entry.id === "X402-06");
      assert.equal(x06 === undefined ? undefined : checkStatus(x06), "PASS", JSON.stringify(result.results.map((entry) => [entry.id, checkStatus(entry), entry.detail])));
      assert.ok(world.signed.length > 0 && world.signed.every((terms) => terms.network === "stellar:pubnet" && terms.payTo === payTo));
      assert.equal(existsSync(path.join(dir, LOCK)), false, "the lock is released");
      assert.equal(result.stopped, undefined);
      assert.equal(formatUsd(result.spentUsd), "$0.035");
      assert.equal(formatUsd(result.processSpentUsd), "$0.035");
      assert.equal(formatUsd(result.processCapUsd), "$5.00");
      const ledger = JSON.parse(readFileSync(result.ledgerPath!, "utf-8")) as Record<string, unknown>;
      assert.equal(ledger["result"], "consistent", JSON.stringify(ledger["reasons"]));
    });

    it("shares one budget across the calls of the process: a later call's worst case is held to what is left", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, DOLLAR)] });
      const setup = setupOf(await config(["weather"]));
      const first = await call(setup, "weather", { WASIT_MAINNET_PAYER_SECRET: payer.secret() }, SETTLES(DOLLAR));
      assert.equal(first.result.refused, undefined, first.result.refused ?? "");
      assert.equal(first.result.ledgerResult, "consistent", first.lines.slice(-3).join("\n"));
      assert.equal(formatUsd(first.result.processSpentUsd), "$3.50");
      const signedBefore = world.signed.length;
      const paidBefore = wall.paid.get("/weather") ?? 0;
      const second = await call(setup, "weather");
      assert.match(second.result.refused ?? "", /\$3\.50.*\$1\.50|\$1\.50.*\$3\.50/);
      assert.equal(world.signed.length, signedBefore, "the second call signed");
      assert.equal(wall.paid.get("/weather") ?? 0, paidBefore, "the second call paid");
      assert.match(second.lines[0] ?? "", /^MAINNET RUN on stellar:pubnet: .*at most \$1\.50 this run, what is left of the \$5\.00 cap\./);
      assert.equal(existsSync(path.join(dir, LOCK)), false, "the lock is released after the refusal");
    });

    it("runs one call at a time: a second call while one runs is refused before anything is sent", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      const setup = setupOf(await config(["weather"]));
      const running = call(setup, "weather", { WASIT_MAINNET_PAYER_SECRET: payer.secret() }, SETTLES(CENT));
      const second = await call(setup, "weather");
      assert.match(second.result.refused ?? "", /in progress/);
      assert.deepEqual(second.lines, []);
      assert.equal((await running).result.refused, undefined);
      const third = await call(setup, "weather");
      assert.equal(third.result.refused, undefined, "a call after the first ended runs");
    });

    it("refuses a name that is not an x402 endpoint of the config, before anything is sent", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      const setup = setupOf(await config(["weather"]));
      const { result, lines } = await call(setup, "summarize");
      assert.match(result.refused ?? "", /no x402 endpoint named summarize/);
      assert.deepEqual(lines, []);
      assert.equal(wall.requests, 0);
      assert.equal(world.identityCalls.length, 0);
    });

    it("refuses a call when the key is gone or not a Stellar key, before the service is asked anything", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      const setup = setupOf(await config(["weather"]));
      for (const env of [{}, { WASIT_MAINNET_PAYER_SECRET: "not-a-key" }]) {
        const { result } = await call(setup, "weather", env);
        assert.match(result.refused ?? "", /WASIT_MAINNET_PAYER_SECRET/);
      }
      assert.equal(wall.requests, 0);
      assert.equal(world.signed.length, 0);
      assert.equal(ledgers().length, 0);
    });

    it("refuses a plan above $1 a payment: nothing signed, the lock released, the next call runs", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, DOLLAR + 1n)] });
      const setup = setupOf(await config(["weather"]));
      const refused = await call(setup, "weather");
      assert.ok(refused.result.refused !== undefined);
      assert.match(refused.lines[0] ?? "", /^MAINNET RUN/);
      assert.equal(world.signed.length, 0);
      assert.equal(existsSync(path.join(dir, LOCK)), false);
      assert.equal(formatUsd(refused.result.processSpentUsd), "$0.00");
      wall.accepts.set("/weather", [pubnetOption(payTo, CENT)]);
      assert.equal((await call(setup, "weather")).result.refused, undefined);
    });

    it("refuses a call whose payer holds less than the run needs to finish its checks: nothing signed, no lock on the tool", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, DOLLAR)] });
      world.state.rpcUsdc = 12_733_706n;
      world.state.horizonUsdc = 12_733_706n;
      const setup = setupOf(await config(["weather"]));
      const refused = await call(setup, "weather");
      assert.match(refused.result.refused ?? "", /the payer holds \$1\.2733706 in USDC, and this run needs at least \$2\.00 to finish its checks .*\$0\.7266294 short\. Nothing was signed\./);
      assert.ok(refused.lines.some((line) => /^Mainnet: funds: the payer holds \$1\.2733706 in USDC; /.test(line)), refused.lines.join("\n"));
      assert.equal(world.signed.length, 0);
      assert.equal(ledgers().length, 0);
      assert.equal(existsSync(path.join(dir, LOCK)), false);
      // A refusal before the ledger opens does not lock the tool: with enough funds, the next call runs.
      world.state.rpcUsdc = 50_000_000n;
      world.state.horizonUsdc = 50_000_000n;
      assert.equal((await call(setup, "weather")).result.refused, undefined);
    });

    it("is a verdict the result can carry only when the run did not stop and its ledger is consistent", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      const setup = setupOf(await config(["weather"]));
      const good = await call(setup, "weather", { WASIT_MAINNET_PAYER_SECRET: payer.secret() }, SETTLES(CENT));
      const summary = summarizeMainnetRun(setup, good.result);
      assert.equal(summary.trusted, true);
      assert.equal(summary.caveat, "");
      assert.deepEqual(summary.fields, {
        network: "stellar:pubnet",
        payTo,
        ledger: good.result.ledgerPath,
        ledgerResult: "consistent",
        spentUsd: "$0.035",
        processSpentUsd: "$0.035",
        processCapUsd: "$5.00",
      });
      // The payer's USDC does not move although X402-06 verified a settlement: the ledger is not consistent.
      const bad = await call(setup, "weather");
      assert.equal(bad.result.ledgerResult, "inconsistent");
      assert.ok(bad.lines.some((line) => /^Ledger: INCONSISTENT/.test(line)), bad.lines.slice(-3).join("\n"));
      const flagged = summarizeMainnetRun(setup, bad.result);
      assert.equal(flagged.trusted, false);
      assert.match(flagged.caveat, /No verdict: the run ledger does not match the payer's balances on public Horizon\. The mainnet tool is locked until the server is restarted: compare the ledger with the chain by hand first\./);
      assert.equal(flagged.fields.ledgerResult, "inconsistent");
      const stopped = summarizeMainnetRun(setup, { ...good.result, stopped: "the service changed its price" });
      assert.equal(stopped.trusted, false);
      assert.match(stopped.caveat, /No verdict: the mainnet run stopped/);
      assert.equal(stopped.fields.stopped, "the service changed its price");
    });

    it("an explained ledger is a verdict: the checks that FAILed explain it, and the tool stays open", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      const setup = setupOf(await config(["weather"]));
      // X402-09's half cent leaves the payer, but the stand-in chain does not show its settlement: unverified, X402-09 FAILs.
      world.state.unverified.add(CENT / 2n);
      const first = await call(setup, "weather", { WASIT_MAINNET_PAYER_SECRET: payer.secret() }, SETTLES(CENT));
      assert.equal(first.result.ledgerResult, "explained", first.lines.slice(-3).join("\n"));
      assert.ok(first.lines.some((line) => /^Ledger: explained: /.test(line)), first.lines.slice(-3).join("\n"));
      const summary = summarizeMainnetRun(setup, first.result);
      assert.equal(summary.trusted, true);
      assert.equal(summary.caveat, "");
      assert.equal(summary.fields.ledgerResult, "explained");
      assert.ok(!first.lines.some((line) => /locked/.test(line)));
      world.state.unverified.clear();
      const second = await call(setup, "weather", { WASIT_MAINNET_PAYER_SECRET: payer.secret() }, SETTLES(CENT));
      assert.equal(second.result.refused, undefined, "an explained ledger does not lock the tool");
    });

    describe("the lock after a call that cannot be trusted", () => {
      /** A second call on the same setup: refused before anything is asked, signed or written. */
      async function assertLocked(setup: MainnetSetup, why: RegExp): Promise<void> {
        const requests = wall!.requests;
        const signed = world.signed.length;
        const files = ledgers().length;
        const identity = world.identityCalls.length;
        const next = await call(setup, "weather", { WASIT_MAINNET_PAYER_SECRET: payer.secret() }, SETTLES(CENT));
        assert.match(next.result.refused ?? "", /^The mainnet tool of this server is locked: /);
        assert.match(next.result.refused ?? "", why);
        assert.match(next.result.refused ?? "", /then restart the server to use the mainnet tool again\. Nothing was sent\. Nothing was signed\.$/);
        assert.deepEqual(next.lines, [], "a locked call prints no MAINNET RUN line: nothing was opened");
        assert.equal(wall!.requests, requests, "the service was asked something");
        assert.equal(world.signed.length, signed);
        assert.equal(ledgers().length, files, "a locked call opened a ledger");
        assert.equal(world.identityCalls.length, identity, "a locked call read the RPC");
        assert.equal(formatUsd(next.result.spentUsd), "$0.00");
        // Unknown names are refused by the lock too: the tool is closed, not one endpoint.
        assert.match((await call(setup, "summarize")).result.refused ?? "", /locked/);
      }

      it("locks after a call whose ledger does not match the payer's balances; a restart (a new setup) opens it", async () => {
        wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
        const file = await config(["weather"]);
        const setup = setupOf(file);
        const bad = await call(setup, "weather");
        assert.equal(bad.result.ledgerResult, "inconsistent");
        assert.ok(bad.lines.some((line) => /^The mainnet tool is now locked until the server is restarted/.test(line)), bad.lines.slice(-3).join("\n"));
        await assertLocked(setup, /the ledger of an earlier call does not match the payer's balances \(wasit-ledger-[^)]+\.json\)\. Read that ledger/);
        // A restart reads the start-up again: a new setup, its own lock and its own $5.
        const restarted = setupOf(file);
        const after = await call(restarted, "weather", { WASIT_MAINNET_PAYER_SECRET: payer.secret() }, SETTLES(CENT));
        assert.equal(after.result.refused, undefined, after.result.refused ?? "");
      });

      it("locks after a call that stopped", async () => {
        wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
        const setup = setupOf(await config(["weather"]));
        // X402-06 and X402-07 are paid; then the payee changes and L2 stops the run.
        wall.onChallenge = (at) => {
          if (at === "/weather" && (wall!.paid.get("/weather") ?? 0) >= 2) wall!.accepts.set("/weather", [pubnetOption(Keypair.random().publicKey(), CENT)]);
        };
        const stopped = await call(setup, "weather", { WASIT_MAINNET_PAYER_SECRET: payer.secret() }, 2n * CENT);
        assert.ok(stopped.result.stopped !== undefined, stopped.lines.slice(-3).join("\n"));
        await assertLocked(setup, /an earlier call stopped \(its ledger is wasit-ledger-[^)]+\.json\)/);
      });

      it("locks after a call whose balances after were not read", async () => {
        wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
        const setup = setupOf(await config(["weather"]));
        const lines: string[] = [];
        const unread = await runMainnetEndpoint(setup, "weather", {
          env: { WASIT_MAINNET_PAYER_SECRET: payer.secret() },
          versions: { "wasit.server": "test" },
          onLine: (line) => lines.push(line),
          // The RPC moves on, public Horizon does not: the wait for Horizon gives up, the balances after are not read.
          sleep: async () => {
            world.state.rpcLatest += 10;
          },
        });
        assert.equal(unread.ledgerResult, "inconsistent", lines.slice(-3).join("\n"));
        assert.ok(lines.some((line) => /were not read/.test(line)), lines.slice(-3).join("\n"));
        await assertLocked(setup, /the payer's balances after an earlier call were not read \(its ledger is wasit-ledger-[^)]+\.json\)/);
      });

      it("locks after a call that threw once its ledger was open", async () => {
        wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
        const setup = setupOf(await config(["weather"]));
        await assert.rejects(
          runMainnetEndpoint(setup, "weather", {
            env: { WASIT_MAINNET_PAYER_SECRET: payer.secret() },
            versions: { "wasit.server": "test" },
            onLine: (line) => {
              if (/^Ledger: \//.test(line)) throw new Error("the client went away");
            },
            sleep: world.sleep(10),
          }),
          /the client went away/,
        );
        assert.equal(existsSync(path.join(dir, LOCK)), false, "the run was closed and its lock released");
        await assertLocked(setup, /an earlier call did not finish \(its ledger is wasit-ledger-[^)]+\.json\)/);
      });

      it("does not lock after a refusal that signed nothing", async () => {
        wall = await pubnetWall({ "/weather": [pubnetOption(payTo, DOLLAR + 1n)] });
        const setup = setupOf(await config(["weather"]));
        assert.ok((await call(setup, "weather")).result.refused !== undefined);
        wall.accepts.set("/weather", [pubnetOption(payTo, CENT)]);
        const next = await call(setup, "weather", { WASIT_MAINNET_PAYER_SECRET: payer.secret() }, SETTLES(CENT));
        assert.equal(next.result.refused, undefined, next.result.refused ?? "");
      });
    });

    it("never puts the key, its seed in hex or base64 in a line, a result or the ledger", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      const setup = setupOf(await config(["weather"]));
      const { result, lines } = await call(setup, "weather");
      const seed = payer.rawSecretKey();
      const texts = [lines.join("\n"), JSON.stringify(result.results), readFileSync(result.ledgerPath!, "utf-8")];
      for (const text of texts) {
        for (const needle of [payer.secret(), seed.toString("hex"), seed.toString("base64")]) assert.ok(!text.includes(needle));
      }
    });
  });
});
