/**
 * `wasit run --mainnet` in this version (spec B5, B12): a switch that always
 * refuses, exit 2, before anything else is done. The config is not read, the
 * service is not started, no request is sent and nothing is signed, whatever
 * else the run was given: a pubnet environment with operatedByMe and a pin, a
 * payer key, the mainnet payer variable, --dry-run or --read-only.
 *
 * In GitHub Actions on an event that is not workflow_dispatch the message says
 * that rule too (spec B5: the switch is taken only on a run started by hand).
 *
 * Written before the code (CONTEXT rule 3). Every key is made up; nothing
 * leaves 127.0.0.1.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import { executeRun, type RunCommandOptions } from "../../src/run.js";
import { installRecordingChain, multiPaywall, option, type MultiPaywall, type Recorder } from "./payment-helpers.js";

const SENTENCE = "wasit run --mainnet is refused: the mainnet opt-in is not part of this version.";
const PUBNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

async function run(options: Partial<RunCommandOptions> & { config: string }, env: Record<string, string> = {}, cwd?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await executeRun(
    { readOnly: false, json: false, start: false, mainnet: true, ...options },
    { env: { PATH: process.env["PATH"] ?? "", ...env }, stdout: (line) => out.push(line), stderr: (line) => err.push(line), ...(cwd === undefined ? {} : { cwd }) },
  );
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

describe("wasit run --mainnet (B12: a switch that always refuses)", () => {
  let dir: string;
  let paywall: MultiPaywall | undefined;
  let recorder: Recorder;
  let undo: (() => void) | undefined;
  let eventFile: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-run-mainnet-"));
    eventFile = path.join(dir, "event.json");
    await writeFile(eventFile, JSON.stringify({ repository: { default_branch: "main" } }));
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

  async function pubnetConfig(base: string, service?: { start: string }): Promise<string> {
    const file = path.join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        defaultEnvironment: "mainnet",
        environments: {
          mainnet: {
            baseUrl: base,
            network: "stellar:pubnet",
            operatedByMe: true,
            pinned: { payTo: Keypair.random().publicKey(), asset: PUBNET_USDC },
            maxRunUsd: 1,
          },
        },
        ...(service === undefined ? {} : { service: { ...service, ready: { url: `${base}/weather`, timeoutSeconds: 5 } } }),
        endpoints: [{ name: "weather", protocol: "x402", path: "/weather", method: "GET", reject: { headers: { "x-lang": "xx" } } }],
      }),
    );
    return file;
  }

  it("refuses at once, exit 2, with the sentence of B12, and says nothing was done", async () => {
    paywall = await multiPaywall({ "/weather": [option("10000")] });
    const result = await run({ config: await pubnetConfig(paywall.base) });
    assert.equal(result.code, 2);
    assert.ok(result.stderr.startsWith(SENTENCE), result.stderr);
    assert.match(result.stderr, /Wasit pays on test networks only \(stellar:testnet, /);
    assert.match(result.stderr, /Nothing was read, started, sent or signed\.$/);
    assert.equal(result.stdout, "");
    assert.equal(paywall.requests, 0);
    assert.equal(recorder.signed.length, 0);
  });

  it("does not read the config: a file that does not exist gets the same refusal", async () => {
    const result = await run({ config: path.join(dir, "nope.json") });
    assert.equal(result.code, 2);
    assert.ok(result.stderr.startsWith(SENTENCE), result.stderr);
    assert.doesNotMatch(result.stderr, /nope\.json|cannot|not found/i);
  });

  for (const flags of [{ dryRun: true }, { readOnly: true }, { json: true, out: "report.json" }, { start: true }, { startIfLocal: true }, { endpoint: ["weather"] }] as const) {
    it(`refuses with ${JSON.stringify(flags)} too: nothing started, sent or signed, no report written`, async () => {
      paywall = await multiPaywall({ "/weather": [option("10000")] });
      const marker = path.join(dir, `started-${Math.random().toString(36).slice(2)}`);
      const config = await pubnetConfig(paywall.base, { start: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, '1')"` });
      const out = path.join(dir, `report-${Math.random().toString(36).slice(2)}.json`);
      const result = await run({ config, ...flags, ...("out" in flags ? { out } : {}) }, {}, dir);
      assert.equal(result.code, 2);
      assert.ok(result.stderr.startsWith(SENTENCE), result.stderr);
      assert.equal(paywall.requests, 0);
      assert.equal(recorder.signed.length, 0);
      assert.ok(!existsSync(marker), "the service was started");
      assert.ok(!existsSync(out), "a report was written");
    });
  }

  it("never prints the keys it was given, the mainnet payer variable included", async () => {
    paywall = await multiPaywall({ "/weather": [option("10000")] });
    const testnetKey = Keypair.random().secret();
    const mainnetKey = Keypair.random().secret();
    const result = await run(
      { config: await pubnetConfig(paywall.base) },
      { STELLAR_PRIVATE_KEY: testnetKey, WASIT_MAINNET_PAYER_SECRET: mainnetKey, WASIT_MAINNET_OPT_IN: "1" },
    );
    assert.equal(result.code, 2);
    for (const key of [testnetKey, mainnetKey]) assert.ok(!(result.stdout + result.stderr).includes(key));
    assert.equal(paywall.requests, 0);
  });

  for (const event of ["push", "schedule", "pull_request"]) {
    it(`in GitHub Actions on ${event}: refused, and the message adds the workflow_dispatch rule and names the event`, async () => {
      paywall = await multiPaywall({ "/weather": [option("10000")] });
      const result = await run(
        { config: await pubnetConfig(paywall.base) },
        { GITHUB_ACTIONS: "true", CI: "true", GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_PATH: eventFile },
      );
      assert.equal(result.code, 2);
      assert.ok(result.stderr.startsWith(SENTENCE), result.stderr);
      assert.ok(
        result.stderr.includes(`--mainnet is also refused on every GitHub event but workflow_dispatch, and this run's event is ${event}.`),
        result.stderr,
      );
      assert.equal(paywall.requests, 0);
    });
  }

  it("in GitHub Actions on workflow_dispatch: still refused, without the event rule", async () => {
    paywall = await multiPaywall({ "/weather": [option("10000")] });
    const result = await run(
      { config: await pubnetConfig(paywall.base) },
      { GITHUB_ACTIONS: "true", CI: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_PATH: eventFile },
    );
    assert.equal(result.code, 2);
    assert.ok(result.stderr.startsWith(SENTENCE), result.stderr);
    assert.doesNotMatch(result.stderr, /also refused/);
    assert.equal(paywall.requests, 0);
  });

  it("is not read from the environment: WASIT_MAINNET_OPT_IN without the flag changes nothing", async () => {
    paywall = await multiPaywall({ "/weather": [option("10000")] });
    const result = await run({ config: await pubnetConfig(paywall.base), mainnet: false, readOnly: true }, { WASIT_MAINNET_OPT_IN: "1" });
    assert.doesNotMatch(result.stderr, /--mainnet/);
    assert.equal(recorder.signed.length, 0);
    assert.equal(paywall.paid.size, 0);
  });
});
