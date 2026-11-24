/**
 * MPP in `wasit run` (W3-1; spec B9; D-036): charge (MPP-01) and channel
 * (MPP-10, 11, 12, 14) in the payment tier, on `stellar:testnet` only, with the
 * same rules as x402: the GitHub event, `operatedByMe`, the key variable
 * (`MPP_PAYER_SECRET`, `COMMITMENT_SECRET_HEX`), the plan and one budget for
 * the run. MPP-13 is never run from a config. The network and the channel come
 * from the config, never from `MPP_STELLAR_NETWORK` or `CHANNEL_CONTRACT`.
 *
 * Written before the code (CONTEXT rule 3). The charge target is the official
 * @stellar/mpp charge server in process; the RPC is an https address on
 * 127.0.0.1 that answers nothing, so the SDK fails before it signs; the RPC
 * identity check is a stand-in that says testnet. Nothing leaves 127.0.0.1 and
 * no key holds funds.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { Keypair, Networks } from "@stellar/stellar-sdk";
import { Mppx, Store, charge } from "@stellar/mpp/charge/server";
import { setRpcIdentityTransportForTesting } from "@wasit-dev/core/dist/guard/rpc-identity.js";

import { executeRun, type RunCommandOptions } from "../../src/run.js";

const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const RECIPIENT = Keypair.random().publicKey();

interface Target {
  readonly base: string;
  /** Requests received, by path. */
  readonly requests: Map<string, number>;
  /** Requests that carried a credential (a payment or a commitment), by path. */
  readonly credentials: Map<string, number>;
  total(): number;
  close(): Promise<void>;
}

/**
 * One server on loopback: under /charge/<price> the official charge server for
 * <price> USDC on testnet, under /stream a 402 with no channel challenge
 * (enough for the channel suite to run and find nothing it can grade), anything
 * else 200.
 */
