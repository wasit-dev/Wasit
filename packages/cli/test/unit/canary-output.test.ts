/**
 * The canary test (spec B6, safety rules 1 and 3), for what slice 3 adds:
 * `wasit run` (payment tier, read-only tier, dry run, refusals), the service it
 * starts, and `wasit ci-report` on what the run wrote.
 *
 * A fresh random Stellar key, which holds nothing, is set as every key
 * variable at once; the payment chain (the recording one: it signs nothing
 * real) reads it from STELLAR_PRIVATE_KEY. The RPC url carries a made-up API
 * key. Every line printed and every file written is then searched for the key,
 * its raw seed in hex and in base64, and the RPC key. Any hit fails.
 *
 * Not covered here (later slices): the MCP tools and the mainnet ledger.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";
import { DENIED_ENV_NAMES } from "@wasit-dev/core";

import { executeCiReport } from "../../src/ci-report-command.js";
import { executeRun, type RunCommandOptions } from "../../src/run.js";
import { NETWORK, installRecordingChain, multiPaywall, option, type MultiPaywall, type Recorder } from "./payment-helpers.js";

const CANARY = Keypair.random();
const KEY = CANARY.secret();
const SEED = CANARY.rawSecretKey();
const RPC_KEY = `rpckey${Math.random().toString(36).slice(2)}canary`;
const NEEDLES = [KEY, SEED.toString("hex"), SEED.toString("base64"), SEED.toString("base64url"), RPC_KEY];

/** Every key variable holds the canary. */
const KEYS = Object.fromEntries(DENIED_ENV_NAMES.map((name) => [name, KEY]));
const RPC = { WASIT_RPC_URL: `http://127.0.0.1:9/rpc?apikey=${RPC_KEY}` };

function assertClean(label: string, text: string): void {
  for (const needle of NEEDLES) assert.ok(!text.includes(needle), `${label} carries a key value`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

describe("canary: no key and no RPC key in any output of wasit run and wasit ci-report", () => {
  let dir: string;
  let paywall: MultiPaywall;
  let undo: () => void;
  const recorder: Recorder = { signed: [] };
  const printed: string[] = [];

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-canary-"));
    undo = installRecordingChain(recorder, { keyEnv: "STELLAR_PRIVATE_KEY", anyKey: true });
    paywall = await multiPaywall({ "/weather": [option("10000")], "/dear": [option("2000000")] });
  });
  after(async () => {
    undo();
    await paywall.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function config(name: string, environment: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<string> {
    const file = path.join(dir, `${name}.config.json`);
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        environments: { local: { baseUrl: paywall.base, network: NETWORK, operatedByMe: true, ...environment } },
        endpoints: [
          { name: "weather", protocol: "x402", path: "/weather", method: "GET" },
          { name: "dear", protocol: "x402", path: "/dear", method: "GET" },
        ],
        ...extra,
      }),
    );
    return file;
  }

  async function run(options: Partial<RunCommandOptions> & { config: string }, env: Record<string, string> = {}): Promise<number> {
    return executeRun(
      { readOnly: false, json: false, start: false, ...options },
      {
        env: { PATH: process.env["PATH"] ?? "", ...KEYS, ...RPC, ...env },
        stdout: (line) => printed.push(line),
        stderr: (line) => printed.push(line),
        cwd: dir,
      },
    );
  }

  it("the payment tier, as text and as --json with --out, then ci-report on its report", async () => {
    const file = await config("pay");
    const report = path.join(dir, "pay.report.json");
    await run({ config: file });
    await run({ config: file, json: true, out: report });
    assert.ok(recorder.signed.length > 0, "the canary run did not reach a signature");
    const code = await executeCiReport(
      {
        report,
        comment: path.join(dir, "pay.comment.md"),
        summary: path.join(dir, "pay.summary.md"),
        baselineOut: path.join(dir, "pay.baseline.json"),
        baseline: report,
        history: report,
      },
      { env: { PATH: process.env["PATH"] ?? "", ...KEYS, ...RPC }, stdout: (line) => printed.push(line), stderr: (line) => printed.push(line) },
    );
    assert.equal(code, 0);
  });

  it("the read-only tier and the dry run", async () => {
    const file = await config("read");
    await run({ config: file, readOnly: true, json: true, out: path.join(dir, "read.report.json") });
    await run({ config: file, dryRun: true });
  });

  it("every refusal: a pull request with a key, a plan above maxRunUsd, stellar:pubnet, a pin mismatch, a bad config", async () => {
    const pr = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" };
    assert.equal(await run({ config: await config("pr") }, pr), 2);
    assert.equal(await run({ config: await config("cap", { maxRunUsd: 0.01 }) }), 2);
    assert.equal(
      await run({
        config: await config("pubnet", {
          network: "stellar:pubnet",
          pinned: { payTo: Keypair.random().publicKey(), asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" },
        }),
      }),
      2,
    );
    await run({
      config: await config("pin", { pinned: { payTo: "0x1111111111111111111111111111111111111111", asset: option("1").asset } }),
      json: true,
      out: path.join(dir, "pin.report.json"),
    });
    const bad = path.join(dir, "bad.config.json");
    await writeFile(bad, JSON.stringify({ version: 1, environments: { local: { baseUrl: paywall.base, apiKey: KEY } }, endpoints: [] }));
    assert.equal(await run({ config: bad }), 2);
  });

  it("an unreachable target", async () => {
    const file = path.join(dir, "gone.config.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        environments: { local: { baseUrl: `http://127.0.0.1:${await freePort()}`, network: NETWORK, operatedByMe: true } },
        endpoints: [{ name: "weather", protocol: "x402", path: "/weather", method: "GET" }],
      }),
    );
    await run({ config: file, json: true, out: path.join(dir, "gone.report.json") });
  });

  it("a service started with --start: its environment holds no key and no RPC url", async () => {
    const port = await freePort();
    const envFile = path.join(dir, "service-env.json");
    const script = path.join(dir, "service.mjs");
    await writeFile(
      script,
      `import http from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));
http.createServer((q, s) => { s.writeHead(404); s.end(); }).listen(${port}, "127.0.0.1");
`,
    );
    const file = await config("start", {}, { service: { start: `node ${JSON.stringify(script)}`, ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 15 } } });
    await run({ config: file, readOnly: true, start: true });
    const childEnv = JSON.parse(await readFile(envFile, "utf-8")) as Record<string, string>;
    for (const name of [...DENIED_ENV_NAMES, "WASIT_RPC_URL"]) assert.ok(!(name in childEnv), name);
  });

  it("left no key and no RPC key in anything printed or written", async () => {
    // The config files hold no key except bad.config.json, which the test wrote itself.
    for (const name of await readdir(dir)) {
      if (name === "bad.config.json") continue;
      assertClean(`file ${name}`, await readFile(path.join(dir, name), "utf-8"));
    }
    assert.ok(printed.length > 20, "too little output was searched");
    assertClean("printed output", printed.join("\n"));
  });
});
