/**
 * `wasit run --dry-run` (spec B5, safety rule 5): L0 and L1 only. It reads each
 * x402 endpoint's unpaid challenge, prints the plan (network, destination,
 * asset, amount per check, caps, worst case) and exits. It needs no key, sends
 * no payment and signs nothing.
 *
 * Exit 0: a paying run could start as planned. Exit 2: it would be refused
 * (worst case above the cap, an endpoint the guard refuses, a network that is
 * not a test network, `operatedByMe` not set).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import { executeRun, type RunCommandOptions } from "../../src/run.js";
import { startPaywall, writeConfig, type Handler, type Paywall } from "./run-helpers.js";

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAY_TO = Keypair.random().publicKey();

function priced(amount: string, payTo = PAY_TO): Handler {
  const header = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "http://127.0.0.1/paid" },
      accepts: [{ scheme: "exact", network: "stellar:testnet", amount, asset: USDC, payTo, maxTimeoutSeconds: 60, extra: {} }],
    }),
  ).toString("base64");
  return (_request, response) => {
    response.writeHead(402, { "payment-required": header, "content-type": "application/json" });
    response.end("{}");
  };
}

async function dryRun(options: Partial<RunCommandOptions> & { config: string }, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await executeRun(
    { readOnly: false, dryRun: true, json: false, start: false, ...options },
    { env: { PATH: process.env["PATH"] ?? "", ...env }, stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
  );
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

describe("wasit run --dry-run", () => {
  let dir: string;
  let paywall: Paywall | undefined;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-dry-run-"));
  });
  after(async () => {
    await paywall?.close();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await paywall?.close();
    paywall = undefined;
  });

  it("prints the plan with no key in the environment, sends only unpaid requests, and exits 0", async () => {
    paywall = await startPaywall(priced("100000"));
    const config = await writeConfig(dir, { baseUrl: paywall.base });
    const result = await dryRun({ config });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Plan \(dry run\): x402 payment checks on stellar:testnet\. Nothing is signed or sent\./);
    assert.match(result.stdout, /Caps: \$1\.00 a payment, \$5\.00 this run\./);
    assert.match(result.stdout, new RegExp(`weather: pays "${PAY_TO}" in "${USDC}", up to \\$0\\.035`));
    assert.match(result.stdout, /X402-06 100000, X402-07 100000, X402-09 50000, X402-10 100000 \(base units\)/);
    assert.match(result.stdout, /Worst case: \$0\.035 of \$5\.00\./);
    assert.ok(paywall.received.length > 0);
    for (const request of paywall.received) {
      assert.equal(request.headers["payment-signature"], undefined, "a dry run sent a payment");
    }
  });

  it("never prints a key that is in the environment", async () => {
    paywall = await startPaywall(priced("100000"));
    const config = await writeConfig(dir, { baseUrl: paywall.base });
    const canary = Keypair.random().secret();
    const result = await dryRun({ config }, { STELLAR_PRIVATE_KEY: canary, WASIT_MAINNET_PAYER_SECRET: canary });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!`${result.stdout}\n${result.stderr}`.includes(canary));
  });

  it("refuses a run whose worst case is above the cap, and exits 2", async () => {
    paywall = await startPaywall(priced("10000000"));
    const config = await writeConfig(dir, {
      baseUrl: paywall.base,
      endpoints: [
        { name: "weather", protocol: "x402", path: "/weather", method: "GET" },
        { name: "summarize", protocol: "x402", path: "/summarize", method: "GET" },
      ],
    });
    const result = await dryRun({ config });
    assert.equal(result.code, 2);
    assert.match(
      result.stdout,
      /Refused: This run could spend up to \$7\.00 \(weather \$3\.50, summarize \$3\.50\), above the \$5\.00 per run\. Nothing was signed\./,
    );
  });

  it("uses the lower cap of maxRunUsd, and the pin, from the config", async () => {
    paywall = await startPaywall(priced("10000000"));
    const config = path.join(dir, "pinned.json");
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        environments: {
          local: {
            baseUrl: paywall.base,
            network: "stellar:testnet",
            operatedByMe: true,
            maxRunUsd: 2,
            pinned: { payTo: PAY_TO, asset: USDC },
          },
        },
        endpoints: [{ name: "weather", protocol: "x402", path: "/weather", method: "GET" }],
      }),
    );
    const result = await dryRun({ config });
    assert.equal(result.code, 2);
    assert.match(result.stdout, /Caps: \$1\.00 a payment, \$2\.00 this run \(maxRunUsd\)\./);
    assert.match(result.stdout, new RegExp(`Pinned: payTo ${PAY_TO}, asset ${USDC}\\.`));
    assert.match(result.stdout, /above the \$2\.00 per run set by maxRunUsd/);
  });

  it("refuses an endpoint off the pin, and exits 2", async () => {
    paywall = await startPaywall(priced("100000", Keypair.random().publicKey()));
    const config = path.join(dir, "off-pin.json");
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        environments: {
          local: { baseUrl: paywall.base, network: "stellar:testnet", operatedByMe: true, pinned: { payTo: PAY_TO, asset: USDC } },
        },
        endpoints: [{ name: "weather", protocol: "x402", path: "/weather", method: "GET" }],
      }),
    );
    const result = await dryRun({ config });
    assert.equal(result.code, 2);
    assert.match(result.stdout, /weather: refused: .*payTo/);
  });

  it("refuses a network that is not a test network before anything is sent", async () => {
    paywall = await startPaywall(priced("100000"));
    const config = await writeConfig(dir, { baseUrl: paywall.base, network: "stellar:pubnet" });
    const result = await dryRun({ config });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /the mainnet opt-in is not part of this version/);
    assert.equal(paywall.received.length, 0);
  });

  it("says a paying run would be refused when operatedByMe is not set", async () => {
    paywall = await startPaywall(priced("100000"));
    const config = path.join(dir, "not-mine.json");
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        environments: { local: { baseUrl: paywall.base, network: "stellar:testnet" } },
        endpoints: [{ name: "weather", protocol: "x402", path: "/weather", method: "GET" }],
      }),
    );
    const result = await dryRun({ config });
    assert.equal(result.code, 2);
    assert.match(result.stdout, /operatedByMe/);
  });

  it("names MPP endpoints as not planned, and sends them nothing", async () => {
    paywall = await startPaywall(priced("100000"));
    const config = await writeConfig(dir, {
      baseUrl: paywall.base,
      endpoints: [
        { name: "weather", protocol: "x402", path: "/weather", method: "GET" },
        { name: "metered", protocol: "mpp-charge", path: "/metered", method: "GET" },
      ],
    });
    const result = await dryRun({ config });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /metered: not planned/);
    assert.ok(paywall.received.every((request) => request.url === "/weather"));
  });

  it("takes neither --read-only nor --json, --out or --baseline", async () => {
    paywall = await startPaywall(priced("100000"));
    const config = await writeConfig(dir, { baseUrl: paywall.base });
    for (const extra of [{ readOnly: true }, { json: true }, { out: path.join(dir, "out.json") }, { baseline: path.join(dir, "b.json") }]) {
      const result = await dryRun({ config, ...extra });
      assert.equal(result.code, 2, JSON.stringify(extra));
      assert.match(result.stderr, /--dry-run/);
    }
    assert.equal(paywall.received.length, 0);
  });
});