async function target(): Promise<Target> {
  const requests = new Map<string, number>();
  const credentials = new Map<string, number>();
  const listeners = new Map<string, http.RequestListener>();
  const mppx = Mppx.create({
    secretKey: "wasit-unit-test-challenge-secret",
    methods: [charge({ recipient: RECIPIENT, currency: USDC_SAC, network: "stellar:testnet", store: Store.memory() })],
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.set(url.pathname, (requests.get(url.pathname) ?? 0) + 1);
    if (req.headers.authorization) credentials.set(url.pathname, (credentials.get(url.pathname) ?? 0) + 1);
    const priced = /^\/charge\/([0-9.]+)$/.exec(url.pathname);
    if (priced !== null) {
      const amount = priced[1]!;
      if (!listeners.has(amount)) {
        listeners.set(amount, async (request, response) => {
          const result = await Mppx.toNodeListener(mppx.charge({ amount, currency: USDC_SAC, recipient: RECIPIENT }))(request, response);
          if (result.status !== 402) response.end("paid");
        });
      }
      return listeners.get(amount)!(req, res);
    }
    if (url.pathname === "/stream") {
      res.writeHead(402, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.end("free");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    credentials,
    total: () => [...requests.values()].reduce((sum, count) => sum + count, 0),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** An https RPC address on 127.0.0.1 that counts connections and drops each one: a connection is the SDK at work. */
async function countingRpc() {
  let calls = 0;
  const server = net.createServer((socket) => {
    calls += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `https://127.0.0.1:${port}`,
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface EnvironmentSpec {
  readonly network?: string;
  readonly operatedByMe?: boolean;
  readonly pinned?: { payTo: string; asset: string };
  readonly maxRunUsd?: number;
  readonly rpcUrl?: string;
}

describe("wasit run, MPP", () => {
  let dir: string;
  let site: Target;
  let rpc: Awaited<ReturnType<typeof countingRpc>>;
  let identity: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-run-mpp-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    site = await target();
    rpc = await countingRpc();
    identity = Networks.TESTNET;
    setRpcIdentityTransportForTesting(async () => ({ passphrase: identity }));
  });
  afterEach(async () => {
    setRpcIdentityTransportForTesting(undefined);
    await site.close();
    await rpc.close();
  });

  async function config(endpoints: ReadonlyArray<Record<string, unknown>>, environment: EnvironmentSpec = {}): Promise<string> {
    const file = path.join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        defaultEnvironment: "local",
        environments: {
          local: {
            baseUrl: site.base,
            network: environment.network ?? "stellar:testnet",
            operatedByMe: environment.operatedByMe ?? true,
            rpcUrl: environment.rpcUrl ?? rpc.url,
            ...(environment.pinned === undefined ? {} : { pinned: environment.pinned }),
            ...(environment.maxRunUsd === undefined ? {} : { maxRunUsd: environment.maxRunUsd }),
          },
        },
        endpoints,
      }),
    );
    return file;
  }

  const CHAT = { name: "chat", protocol: "mpp-charge", path: "/charge/0.001" };
  const STREAM = { name: "stream", protocol: "mpp-channel", path: "/stream" };
  const PAYER = { MPP_PAYER_SECRET: Keypair.random().secret() };
  const COMMITMENT = { COMMITMENT_SECRET_HEX: randomBytes(32).toString("hex") };

  async function run(options: Partial<RunCommandOptions> & { config: string }, env: Record<string, string> = {}) {
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

  function results(report: any, endpoint: string): Array<{ id: string; status: string; skipKind?: string; detail: string; errorKind?: string }> {
    assert.ok(report, "no report");
    const found = report.endpoints.find((entry: any) => entry.name === endpoint);
    assert.ok(found, `no endpoint ${endpoint} in the report`);
    return found.results;
  }

  function result(report: any, endpoint: string, id: string) {
    const found = results(report, endpoint).find((entry) => entry.id === id);
    assert.ok(found, `no ${id} for ${endpoint}: ${JSON.stringify(results(report, endpoint))}`);
    return found;
  }

  describe("MPP-01 (charge)", () => {
    it("pays with MPP_PAYER_SECRET on stellar:testnet: planned, charged to the run's cap, built through the run's RPC", async () => {
      const run1 = await run({ config: await config([CHAT]) }, PAYER);
      const mpp = result(run1.report, "chat", "MPP-01");
      // The RPC stand-in answers nothing, so the SDK fails after the charge and before it signs. MPP-01 has
      // reported a failed payment attempt as a FAIL since 0.7.0 (charge.ts); what matters here is where it went.
      assert.ok(mpp.status === "FAIL" || mpp.status === "ERROR", mpp.detail);
      assert.doesNotMatch(mpp.detail, /plan|cap/);
      assert.ok(rpc.calls() > 0, "the SDK never reached the run's RPC");
      assert.equal(site.credentials.get("/charge/0.001") ?? 0, 0);
      const notes: string[] = run1.report.notes;
      assert.ok(notes.some((note) => /^Tier: payment on stellar:testnet\. The run charged \$0\.001 of the \$5\.00 cap/.test(note)), notes.join(" | "));
      assert.match(run1.stderr, /Payment tier on stellar:testnet \(test network\): test funds\./);
      assert.match(run1.stderr, /MPP-01 10000 \(base units\)/);
      assert.notEqual(run1.code, 0);
    });

    it("skips MPP-01 as needs-payer without MPP_PAYER_SECRET, asks the target nothing, and exits 2", async () => {
      const run1 = await run({ config: await config([CHAT]) });
      const mpp = result(run1.report, "chat", "MPP-01");
      assert.equal(mpp.status, "SKIP");
      assert.equal(mpp.skipKind, "needs-payer");
      assert.match(mpp.detail, /set MPP_PAYER_SECRET on the Wasit step/);
      assert.equal(site.total(), 0);
      assert.equal(run1.code, 2);
      const notes: string[] = run1.report.notes;
      assert.ok(notes.some((note) => /^MPP charge: the payment checks were not run: no payer key: set MPP_PAYER_SECRET on the Wasit step\.$/.test(note)), notes.join(" | "));
    });

    it("refuses MPP-01 priced above $1 a payment, signing nothing, and still runs the other endpoints", async () => {
      const run1 = await run({ config: await config([{ ...CHAT, name: "pricey", path: "/charge/1.5" }, CHAT]) }, PAYER);
      const pricey = result(run1.report, "pricey", "MPP-01");
      assert.equal(pricey.status, "ERROR");
      assert.match(pricey.detail, /above the \$1\.00 per payment fixed in Wasit/);
      assert.equal(site.credentials.get("/charge/1.5") ?? 0, 0);
      assert.doesNotMatch(result(run1.report, "chat", "MPP-01").detail, /plan|cap/, "chat was refused too");
      assert.ok(rpc.calls() > 0, "chat was not attempted");
    });

    it("refuses the whole run before anything is signed when the sum is above maxRunUsd", async () => {
      const run1 = await run(
        { config: await config([CHAT, { ...CHAT, name: "chat2", path: "/charge/0.0011" }], { maxRunUsd: 0.0015 }) },
        PAYER,
      );
      assert.equal(run1.code, 2);
      assert.match(run1.stderr, /This run could spend up to \$0\.0021 \(chat \$0\.001, chat2 \$0\.0011\), above the \$0\.0015 per run set by maxRunUsd/);
      assert.equal(run1.report, undefined, "a refused run writes no report");
      assert.equal(rpc.calls(), 0);
      assert.equal([...site.credentials.values()].length, 0);
    });

    it("holds MPP-01 to the environment's pin", async () => {
      const other = Keypair.random().publicKey();
      const run1 = await run({ config: await config([CHAT], { pinned: { payTo: other, asset: USDC_SAC } }) }, PAYER);
      const mpp = result(run1.report, "chat", "MPP-01");
      assert.equal(mpp.status, "ERROR");
      assert.match(mpp.detail, new RegExp(`not the pinned ${other}`));
      assert.equal(rpc.calls(), 0);
    });

    it("reads neither MPP_STELLAR_NETWORK nor CHANNEL_CONTRACT: the network is the config's", async () => {
      const run1 = await run({ config: await config([CHAT]) }, { ...PAYER, MPP_STELLAR_NETWORK: "stellar:pubnet" });
      const mpp = result(run1.report, "chat", "MPP-01");
      assert.doesNotMatch(mpp.detail, /pubnet/);
      assert.ok(rpc.calls() > 0, "MPP-01 did not pay on the config's network");
    });
  });

  describe("MPP-10, 11, 12, 14 (channel)", () => {
    it("runs the channel checks with COMMITMENT_SECRET_HEX, and never MPP-13", async () => {
      const run1 = await run({ config: await config([STREAM]) }, COMMITMENT);
      const ids = results(run1.report, "stream").map((entry) => entry.id);
      assert.deepEqual(ids, ["MPP-10", "MPP-11", "MPP-12", "MPP-14"]);
      for (const entry of results(run1.report, "stream")) {
        assert.notEqual(entry.skipKind, "needs-payer", entry.id);
        assert.notEqual(entry.skipKind, "not-applicable", entry.id);
      }
      assert.ok((site.requests.get("/stream") ?? 0) > 0, "the channel suite asked the target nothing");
    });

    it("skips the channel checks as needs-payer without COMMITMENT_SECRET_HEX, and exits 2", async () => {
      const run1 = await run({ config: await config([STREAM]) });
      const entries = results(run1.report, "stream");
      assert.deepEqual(entries.map((entry) => entry.id), ["MPP-10", "MPP-11", "MPP-12", "MPP-14"]);
      for (const entry of entries) {
        assert.equal(entry.skipKind, "needs-payer");
        assert.match(entry.detail, /set COMMITMENT_SECRET_HEX on the Wasit step/);
      }
      assert.equal(site.total(), 0);
      assert.equal(run1.code, 2);
    });

    it("uses the config's channel and expectations, never CHANNEL_CONTRACT", async () => {
      const run1 = await run({ config: await config([STREAM]) }, { ...COMMITMENT, CHANNEL_CONTRACT: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" });
      const deploy = result(run1.report, "stream", "MPP-10");
      assert.doesNotMatch(deploy.detail, /CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC/);
    });
  });

  describe("what MPP does not run", () => {
    it("skips MPP as unsupported on a network that is not stellar:testnet", async () => {
      const run1 = await run({ config: await config([CHAT, STREAM], { network: "eip155:84532" }) }, { ...PAYER, ...COMMITMENT });
      for (const [name, id] of [["chat", "MPP-01"], ["stream", "MPP-11"]] as const) {
        const entry = result(run1.report, name, id);
        assert.equal(entry.status, "SKIP");
        assert.equal(entry.skipKind, "unsupported");
        assert.match(entry.detail, /stellar:testnet only/);
      }
      assert.equal(site.total(), 0);
    });

    it("sends nothing to an MPP endpoint with headers, a body or another method: unsupported in this version", async () => {
      const run1 = await run(
        {
          config: await config([
            { ...CHAT, name: "auth", headers: { "x-lang": "en" } },
            { ...CHAT, name: "posted", method: "POST", body: { q: 1 } },
          ]),
        },
        PAYER,
      );
      for (const name of ["auth", "posted"]) {
        const entry = result(run1.report, name, "MPP-01");
        assert.equal(entry.status, "SKIP");
        assert.equal(entry.skipKind, "unsupported");
        assert.match(entry.detail, /plain GET/);
      }
      assert.equal(site.total(), 0);
    });

    it("refuses MPP_PAYER_SECRET or COMMITMENT_SECRET_HEX on a pull request, before anything is sent", async () => {
      const eventFile = path.join(dir, "event.json");
      await writeFile(eventFile, JSON.stringify({ repository: { default_branch: "main" } }));
      const pr = { GITHUB_ACTIONS: "true", CI: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge", GITHUB_EVENT_PATH: eventFile };
      for (const key of [PAYER, COMMITMENT]) {
        const run1 = await run({ config: await config([CHAT, STREAM]) }, { ...pr, ...key });
        assert.equal(run1.code, 2);
        assert.match(run1.stderr, new RegExp(`${Object.keys(key)[0]} is set, and this run may not pay`));
      }
      assert.equal(site.total(), 0);
    });

    it("runs the read-only tier without asking the MPP endpoints anything", async () => {
      const run1 = await run({ config: await config([CHAT, STREAM]), readOnly: true });
      assert.equal(result(run1.report, "chat", "MPP-01").skipKind, "read-only");
      assert.equal(result(run1.report, "stream", "MPP-11").skipKind, "read-only");
      assert.equal(site.total(), 0);
    });

    it("checks the RPC before the service starts or any MPP endpoint is asked", async () => {
      identity = Networks.PUBLIC;
      const run1 = await run({ config: await config([CHAT, STREAM]) }, { ...PAYER, ...COMMITMENT });
      assert.equal(run1.code, 2);
      assert.match(run1.stderr, /RPC/);
      assert.equal(site.total(), 0);
    });

    it("refuses an http RPC for MPP-01 before anything is sent: the SDK pays through https only", async () => {
      const run1 = await run({ config: await config([CHAT], { rpcUrl: "http://127.0.0.1:1" }) }, PAYER);
      assert.equal(run1.code, 2);
      assert.match(run1.stderr, /https/);
      assert.equal(site.total(), 0);
    });
  });

  describe("--dry-run", () => {
    it("plans MPP-01 from the unpaid challenge, reads no key, and pays nothing", async () => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await executeRun(
        { config: await config([CHAT, STREAM]), readOnly: false, json: false, start: false, dryRun: true },
        { env: { PATH: process.env["PATH"] ?? "" }, stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
      );
      const stdout = out.join("\n");
      assert.equal(code, 0, stdout + err.join("\n"));
      assert.match(stdout, /^Plan \(dry run\): MPP-01 on stellar:testnet\. Nothing is signed or sent\.$/m);
      assert.ok(stdout.includes(`chat: pays "${RECIPIENT}" in "${USDC_SAC}", up to $0.001`), stdout);
      assert.match(stdout, /MPP-01 10000 \(base units\)/);
      assert.match(stdout, /stream: not planned: the channel checks sign commitments off-chain/);
      assert.equal(site.requests.get("/stream") ?? 0, 0);
      assert.equal([...site.credentials.values()].length, 0);
      assert.equal(rpc.calls(), 0);
    });
  });
});
