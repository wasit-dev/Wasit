/**
 * The payment tier of `wasit run` (slice 3a; spec A1, A2, A8 #9, B3, B4; D-022a
 * option 2 and Najmi's answers of 2026-11-16, s2-build-plan.md).
 *
 * A run without --read-only and without --dry-run is the payment tier. It pays
 * only when every one of these holds: the network is a test network (L0), the
 * environment has `operatedByMe: true`, the chain's key variable is set, the
 * GitHub event may pay (push to the default branch, schedule, workflow_dispatch
 * on the default branch; outside GitHub Actions always), and the plan (L1) fits
 * the caps. One budget is shared by every endpoint, the plan's entry for each
 * endpoint goes to its checks, and the pin and `maxRunUsd` come from the config.
 *
 * Written before the code (CONTEXT rule 3). The chain is a recorder that signs
 * nothing real; the paywall is on 127.0.0.1.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";
import { setRpcIdentityTransportForTesting } from "@wasit-dev/core/dist/guard/rpc-identity.js";
import { setPaymentChainsForTesting } from "@wasit-dev/core/dist/x402/chains/index.js";

import { executeRun, type RunCommandOptions } from "../../src/run.js";
import {
  KEY_ENV,
  NETWORK,
  OTHER_PAY_TO,
  PAY_TO,
  USDC,
  installRecordingChain,
  multiPaywall,
  option,
  type MultiPaywall,
  type Recorder,
} from "./payment-helpers.js";

interface EnvironmentSpec {
  readonly network?: string;
  readonly operatedByMe?: boolean;
  readonly pinned?: { payTo: string; asset: string };
  readonly maxRunUsd?: number;
  readonly rpcUrl?: string;
}

async function writePaymentConfig(
  dir: string,
  base: string,
  environment: EnvironmentSpec = {},
  endpoints: ReadonlyArray<Record<string, unknown>> = [{ name: "weather", protocol: "x402", path: "/weather", method: "GET" }],
): Promise<string> {
  const file = path.join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      defaultEnvironment: "local",
      environments: {
        local: {
          baseUrl: base,
          network: environment.network ?? NETWORK,
          operatedByMe: environment.operatedByMe ?? true,
          ...(environment.pinned === undefined ? {} : { pinned: environment.pinned }),
          ...(environment.maxRunUsd === undefined ? {} : { maxRunUsd: environment.maxRunUsd }),
          ...(environment.rpcUrl === undefined ? {} : { rpcUrl: environment.rpcUrl }),
        },
      },
      endpoints,
    }),
  );
  return file;
}

const KEY = { [KEY_ENV]: "test-payer-key" };

async function pay(options: Partial<RunCommandOptions> & { config: string }, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await executeRun(
    { readOnly: false, json: true, start: false, ...options },
    { env: { PATH: process.env["PATH"] ?? "", ...env }, stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
  );
  const stdout = out.join("\n");
  let report: any;
  try {
    report = JSON.parse(stdout);
  } catch {
    report = undefined;
  }
  return { code, stdout, stderr: err.join("\n"), report };
}

function results(report: any, endpoint = "weather"): Array<{ id: string; status: string; skipKind?: string; detail: string; errorKind?: string }> {
  const found = report.endpoints.find((entry: any) => entry.name === endpoint);
  assert.ok(found, `no endpoint ${endpoint} in the report`);
  return found.results;
}

function result(report: any, id: string, endpoint = "weather") {
  const found = results(report, endpoint).find((entry) => entry.id === id);
  assert.ok(found, `no ${id} for ${endpoint}`);
  return found;
}

describe("wasit run, payment tier", () => {
  let dir: string;
  let paywall: MultiPaywall | undefined;
  let recorder: Recorder;
  let undo: (() => void) | undefined;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-run-payment-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    recorder = { signed: [] };
    undo = installRecordingChain(recorder);
  });
  afterEach(async () => {
    undo?.();
    await paywall?.close();
    paywall = undefined;
  });

  it("pays on a test network with the key, operatedByMe and no CI: every signature to the endpoint's payTo in USDC", async () => {
    paywall = await multiPaywall({ "/weather": [option("10000")] });
    const config = await writePaymentConfig(dir, paywall.base);
    const run = await pay({ config }, KEY);
    assert.ok(run.report, run.stderr);
    assert.equal(result(run.report, "X402-06").status, "PASS", run.stderr);
    assert.ok(recorder.signed.length >= 3, "the payment checks did not sign");
    for (const signed of recorder.signed) {
      assert.equal(signed.payTo, PAY_TO);
      assert.equal(signed.asset, USDC);
      assert.equal(signed.network, NETWORK);
    }
    assert.ok((paywall.paid.get("/weather") ?? 0) > 0);
  });

  it("says in its notes and on stderr that it pays, on which network, and what it charged of the cap", async () => {
    paywall = await multiPaywall({ "/weather": [option("10000")] });
    const config = await writePaymentConfig(dir, paywall.base);
    const run = await pay({ config }, KEY);
    const notes: string[] = run.report.notes;
    assert.ok(notes.some((note) => /^Tier: payment on eip155:84532\b/.test(note)), notes.join(" | "));
    assert.ok(notes.some((note) => /\$0\.035 of the \$5\.00/.test(note)), notes.join(" | "));
    assert.match(run.stderr, /Payment tier on eip155:84532 \(test network\)/);
    assert.match(run.stderr, /at most \$1\.00 per payment/);
  });

  it("shares one budget across the endpoints: the charge in the notes is the sum", async () => {
    paywall = await multiPaywall({ "/a": [option("10000")], "/b": [option("20000")] });
    const config = await writePaymentConfig(dir, paywall.base, {}, [
      { name: "a", protocol: "x402", path: "/a", method: "GET" },
      { name: "b", protocol: "x402", path: "/b", method: "GET" },
    ]);
    const run = await pay({ config }, KEY);
    // a: 3.5 x $0.01, b: 3.5 x $0.02.
    assert.ok(run.report.notes.some((note: string) => /\$0\.105 of the \$5\.00/.test(note)), run.report.notes.join(" | "));
  });

  it("refuses the whole run before any signature when the plan is above maxRunUsd", async () => {
    paywall = await multiPaywall({ "/a": [option("10000")], "/b": [option("10000")] });
    const config = await writePaymentConfig(dir, paywall.base, { maxRunUsd: 0.05 }, [
      { name: "a", protocol: "x402", path: "/a", method: "GET" },
      { name: "b", protocol: "x402", path: "/b", method: "GET" },
    ]);
    const run = await pay({ config }, KEY);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /could spend up to \$0\.07 .*above the \$0\.05 per run set by maxRunUsd\. Nothing was signed\./);
    assert.equal(recorder.signed.length, 0);
    assert.equal(paywall.paid.size, 0);
  });

  it("gives the payment group ERROR (setup) with both values when the service does not pay the pinned payTo", async () => {
    paywall = await multiPaywall({ "/weather": [option("10000")] });
    const config = await writePaymentConfig(dir, paywall.base, { pinned: { payTo: OTHER_PAY_TO, asset: USDC } });
    const run = await pay({ config }, KEY);
    assert.equal(run.code, 2, run.stderr);
    const first = result(run.report, "X402-06");
    assert.equal(first.status, "ERROR");
    assert.equal(first.errorKind, "setup");
    assert.ok(first.detail.includes(PAY_TO) && first.detail.includes(OTHER_PAY_TO), first.detail);
    assert.equal(recorder.signed.length, 0);
  });

  it("refuses to sign above $1 on a test network: that endpoint is ERROR (setup), the others still run", async () => {
    paywall = await multiPaywall({ "/dear": [option("2000000")], "/cheap": [option("10000")] });
    const config = await writePaymentConfig(dir, paywall.base, {}, [
      { name: "dear", protocol: "x402", path: "/dear", method: "GET" },
      { name: "cheap", protocol: "x402", path: "/cheap", method: "GET" },
    ]);
    const run = await pay({ config }, KEY);
    const dear = result(run.report, "X402-06", "dear");
    assert.equal(dear.status, "ERROR");
    assert.equal(dear.errorKind, "setup");
    assert.match(dear.detail, /\$1\.00/);
    assert.equal(result(run.report, "X402-06", "cheap").status, "PASS");
    for (const signed of recorder.signed) assert.notEqual(signed.amount, "2000000");
  });

  it("hands each endpoint its entry of the plan: a price raised after the plan is refused at signing", async () => {
    paywall = await multiPaywall({ "/weather": [option("10000")] });
    const wall = paywall;
    // The plan reads the first challenge; every later one asks for twice the price, still under $1.
    wall.onChallenge = (_path, count) => {
      if (count === 1) return;
      wall.accepts.set("/weather", [option("20000")]);
    };
    const config = await writePaymentConfig(dir, wall.base);
    const run = await pay({ config }, KEY);
    const first = result(run.report, "X402-06");
    assert.equal(first.status, "ERROR", first.detail);
    assert.match(first.detail, /after the plan/);
    for (const signed of recorder.signed) assert.notEqual(signed.amount, "20000");
  });

  it("hands the pin to every signature: a second option to another payTo, added after the plan, is refused", async () => {
    paywall = await multiPaywall({ "/weather": [option("10000")] });
    const wall = paywall;
    wall.onChallenge = (_path, count) => {
      if (count === 1) return;
      wall.accepts.set("/weather", [option("10000"), option("10000", OTHER_PAY_TO)]);
    };
    const config = await writePaymentConfig(dir, wall.base, { pinned: { payTo: PAY_TO, asset: USDC } });
    const run = await pay({ config }, KEY);
    const first = result(run.report, "X402-06");
    assert.equal(first.status, "ERROR", first.detail);
    assert.ok(first.detail.includes(OTHER_PAY_TO), first.detail);
    assert.equal(recorder.signed.length, 0);
  });

  it("does not pay without the chain's key: needs-payer naming the variable, and exit 2, since the tier asked for was not run", async () => {
    paywall = await multiPaywall({ "/weather": [option("10000")] });
    const config = await writePaymentConfig(dir, paywall.base);
    const run = await pay({ config });
    assert.equal(run.code, 2, run.stderr);
    assert.match(run.stderr, /payment checks were not run/);
    for (const id of ["X402-06", "X402-07", "X402-08", "X402-09", "X402-10"]) {
      const entry = result(run.report, id);
      assert.equal(entry.status, "SKIP");
      assert.equal(entry.skipKind, "needs-payer");
      assert.match(entry.detail, new RegExp(KEY_ENV));
    }
    assert.equal(recorder.signed.length, 0);
  });

  it("does not pay a service whose environment is not operatedByMe: read-only checks only, the report says why, exit 2", async () => {
    paywall = await multiPaywall({ "/weather": [option("10000")] });
    const config = await writePaymentConfig(dir, paywall.base, { operatedByMe: false });
    const run = await pay({ config }, KEY);
    assert.equal(run.code, 2, run.stderr);
    const entry = result(run.report, "X402-06");
    assert.equal(entry.status, "SKIP");
    assert.match(entry.detail, /operatedByMe/);
    assert.equal(recorder.signed.length, 0);
    assert.equal(paywall.paid.size, 0);
  });

  it("refuses stellar:pubnet without --mainnet before any request, and says to add it", async () => {
    paywall = await multiPaywall({ "/weather": [option("10000")] });
    const config = await writePaymentConfig(dir, paywall.base, {
      network: "stellar:pubnet",
      pinned: { payTo: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H", asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" },
    });
    const run = await pay({ config }, { STELLAR_PRIVATE_KEY: "SXXX" });
    assert.equal(run.code, 2);
    assert.match(run.stderr, /stellar:pubnet is Stellar mainnet: a paying run there needs --mainnet/);
    assert.equal(paywall.requests, 0, "a request was sent on a network the payment tier refuses");
    assert.equal(recorder.signed.length, 0);
  });

  it("refuses an RPC of another network before the service starts or any request is sent (review R4)", async () => {
    paywall = await multiPaywall({ "/weather": [option("10000")] });
    const config = await writePaymentConfig(dir, paywall.base);
    // The RPC answers Ethereum mainnet's chain id; the run is on Base Sepolia.
    setRpcIdentityTransportForTesting(async (_url, method) => (method === "eth_chainId" ? "0x1" : undefined));
    const run = await pay({ config }, KEY);
    assert.equal(run.code, 2, run.stderr);
    assert.match(run.stderr, /serves eip155:1,/);
    assert.match(run.stderr, /no payment was sent and nothing was signed/i);
    assert.match(run.stderr, /The service was not started\./);
    assert.equal(paywall.requests, 0, "a request reached the service before the RPC was checked");
    assert.equal(recorder.signed.length, 0);
  });

  it("refuses an http RPC on Stellar before the service starts or any request is sent", async () => {
    // The real adapters: the Stellar x402 client builds the payment through the run's RPC.
    setPaymentChainsForTesting(undefined);
    paywall = await multiPaywall({ "/weather": [option("10000")] });
    const config = await writePaymentConfig(dir, paywall.base, {
      network: "stellar:testnet",
      rpcUrl: "http://127.0.0.1:9/soroban/rpc",
    });
    let asked = 0;
    setRpcIdentityTransportForTesting(async () => {
      asked += 1;
      return undefined;
    });
    const run = await pay({ config }, { STELLAR_PRIVATE_KEY: Keypair.random().secret() });
    assert.equal(run.code, 2, run.stderr);
    assert.match(run.stderr, /accepts only an https RPC/);
    assert.match(run.stderr, /The service was not started\./);
    assert.equal(asked, 0);
    assert.equal(paywall.requests, 0);
  });

  describe("in a CI that is not GitHub Actions (review R9 a, Najmi 2026-11-17)", () => {
    const otherCi = { CI: "true" };

    for (const [label, env] of [["with a payer key", KEY], ["without a payer key", {}]] as const) {
      it(`refuses the payment tier ${label}: exit 2 before any request, and says to use --read-only`, async () => {
        paywall = await multiPaywall({ "/weather": [option("10000")] });
        const config = await writePaymentConfig(dir, paywall.base);
        const run = await pay({ config }, { ...otherCi, ...env });
        assert.equal(run.code, 2, run.stderr);
        assert.match(run.stderr, /CI is set, and this is not GitHub Actions/);
        assert.match(run.stderr, /--read-only/);
        assert.match(run.stderr, /Nothing was started, sent or signed\./);
        assert.equal(paywall.requests, 0);
        assert.equal(recorder.signed.length, 0);
      });
    }

    it("runs --read-only without a payer key", async () => {
      paywall = await multiPaywall({ "/weather": [option("10000")] });
      const config = await writePaymentConfig(dir, paywall.base);
      const run = await pay({ config, readOnly: true }, otherCi);
      assert.ok(run.report, run.stderr);
      assert.ok(paywall.requests > 0);
      assert.equal(recorder.signed.length, 0);
    });

    it("refuses --read-only with a payer key in the job: the service would run beside it", async () => {
      paywall = await multiPaywall({ "/weather": [option("10000")] });
      const config = await writePaymentConfig(dir, paywall.base);
      const run = await pay({ config, readOnly: true }, { ...otherCi, STELLAR_PRIVATE_KEY: "SXXX" });
      assert.equal(run.code, 2, run.stderr);
      assert.match(run.stderr, /STELLAR_PRIVATE_KEY is set: remove it from this job/);
      assert.equal(paywall.requests, 0);
    });
  });

  it("skips the MPP endpoints with the reason: wasit run does not pay MPP in this version", async () => {
    paywall = await multiPaywall({ "/weather": [option("10000")] });
    const config = await writePaymentConfig(dir, paywall.base, {}, [
      { name: "weather", protocol: "x402", path: "/weather", method: "GET" },
      { name: "chat", protocol: "mpp-charge", path: "/mpp/chat" },
    ]);
    const run = await pay({ config }, KEY);
    const mpp = result(run.report, "MPP-01", "chat");
    assert.equal(mpp.status, "SKIP");
    assert.match(mpp.detail, /wasit mpp-charge/);
  });

  describe("in GitHub Actions", () => {
    let eventFile: string;
    before(async () => {
      eventFile = path.join(dir, "event.json");
      await writeFile(eventFile, JSON.stringify({ repository: { default_branch: "main" } }));
    });
    const actions = (event: string, ref = "refs/heads/main") => ({
      GITHUB_ACTIONS: "true",
      CI: "true",
      GITHUB_EVENT_NAME: event,
      GITHUB_REF: ref,
      GITHUB_EVENT_PATH: eventFile,
    });

    for (const event of ["push", "schedule", "workflow_dispatch"]) {
      it(`pays on ${event} on the default branch`, async () => {
        paywall = await multiPaywall({ "/weather": [option("10000")] });
        const config = await writePaymentConfig(dir, paywall.base);
        const run = await pay({ config }, { ...KEY, ...actions(event) });
        assert.equal(result(run.report, "X402-06").status, "PASS", run.stderr);
        assert.ok(recorder.signed.length > 0);
      });
    }

    it("runs the read-only tier on a pull request without a key: payment checks not run: pull request", async () => {
      paywall = await multiPaywall({ "/weather": [option("10000")] });
      const config = await writePaymentConfig(dir, paywall.base);
      const run = await pay({ config }, actions("pull_request", "refs/pull/3/merge"));
      assert.equal(run.code, 0, run.stderr);
      const entry = result(run.report, "X402-06");
      assert.equal(entry.status, "SKIP");
      assert.equal(entry.skipKind, "read-only");
      assert.match(entry.detail, /payment checks not run: pull request/);
      assert.equal(result(run.report, "X402-01").status, "PASS");
      assert.equal(recorder.signed.length, 0);
      assert.equal(paywall.paid.size, 0);
    });

    it("runs a fork's pull request, whose secrets are empty, as read-only", async () => {
      paywall = await multiPaywall({ "/weather": [option("10000")] });
      const config = await writePaymentConfig(dir, paywall.base);
      const run = await pay({ config }, { ...actions("pull_request", "refs/pull/3/merge"), STELLAR_PRIVATE_KEY: "", [KEY_ENV]: "" });
      assert.equal(run.code, 0, run.stderr);
      assert.equal(recorder.signed.length, 0);
    });

    for (const tier of ["payment", "read-only"] as const) {
      it(`refuses a ${tier} run on a pull request that has a payer key, before any request, and says how to give the key`, async () => {
        paywall = await multiPaywall({ "/weather": [option("10000")] });
        const config = await writePaymentConfig(dir, paywall.base);
        const run = await pay(
          { config, readOnly: tier === "read-only" },
          { ...actions("pull_request", "refs/pull/3/merge"), STELLAR_PRIVATE_KEY: "SCANARY" },
        );
        assert.equal(run.code, 2);
        assert.match(run.stderr, /STELLAR_PRIVATE_KEY is set/);
        assert.match(run.stderr, /pull request/);
        assert.match(run.stderr, /github\.event_name != 'pull_request'/);
        assert.doesNotMatch(run.stderr + run.stdout, /SCANARY/);
        assert.equal(paywall.requests, 0, "a request was sent before the refusal");
      });
    }

    it("on a GitHub-hosted runner with a key, --start runs the service as a separate user, and refuses when it cannot", async () => {
      paywall = await multiPaywall({ "/weather": [option("10000")] });
      const file = path.join(dir, `start-${Math.random().toString(36).slice(2)}.json`);
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          service: { start: "node -e 0", ready: { url: "http://127.0.0.1:9/", timeoutSeconds: 5 } },
          environments: { local: { baseUrl: paywall.base, network: NETWORK, operatedByMe: true } },
          endpoints: [{ name: "weather", protocol: "x402", path: "/weather", method: "GET" }],
        }),
      );
      const out: string[] = [];
      const err: string[] = [];
      const code = await executeRun(
        { config: file, readOnly: false, json: true, start: true },
        {
          env: { PATH: process.env["PATH"] ?? "", ...KEY, ...actions("push"), RUNNER_ENVIRONMENT: "github-hosted", EVM_PRIVATE_KEY: "0xabc" },
          stdout: (line) => out.push(line),
          stderr: (line) => err.push(line),
          sudo: path.join(dir, "no-such-sudo"),
        },
      );
      assert.equal(code, 2);
      assert.match(err.join("\n"), /separate user \(wasit-service\)/);
      assert.equal(paywall.requests, 0, "the run went on without the separate user");
      assert.equal(recorder.signed.length, 0);
    });

    it("refuses a run on a push to another branch that has a key, before any request", async () => {
      paywall = await multiPaywall({ "/weather": [option("10000")] });
      const config = await writePaymentConfig(dir, paywall.base);
      const run = await pay({ config }, { ...KEY, ...actions("push", "refs/heads/feature"), EVM_PRIVATE_KEY: "0xabc" });
      assert.equal(run.code, 2);
      assert.match(run.stderr, /not the default branch/);
      assert.equal(paywall.requests, 0);
      assert.equal(recorder.signed.length, 0);
    });
  });

  it("hands the endpoint's reject case to X402-11; without one, X402-11 says the config has none", async () => {
    paywall = await multiPaywall({ "/weather": [option("10000")], "/plain": [option("10000")] });
    const config = await writePaymentConfig(dir, paywall.base, {}, [
      { name: "weather", protocol: "x402", path: "/weather", method: "GET", reject: { headers: { "x-lang": "xx" } } },
      { name: "plain", protocol: "x402", path: "/plain", method: "GET" },
    ]);
    const run = await pay({ config }, KEY);
    assert.ok(run.report, run.stderr);
    // The recording chain has no X402-11 watch: with a reject case the check gets as far as the chain.
    assert.match(result(run.report, "X402-11").detail, /cannot read on Recording/);
    assert.match(result(run.report, "X402-11", "plain").detail, /no request the service must refuse is configured/);
  });

  it("plans X402-11 for an endpoint with a reject case, on a chain it can read: the dry run lists it", async () => {
    undo?.();
    undo = installRecordingChain(recorder, { stubWatch: true });
    paywall = await multiPaywall({ "/weather": [option("10000")], "/plain": [option("10000")] });
    const config = await writePaymentConfig(dir, paywall.base, {}, [
      { name: "weather", protocol: "x402", path: "/weather", method: "GET", reject: { headers: { "x-lang": "xx" } } },
      { name: "plain", protocol: "x402", path: "/plain", method: "GET" },
    ]);
    const run = await pay({ config, dryRun: true, json: false });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /X402-06 10000, X402-07 10000, X402-09 5000, X402-10 10000, X402-11 10000 \(base units\)/);
    assert.match(run.stdout, /X402-06 10000, X402-07 10000, X402-09 5000, X402-10 10000 \(base units\)\n/);
    assert.equal(recorder.signed.length, 0, "a dry run signs nothing");
  });

  it("writes the report it printed to --out, with the payment results", async () => {
    paywall = await multiPaywall({ "/weather": [option("10000")] });
    const config = await writePaymentConfig(dir, paywall.base);
    const out = path.join(dir, "report.json");
    const run = await pay({ config, out }, KEY);
    const written = JSON.parse(await readFile(out, "utf-8"));
    assert.deepEqual(written, run.report);
  });
});
