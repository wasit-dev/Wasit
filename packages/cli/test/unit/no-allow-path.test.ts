/**
 * The "no allow path" property test of spec B11 and B12, through `wasit run`:
 * for random combinations of flags, variables and config values, a payment on
 * `stellar:pubnet` is refused and the signer is never called.
 *
 * On the opt-in branch (B18 O2) `--mainnet` is an allow path, when every rule
 * of the opt-in holds; one of those rules is an adapter whose key signs only
 * through Wasit's signed-terms gate. The chain here has none, so even a run
 * whose other rules all hold is refused at its plan, before the target is
 * asked anything: the property stays "never signed, never paid".
 *
 * The chain installed into the built core stands in for Stellar's adapter and
 * opens every gate that is not Wasit's own: it takes any key, its RPC answers
 * the mainnet passphrase, its scheme signs whatever it is asked and records it,
 * and the paywall settles every paid request. A control run on stellar:testnet
 * shows the recorder sees a signature when one is made.
 *
 * Seeded, so a failure is reproducible: set WASIT_PROPERTY_SEED to the seed in
 * the message. Every key is made up; nothing leaves 127.0.0.1.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { Keypair, Networks } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";

import { setRpcIdentityTransportForTesting } from "@wasit-dev/core/dist/guard/rpc-identity.js";
import { setPaymentChainsForTesting } from "@wasit-dev/core/dist/x402/chains/index.js";
import type { PaymentChain } from "@wasit-dev/core/dist/x402/chains/types.js";

import { executeRun, type RunCommandOptions } from "../../src/run.js";

const PUBNET = "stellar:pubnet";
const TESTNET = "stellar:testnet";
const PUBNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAY_TO = Keypair.random().publicKey();
const PAYER = Keypair.random().publicKey();
const PASSPHRASES: Record<string, string> = { [PUBNET]: Networks.PUBLIC, [TESTNET]: Networks.TESTNET };

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

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)]!;
}

const signed: PaymentRequirements[] = [];

function permissiveStellar(): PaymentChain {
  const asset = (network: string): string => (network === PUBNET ? PUBNET_USDC : TESTNET_USDC);
  return {
    name: "Recording Stellar",
    networks: [TESTNET, PUBNET],
    payerKeyEnv: "STELLAR_PRIVATE_KEY",
    referenceKind: "a test reference",
    resolveRpcUrl: (network, override) => override || `http://127.0.0.1:9/${network}`,
    registerPayer(client) {
      for (const network of [TESTNET, PUBNET] as const) {
        client.register(network, {
          scheme: "exact",
          findDefaultAsset: (wanted, on) => (on === network && wanted === asset(network) ? { asset: wanted, decimals: 7, symbol: "USDC" } : undefined),
          async createPaymentPayload(version, requirements) {
            signed.push(requirements);
            return { x402Version: version, payload: { signature: `sig-${signed.length}` } };
          },
        });
      }
    },
    expiredSigning: async () => ({ terms: { maxTimeoutSeconds: 1 }, holdMs: 0 }),
    payerAddress: () => PAYER,
    generatePayerKey: () => Keypair.random().secret(),
    payerBalance: async () => 10n ** 30n,
    isSettlementReference: (reference) => reference.startsWith("tx-"),
    verifySettlement: async () => ({ pass: true, detail: "settled (recording chain)" }),
    corruptPayload: (payload) => ({ ...payload, signature: "corrupted" }),
  };
}

interface Wall {
  readonly base: string;
  readonly requests: () => number;
  readonly paid: () => number;
  readonly close: () => Promise<void>;
}

/** Answers every unpaid request with `accepts` and settles every paid one. */
async function wall(accepts: PaymentRequirements[]): Promise<Wall> {
  let requests = 0;
  let paid = 0;
  const server = http.createServer((request, response) => {
    request.on("data", () => undefined);
    request.on("end", () => {
      requests += 1;
      if (typeof request.headers["payment-signature"] === "string" || typeof request.headers["x-payment"] === "string") {
        paid += 1;
        const settled = { success: true, transaction: `tx-${paid}`, network: accepts[0]?.network, payer: PAYER };
        response.writeHead(200, { "content-type": "application/json", "payment-response": Buffer.from(JSON.stringify(settled)).toString("base64") });
        response.end("{}");
        return;
      }
      const challenge = { x402Version: 2, resource: { url: "http://127.0.0.1/paid" }, accepts };
      response.writeHead(402, { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}`,
    requests: () => requests,
    paid: () => paid,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function challengeOption(network: string, amount: bigint): PaymentRequirements {
  return {
    scheme: "exact",
    network: network as PaymentRequirements["network"],
    amount: amount.toString(),
    asset: network === PUBNET ? PUBNET_USDC : TESTNET_USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };
}

async function execute(options: RunCommandOptions, env: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  // The working directory is the test's: a mainnet run takes its lock there.
  const code = await executeRun(options, {
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    cwd: runDir,
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

const PAYMENT_CHECK = /^X402-(0[6-9]|1[01])$/;

let runDir = tmpdir();

describe("no allow path for stellar:pubnet (B11, B12), through wasit run", () => {
  let dir: string;
  let eventFile: string;
  let target: Wall | undefined;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-no-allow-"));
    runDir = dir;
    eventFile = path.join(dir, "event.json");
    await writeFile(eventFile, JSON.stringify({ repository: { default_branch: "main" } }));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    signed.length = 0;
    setPaymentChainsForTesting([permissiveStellar()]);
    setRpcIdentityTransportForTesting(async (url: string, method: string) =>
      method === "getNetwork" ? { passphrase: PASSPHRASES[new URL(url).pathname.slice(1)] ?? Networks.PUBLIC } : undefined,
    );
  });
  afterEach(async () => {
    setPaymentChainsForTesting(undefined);
    setRpcIdentityTransportForTesting(undefined);
    await target?.close();
    target = undefined;
  });

  async function config(network: string, base: string, next: () => number): Promise<string> {
    const file = path.join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
    const environment: Record<string, unknown> = { baseUrl: base, network };
    const operated = pick(next, [true, false, undefined]);
    if (operated !== undefined) environment["operatedByMe"] = operated;
    if (next() < 0.5) environment["pinned"] = { payTo: PAY_TO, asset: network === PUBNET ? PUBNET_USDC : TESTNET_USDC };
    if (next() < 0.5) environment["maxRunUsd"] = pick(next, [0.5, 1, 5]);
    // A key the config may never hold: the loader refuses it, and the run stops there.
    if (next() < 0.15) environment[pick(next, ["mainnet", "optIn", "pubnetOptIn"])] = true;
    const count = 1 + Math.floor(next() * 3);
    const endpoints = Array.from({ length: count }, (_, index) => ({
      name: `e${index}`,
      protocol: "x402",
      path: `/e${index}`,
      method: "GET",
      ...(next() < 0.5 ? { reject: { headers: { "x-lang": "xx" } } } : {}),
    }));
    await writeFile(file, JSON.stringify({ version: 1, defaultEnvironment: "env", environments: { env: environment }, endpoints }));
    return file;
  }

  it("control: the same chain on stellar:testnet signs through wasit run, so the recorder sees a signature when one is made", async () => {
    target = await wall([challengeOption(TESTNET, 100_000n)]);
    const file = path.join(dir, "control.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        defaultEnvironment: "env",
        environments: { env: { baseUrl: target.base, network: TESTNET, operatedByMe: true } },
        endpoints: [{ name: "e0", protocol: "x402", path: "/e0", method: "GET" }],
      }),
    );
    const result = await execute({ config: file, readOnly: false, json: true, start: false }, { STELLAR_PRIVATE_KEY: Keypair.random().secret() });
    assert.ok(signed.length > 0, `the control signed nothing: ${result.stderr}`);
    assert.ok(target.paid() > 0, "the control sent no payment");
  });

  it("refuses every random combination: no signature, no paid request, no payment check passes; --mainnet asks the target nothing", async () => {
    const seed = Number(process.env["WASIT_PROPERTY_SEED"] ?? Date.now() % 2 ** 31);
    const next = random(seed);
    for (let round = 0; round < 40; round += 1) {
      const amount = BigInt(1 + Math.floor(next() * 10_000_000));
      target = await wall(
        pick(next, [[challengeOption(PUBNET, amount)], [challengeOption(PUBNET, amount), challengeOption(TESTNET, amount)]]),
      );
      const file = await config(PUBNET, target.base, next);
      const dryRun = next() < 0.25;
      const readOnly = !dryRun && next() < 0.25;
      const mainnet = next() < 0.5;
      const options: RunCommandOptions = {
        config: file,
        readOnly,
        dryRun,
        mainnet,
        json: !dryRun && next() < 0.5,
        start: false,
      };
      const env: Record<string, string> = {};
      if (next() < 0.6) env["STELLAR_PRIVATE_KEY"] = Keypair.random().secret();
      if (next() < 0.5) env["WASIT_MAINNET_PAYER_SECRET"] = Keypair.random().secret();
      if (next() < 0.3) env["WASIT_MAINNET_OPT_IN"] = pick(next, ["1", "true", "yes"]);
      if (next() < 0.3) env["WASIT_MAINNET_CONFIG"] = file;
      if (next() < 0.3) env["WASIT_RPC_URL"] = pick(next, [`http://127.0.0.1:9/${PUBNET}`, `http://127.0.0.1:9/${TESTNET}`]);
      const event = pick(next, [undefined, "push", "schedule", "workflow_dispatch", "pull_request"]);
      if (event !== undefined) {
        Object.assign(env, { GITHUB_ACTIONS: "true", CI: "true", GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_PATH: eventFile });
      }

      const result = await execute(options, env);
      const label = `seed ${seed}, round ${round}: ${JSON.stringify({ ...options, config: "(file)", env: Object.keys(env) })}`;
      assert.equal(signed.length, 0, `${label}: signed ${signed.length}\n${result.stderr}`);
      assert.equal(target.paid(), 0, `${label}: a paid request reached the target`);
      if (!mainnet || dryRun) assert.doesNotMatch(result.stdout + result.stderr, /MAINNET RUN/, label);
      if (mainnet && !dryRun) {
        assert.equal(result.code, 2, label);
        assert.equal(target.requests(), 0, `${label}: --mainnet let a request through`);
        // Refused before anything: by the flags, the config's loader, the event, or a rule of the opt-in.
        assert.match(result.stderr, /^(wasit run|Invalid wasit\.config\.json)/, label);
        assert.ok(!existsSync(path.join(dir, "wasit-mainnet.lock")), `${label}: the lock was left`);
      }
      // A run that asks to pay on pubnet exits 2. On a pull request the payment tier is the
      // read-only tier (D-022a), which may pass: it pays nothing. A dry run signs nothing and may pass.
      if (mainnet || (!readOnly && !dryRun && event !== "pull_request")) {
        assert.equal(result.code, 2, `${label}: a run that asked to pay on pubnet did not exit 2\n${result.stderr}`);
      }
      if (options.json && result.stdout.startsWith("{")) {
        const report = JSON.parse(result.stdout) as { endpoints: Array<{ results: Array<{ id: string; status: string }> }> };
        for (const endpoint of report.endpoints) {
          for (const entry of endpoint.results) {
            assert.ok(!(PAYMENT_CHECK.test(entry.id) && entry.status === "PASS"), `${label}: ${entry.id} passed`);
          }
        }
      }
      for (const key of [env["STELLAR_PRIVATE_KEY"], env["WASIT_MAINNET_PAYER_SECRET"]]) {
        if (key !== undefined) assert.ok(!(result.stdout + result.stderr).includes(key), `${label}: a key was printed`);
      }
      await target.close();
      target = undefined;
    }
  });
});
