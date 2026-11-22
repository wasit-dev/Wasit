/**
 * `wasit run --mainnet` (spec B5, B18 O2), written before the code (B11).
 *
 * The allow path of the CLI: with `--mainnet`, a pubnet environment with
 * operatedByMe and a USDC pin, the key in WASIT_MAINNET_PAYER_SECRET only, an
 * https RPC that serves pubnet, no other mainnet run holding the lock, and in
 * GitHub Actions the mainnet job rules, the run opens; its first line says
 * MAINNET RUN before anything is started or sent; the plan reads the payer and
 * the chain first; every signature is in the ledger; L4 waits for every
 * authorization to expire and compares the balances after; the lock is
 * released. Anything missing refuses the run, exit 2, before the service
 * starts or the target is asked anything. A refusal during the run stops it:
 * every later check is skipped, and the run exits 2.
 *
 * `--dry-run` on pubnet plans by the mainnet rules with no key and no read of
 * the chain, the RPC or Horizon.
 *
 * Offline: pubnet-world.ts. Every key is made up; nothing leaves 127.0.0.1.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { executeRun, type RunCommandOptions } from "../../src/run.js";
import { PUBNET_RPC, PUBNET_USDC, installPubnetWorld, pubnetOption, pubnetWall, type PubnetWall, type PubnetWorld } from "./pubnet-world.js";

const CENT = 100_000n;

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
const LOCK = "wasit-mainnet.lock";

describe("wasit run --mainnet", () => {
  let dir: string;
  let world: PubnetWorld;
  let wall: PubnetWall | undefined;
  let payer: Keypair;
  let payTo: string;
  let ledgerDir: string;
  let eventFile: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-run-mainnet-"));
    eventFile = path.join(dir, "event.json");
    await writeFile(eventFile, JSON.stringify({ repository: { default_branch: "main" } }));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    world = await installPubnetWorld();
    payer = Keypair.random();
    payTo = Keypair.random().publicKey();
    ledgerDir = path.join(dir, `ledgers-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(async () => {
    await wall?.close();
    wall = undefined;
    await world.close();
  });

  interface EnvironmentShape {
    network?: string;
    operatedByMe?: boolean;
    pinned?: { payTo: string; asset: string } | null;
    rpcUrl?: string | null;
    maxRunUsd?: number;
    baseUrl?: string;
  }

  async function config(
    paths: string[],
    shape: EnvironmentShape = {},
    extra: { service?: { start: string; ready: { url: string; timeoutSeconds: number } }; reject?: boolean } = {},
  ): Promise<string> {
    const file = path.join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
    const environment: Record<string, unknown> = {
      baseUrl: shape.baseUrl ?? wall!.base,
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
        defaultEnvironment: "mainnet",
        environments: { mainnet: environment },
        ...(extra.service === undefined ? {} : { service: extra.service }),
        endpoints: paths.map((name) => ({
          name,
          protocol: "x402",
          path: `/${name}`,
          method: "GET",
          ...(extra.reject === true ? { reject: { headers: { "x-lang": "xx" } } } : {}),
        })),
      }),
    );
    return file;
  }

  async function run(options: Partial<RunCommandOptions> & { config: string }, env: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const order: string[] = [];
    const code = await executeRun(
      { readOnly: false, json: false, start: false, mainnet: true, ledgerDir, ...options },
      {
        env: { PATH: process.env["PATH"] ?? "", WASIT_MAINNET_PAYER_SECRET: payer.secret(), ...env },
        stdout: (line) => {
          out.push(line);
          order.push(line);
        },
        stderr: (line) => {
          err.push(line);
          order.push(line);
        },
        cwd: dir,
        sleep: world.sleep(10),
      },
    );
    return { code, stdout: out.join("\n"), stderr: err.join("\n"), out, err, order };
  }

  function ledgers(): string[] {
    return existsSync(ledgerDir) ? readdirSync(ledgerDir).filter((name) => name.startsWith("wasit-ledger-")) : [];
  }

  function readLedger(): Record<string, unknown> {
    const [name] = ledgers();
    assert.ok(name !== undefined, "no ledger was written");
    return JSON.parse(readFileSync(path.join(ledgerDir, name), "utf8")) as Record<string, unknown>;
  }

  /** Nothing was asked of the target, nothing signed, no ledger written, no lock left. */
  function untouched(result: { code: number }, label = ""): void {
    assert.equal(result.code, 2, label);
    assert.equal(wall?.requests ?? 0, 0, `${label}: the target was asked`);
    assert.equal(world.signed.length, 0, `${label}: signed`);
    assert.deepEqual(ledgers(), [], `${label}: a ledger was written`);
    assert.ok(!existsSync(path.join(ledgerDir, LOCK)), `${label}: the lock was left`);
  }

  describe("refused before anything is started or sent", () => {
    beforeEach(async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
    });

    it("--mainnet with --read-only: choose one", async () => {
      const result = await run({ config: await config(["weather"]), readOnly: true });
      untouched(result);
      assert.match(result.stderr, /--mainnet .*--read-only/);
    });

    it("--ledger-dir without --mainnet: no ledger is written there", async () => {
      const result = await run({ config: await config(["weather"]), mainnet: false, readOnly: true });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /--ledger-dir is for a --mainnet run/);
      assert.equal(wall!.requests, 0);
    });

    it("an environment that is not on stellar:pubnet", async () => {
      const result = await run({ config: await config(["weather"], { network: "stellar:testnet", pinned: null, rpcUrl: null }) });
      untouched(result);
      assert.match(result.stderr, /^wasit run --mainnet: A mainnet run is on stellar:pubnet only/);
    });

    it("no WASIT_MAINNET_PAYER_SECRET: a testnet key variable is never used instead", async () => {
      const testnetKey = Keypair.random().secret();
      const result = await run({ config: await config(["weather"]) }, { WASIT_MAINNET_PAYER_SECRET: "", STELLAR_PRIVATE_KEY: testnetKey });
      untouched(result);
      assert.match(result.stderr, /WASIT_MAINNET_PAYER_SECRET is not set/);
      assert.ok(!result.stderr.includes(testnetKey));
    });

    it("the mainnet key is also the value of a testnet key variable: a dedicated account only", async () => {
      const result = await run({ config: await config(["weather"]) }, { STELLAR_PRIVATE_KEY: payer.secret() });
      untouched(result);
      assert.match(result.stderr, /same key as STELLAR_PRIVATE_KEY/);
      assert.ok(!result.stderr.includes(payer.secret()));
    });

    it("operatedByMe not true, no pin, a pin that is not USDC, the payer as the payee", async () => {
      const cases: Array<[string, EnvironmentShape, RegExp]> = [
        ["operatedByMe", { operatedByMe: false }, /operatedByMe is not true/],
        ["no pin", { pinned: null }, /needs pinned\.payTo and pinned\.asset/],
        ["not USDC", { pinned: { payTo, asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" } }, /must be CCW67/],
        ["self", { pinned: { payTo: payer.publicKey(), asset: PUBNET_USDC } }, /payer's own address/],
      ];
      for (const [label, shape, message] of cases) {
        const result = await run({ config: await config(["weather"], shape) });
        untouched(result, label);
        assert.match(result.stderr, message, label);
      }
    });

    it("no RPC (pubnet has no default), or one that is not https", async () => {
      const none = await run({ config: await config(["weather"], { rpcUrl: null }) });
      untouched(none, "none");
      assert.match(none.stderr, /needs an RPC for stellar:pubnet/);
      const plain = await run({ config: await config(["weather"], { rpcUrl: null }) }, { WASIT_RPC_URL: "http://rpc.example/stellar:pubnet" });
      untouched(plain, "http");
      assert.match(plain.stderr, /https/);
    });

    it("another mainnet run holds the lock in the ledger's folder", async () => {
      await mkdir(ledgerDir, { recursive: true });
      await writeFile(path.join(ledgerDir, LOCK), JSON.stringify({ wasit: "mainnet-run-lock", pid: process.pid, startedAt: new Date().toISOString(), token: "x" }));
      const result = await run({ config: await config(["weather"]) });
      assert.equal(result.code, 2);
      assert.equal(wall!.requests, 0);
      assert.equal(world.signed.length, 0);
      assert.match(result.stderr, /Another mainnet run .* holds/);
      assert.ok(existsSync(path.join(ledgerDir, LOCK)), "another run's lock was deleted");
    });

    it("does not start the service when it refuses", async () => {
      const marker = path.join(dir, `started-${Math.random().toString(36).slice(2)}`);
      const file = await config(["weather"], { pinned: null }, {
        service: { start: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, '1')"`, ready: { url: `${wall!.base}/weather`, timeoutSeconds: 5 } },
      });
      const result = await run({ config: file, start: true });
      untouched(result);
      assert.ok(!existsSync(marker), "the service was started");
    });

    it("the payment tier on pubnet without --mainnet: refused, and says to add --mainnet", async () => {
      const result = await run({ config: await config(["weather"]), mainnet: false, ledgerDir: undefined });
      untouched(result);
      assert.match(result.stderr, /stellar:pubnet is Stellar mainnet: a paying run there needs --mainnet/);
    });

    it("in GitHub Actions on push, schedule or pull_request: refused outright, never run as the read-only tier", async () => {
      for (const event of ["push", "schedule", "pull_request"]) {
        const result = await run(
          { config: await config(["weather"]) },
          { GITHUB_ACTIONS: "true", CI: "true", GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_PATH: eventFile, RUNNER_ENVIRONMENT: "github-hosted" },
        );
        untouched(result, event);
        assert.match(result.stderr, /workflow_dispatch/, event);
      }
    });

    it("in GitHub Actions on workflow_dispatch: the job rules hold (a local baseUrl, a service started in the job)", async () => {
      const env = { GITHUB_ACTIONS: "true", CI: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_PATH: eventFile, RUNNER_ENVIRONMENT: "github-hosted", GITHUB_WORKSPACE: dir };
      const local = await run({ config: await config(["weather"]) }, env);
      untouched(local, "local");
      assert.match(local.stderr, /baseUrl is a local address/);
      const file = await config(["weather"], {}, { service: { start: "node -e 0", ready: { url: `${wall!.base}/weather`, timeoutSeconds: 5 } } });
      const started = await run({ config: file, start: true }, env);
      untouched(started, "service");
      assert.match(started.stderr, /starts a service in the job/);
    });

    it("--mainnet with --dry-run on a test network: refused too, --mainnet is for stellar:pubnet only", async () => {
      const result = await run({ config: await config(["weather"], { network: "stellar:testnet", pinned: null, rpcUrl: null }), dryRun: true, ledgerDir: undefined });
      untouched(result);
      assert.match(result.stderr, /^wasit run --mainnet: A mainnet run is on stellar:pubnet only, and environment mainnet is on another network/);
    });

    it("in GitHub Actions on a pull request without any key: refused outright, and says a mainnet run is started by hand", async () => {
      const result = await run(
        { config: await config(["weather"]) },
        { WASIT_MAINNET_PAYER_SECRET: "", GITHUB_ACTIONS: "true", CI: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge", GITHUB_EVENT_PATH: eventFile },
      );
      untouched(result);
      assert.match(result.stderr, /^wasit run --mainnet: this run may not pay \(pull request\)\. In GitHub Actions a mainnet run is started by hand/);
    });

    it("in GitHub Actions, the mainnet key on a run that may not pay: the advice names the mainnet job, not a testnet secret", async () => {
      const result = await run(
        { config: await config(["weather"]) },
        { GITHUB_ACTIONS: "true", CI: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/feature", GITHUB_EVENT_PATH: eventFile, RUNNER_ENVIRONMENT: "github-hosted" },
      );
      untouched(result);
      assert.match(result.stderr, /not the default branch main/);
      assert.match(result.stderr, /WASIT_MAINNET_PAYER_SECRET belongs only to a mainnet job started by hand/);
      assert.doesNotMatch(result.stderr, /WASIT_TESTNET_PAYER/);
    });

    it("in GitHub Actions: the job's folders are read (node_modules in the config's directory)", async () => {
      const configDir = await mkdtemp(path.join(dir, "gha-"));
      await mkdir(path.join(configDir, "node_modules"));
      const file = path.join(configDir, "wasit.config.json");
      await writeFile(file, readFileSync(await config(["weather"], { baseUrl: "https://api.example.com" }), "utf8"));
      const result = await run(
        { config: file },
        { GITHUB_ACTIONS: "true", CI: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_PATH: eventFile, RUNNER_ENVIRONMENT: "github-hosted" },
      );
      untouched(result);
      assert.match(result.stderr, /a node_modules directory is in the config's directory/);
      assert.doesNotMatch(result.stderr, /baseUrl is a local address/);
    });

    it("never prints the key, on any refusal", async () => {
      for (const shape of [{ pinned: null }, { rpcUrl: null }, { operatedByMe: false }] as EnvironmentShape[]) {
        const result = await run({ config: await config(["weather"], shape) });
        assert.ok(!(result.stdout + result.stderr).includes(payer.secret()));
      }
    });
  });

  describe("the run", () => {
    const order: Array<[string, string]> = [];
    beforeEach(() => {
      order.length = 0;
    });

    it("says MAINNET RUN in its first line, before anything else is printed, then plans, pays, waits, and closes the ledger", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      // The settlements leave the payer's USDC on Horizon once the run has paid: X402-06's cent and the half cent
      // of X402-09, whose underpayment the stand-in paywall serves and settles. Both are verified: consistent.
      const sleep = world.sleep(10);
      let moved = false;
      const result = await executeRun(
        { config: await config(["weather"]), readOnly: false, json: false, start: false, mainnet: true, ledgerDir },
        {
          env: { PATH: process.env["PATH"] ?? "", WASIT_MAINNET_PAYER_SECRET: payer.secret() },
          stdout: (line) => order.push(["out", line]),
          stderr: (line) => order.push(["err", line]),
          cwd: dir,
          sleep: async (ms) => {
            if (!moved) {
              moved = true;
              world.state.horizonUsdc = world.state.horizonUsdc! - CENT - CENT / 2n;
              world.state.rpcUsdc = world.state.horizonUsdc;
            }
            await sleep(ms);
          },
        },
      );
      const lines = order.map(([, line]) => line);
      assert.ok(lines[0]?.startsWith("MAINNET RUN on stellar:pubnet: real funds. "), lines.join("\n"));
      assert.equal(order[0]?.[0], "out");
      assert.ok(lines[0]!.includes(`Payer ${payer.publicKey()}`));
      assert.ok(lines[0]!.includes(`pays only ${payTo} in USDC`));
      assert.ok(lines.some((line) => /^MAINNET RUN on stellar:pubnet: .*this run could spend up to \$0\.035 of the \$5\.00 cap\.$/.test(line)), lines.join("\n"));
      assert.ok(lines.some((line) => line.startsWith("Ledger: ")), lines.join("\n"));
      assert.ok(lines.some((line) => /^Ledger: consistent/.test(line)), lines.slice(-6).join("\n"));
      // The stand-in paywall serves every paid request, so X402-07 to 10 FAIL: the verdict is the checks' own (exit 1),
      // since the run did not stop and its ledger is consistent.
      assert.equal(result, 1, lines.slice(-4).join("\n"));
      assert.ok(lines.some((line) => /^Note: Run ledger wasit-ledger-.*: consistent/.test(line)));
      assert.ok(world.signed.length > 0);
      for (const signed of world.signed) {
        assert.equal(signed.network, "stellar:pubnet");
        assert.equal(signed.payTo, payTo);
        assert.equal(signed.asset, PUBNET_USDC);
      }
      const file = readLedger();
      assert.equal(file["result"], "consistent", JSON.stringify(file["reasons"]));
      assert.equal((file["entries"] as unknown[]).length, world.signed.length);
      assert.ok(file["balancesAfter"] !== undefined);
      assert.ok(!existsSync(path.join(ledgerDir, LOCK)), "the lock was not released");
      // The plan read the payer and the chain before the target was asked anything.
      assert.ok(world.reads.includes("payerBalance") && world.reads.includes("assetDecimals"));
    });
    it("with --start, the MAINNET RUN line comes before the service's own lines", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      // The service prints first and answers its ready URL only later: its line is in before the run goes on.
      const port = await freePort();
      const script = path.join(dir, `service-${port}.mjs`);
      await writeFile(
        script,
        `import http from "node:http";\nconsole.log("service says hello");\n` +
          `setTimeout(() => http.createServer((q, s) => { s.writeHead(404); s.end(); }).listen(${port}, "127.0.0.1"), 300);\n`,
      );
      const file = await config(["weather"], {}, {
        service: { start: `node ${JSON.stringify(script)}`, ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 10 } },
      });
      const result = await run({ config: file, start: true });
      assert.ok(result.order[0]?.startsWith("MAINNET RUN on stellar:pubnet: real funds. "), result.order.slice(0, 3).join("\n"));
      const hello = result.order.findIndex((line) => line.includes("service says hello"));
      assert.ok(hello > 0, result.order.slice(0, 5).join("\n"));
    });

    it("pays with WASIT_MAINNET_PAYER_SECRET only: a testnet key set beside it is never used", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      const result = await run({ config: await config(["weather"]), json: true }, { STELLAR_PRIVATE_KEY: Keypair.random().secret() });
      assert.ok(world.signed.length > 0, result.stderr);
      assert.doesNotMatch(result.stderr, /the run stopped/);
      const report = JSON.parse(result.stdout) as { endpoints: Array<{ results: Array<{ id: string; status: string }> }> };
      assert.equal(report.endpoints[0]?.results.find((entry) => entry.id === "X402-06")?.status, "PASS");
    });

    it("exits 2 when the run stopped, even after a FAIL it found before the stop", async () => {
      wall = await pubnetWall({ "/a": [pubnetOption(payTo, CENT)] });
      // X402-06 and X402-07 are paid (07's corrupted payment is accepted: FAIL); then the payee changes and L2 stops the run.
      wall.onChallenge = (at) => {
        if (at === "/a" && (wall!.paid.get("/a") ?? 0) >= 2) wall!.accepts.set("/a", [pubnetOption(Keypair.random().publicKey(), CENT)]);
      };
      const result = await run({ config: await config(["a"]), json: true });
      const report = JSON.parse(result.stdout) as { endpoints: Array<{ results: Array<{ id: string; status: string }> }> };
      const statuses = report.endpoints[0]!.results.map((entry) => `${entry.id} ${entry.status}`);
      assert.ok(statuses.includes("X402-07 FAIL"), statuses.join(", "));
      assert.match(result.stderr, /the run stopped/);
      assert.equal(result.code, 2, statuses.join(", "));
    });

    it("exits by the checks when the ledger is explained: more USDC left than was verified, within the FAILed checks' payments", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      // The service settles X402-09's half cent, but the chain shows no such transfer for it: unverified, and X402-09 FAILs.
      world.state.unverified.add(CENT / 2n);
      const sleep = world.sleep(10);
      let moved = false;
      const lines: string[] = [];
      const result = await executeRun(
        { config: await config(["weather"]), readOnly: false, json: false, start: false, mainnet: true, ledgerDir },
        {
          env: { PATH: process.env["PATH"] ?? "", WASIT_MAINNET_PAYER_SECRET: payer.secret() },
          stdout: (line) => lines.push(line),
          stderr: (line) => lines.push(line),
          cwd: dir,
          sleep: async (ms) => {
            if (!moved) {
              moved = true;
              world.state.horizonUsdc = world.state.horizonUsdc! - CENT - CENT / 2n;
              world.state.rpcUsdc = world.state.horizonUsdc;
            }
            await sleep(ms);
          },
        },
      );
      assert.equal(result, 1, lines.slice(-6).join("\n"));
      assert.ok(lines.some((line) => /^Ledger: explained: The payer's USDC went down by 150000 base units: 100000 in the settlements this run verified, and 50000 more/.test(line)), lines.slice(-6).join("\n"));
      assert.ok(lines.some((line) => /^Note: Run ledger wasit-ledger-.*: explained/.test(line)));
      assert.ok(!lines.some((line) => /the run ledger is not consistent/.test(line)));
      const file = readLedger();
      assert.equal(file["result"], "explained", JSON.stringify(file["reasons"]));
      const entries = file["entries"] as Array<{ check: string; verdict?: string; settlement?: { verified: boolean } }>;
      assert.deepEqual(entries.find((entry) => entry.check === "X402-09")?.settlement?.verified, false);
      assert.equal(entries.find((entry) => entry.check === "X402-09")?.verdict, "fail");
    });

    it("exits 2 when the ledger is not consistent: the payer's USDC did not move as the settlements say", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      const result = await run({ config: await config(["weather"]) });
      assert.equal(result.code, 2, result.stdout);
      assert.match(result.stdout, /Ledger: INCONSISTENT/);
      assert.equal(readLedger()["result"], "inconsistent");
      assert.ok(!existsSync(path.join(ledgerDir, LOCK)));
    });

    it("with --json: the report alone on stdout, the MAINNET RUN lines first on stderr", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      const result = await run({ config: await config(["weather"]), json: true });
      const report = JSON.parse(result.stdout) as { network: string; notes: string[] };
      assert.equal(report.network, "stellar:pubnet");
      assert.ok(result.err[0]?.startsWith("MAINNET RUN on stellar:pubnet: real funds. "), result.stderr);
      assert.ok(report.notes.some((note) => /MAINNET payment on stellar:pubnet: real funds/.test(note)), JSON.stringify(report.notes));
      assert.ok(report.notes.some((note) => /^Run ledger wasit-ledger-/.test(note)), JSON.stringify(report.notes));
    });

    it("a plan that is refused: the plan on stderr, exit 2, nothing signed, no ledger, the lock released", async () => {
      wall = await pubnetWall({ "/a": [pubnetOption(payTo, 10_000_000n)], "/b": [pubnetOption(payTo, 10_000_000n)] });
      const result = await run({ config: await config(["a", "b"]) });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /could spend up to \$7\.00/);
      assert.equal(world.signed.length, 0);
      assert.equal([...wall.paid.values()].reduce((sum, count) => sum + count, 0), 0);
      assert.deepEqual(ledgers(), []);
      assert.ok(!existsSync(path.join(ledgerDir, LOCK)));
    });

    it("a payer holding more than $10 of USDC: refused at the plan, before the target is asked", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      world.state.rpcUsdc = 100_000_001n;
      world.state.horizonUsdc = 100_000_001n;
      const result = await run({ config: await config(["weather"]) });
      untouched(result);
      assert.match(result.stderr, /\$10/);
    });

    it("a refusal during the run stops it: later checks and later endpoints are skipped with the reason, exit 2", async () => {
      wall = await pubnetWall({ "/a": [pubnetOption(payTo, CENT)], "/b": [pubnetOption(payTo, CENT)] });
      const other = Keypair.random().publicKey();
      // After the plan read /a once, /a names another payee: L2 refuses and the run stops.
      wall.onChallenge = (at, count) => {
        if (at === "/a" && count >= 2) wall!.accepts.set("/a", [pubnetOption(other, CENT)]);
      };
      const result = await run({ config: await config(["a", "b"]), json: true });
      assert.equal(result.code, 2, result.stderr);
      for (const signed of world.signed) assert.equal(signed.payTo, payTo);
      assert.equal(wall.paid.get("/b") ?? 0, 0, "endpoint b was paid after the run stopped");
      const report = JSON.parse(result.stdout) as { endpoints: Array<{ name: string; results: Array<{ id: string; status: string; detail?: string }> }> };
      const b = report.endpoints.find((endpoint) => endpoint.name === "b")!;
      assert.ok(b.results.length > 0);
      for (const entry of b.results) {
        assert.equal(entry.status, "SKIP", JSON.stringify(entry));
        assert.match(entry.detail ?? "", /the mainnet run stopped/);
      }
      assert.match(result.stderr, /stopped/);
      assert.ok(readLedger()["closedAt"] !== undefined, "the ledger was not closed");
      assert.ok(!existsSync(path.join(ledgerDir, LOCK)));
    });

    it("writes the ledger where --ledger-dir says, and the lock beside it", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      const custom = path.join(dir, `custom-${Math.random().toString(36).slice(2)}`);
      const result = await run({ config: await config(["weather"]), ledgerDir: custom });
      assert.ok(readdirSync(custom).some((name) => name.startsWith("wasit-ledger-")), result.stdout);
    });

    it("defaults the ledger folder to the working directory", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      const cwd = await mkdtemp(path.join(dir, "cwd-"));
      await executeRun(
        { config: await config(["weather"]), readOnly: false, json: false, start: false, mainnet: true },
        { env: { PATH: process.env["PATH"] ?? "", WASIT_MAINNET_PAYER_SECRET: payer.secret() }, stdout: () => undefined, stderr: () => undefined, cwd, sleep: world.sleep(10) },
      );
      assert.ok(readdirSync(cwd).some((name) => name.startsWith("wasit-ledger-")));
    });

    it("the canary: the key, its raw seed in hex and in base64, are in no output, the ledger or the report", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      const out = path.join(dir, `report-${Math.random().toString(36).slice(2)}.json`);
      const result = await run({ config: await config(["weather"]), json: true, out });
      const seed = Buffer.from(StrKey.decodeEd25519SecretSeed(payer.secret()));
      const [name] = ledgers();
      const written = [result.stdout, result.stderr, readFileSync(out, "utf8"), readFileSync(path.join(ledgerDir, name!), "utf8")].join("\n");
      for (const form of [payer.secret(), seed.toString("hex"), seed.toString("base64")]) {
        assert.ok(!written.includes(form), `found ${form.slice(0, 4)}...`);
      }
    });
  });

  describe("--dry-run on stellar:pubnet", () => {
    it("plans by the mainnet rules with no key read: nothing of the payer, the chain, the RPC or Horizon", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      for (const mainnet of [false, true]) {
        const result = await run({ config: await config(["weather"], {}, { reject: true }), dryRun: true, mainnet, ledgerDir: undefined });
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /Plan \(dry run\): x402 payment checks on stellar:pubnet/);
        assert.ok(result.stdout.includes(`pays "${payTo}"`), result.stdout);
        assert.match(result.stdout, /Mainnet dry run: no key is read/);
        assert.ok(!result.stdout.includes(payer.publicKey()), "the dry run derived the payer from the key");
        assert.doesNotMatch(result.stdout + result.stderr, /MAINNET RUN/);
      }
      assert.deepEqual(world.reads, []);
      assert.deepEqual(world.horizonRequests, []);
      assert.deepEqual(world.identityCalls, []);
      assert.equal(world.signed.length, 0);
      assert.equal([...wall.paid.values()].length, 0);
      assert.deepEqual(ledgers(), []);
    });

    it("says what a paid run still needs, and exits 2 when a paid run would be refused", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT, { maxTimeoutSeconds: 301 })] });
      const result = await run({ config: await config(["weather"], { rpcUrl: null }), dryRun: true, ledgerDir: undefined }, { WASIT_MAINNET_PAYER_SECRET: "" });
      assert.equal(result.code, 2);
      assert.match(result.stdout, /could not be planned/);
      assert.match(result.stdout, /--mainnet/);
      assert.match(result.stdout, /WASIT_MAINNET_PAYER_SECRET/);
      assert.match(result.stdout, /no RPC/);
    });

    it("exits 2 when no RPC is set, though every endpoint plans: a paying run would be refused", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      const result = await run({ config: await config(["weather"], { rpcUrl: null }), dryRun: true, ledgerDir: undefined });
      assert.equal(result.code, 2, result.stdout);
      assert.match(result.stdout, /no RPC is set, so a paying run would be refused/);
      assert.doesNotMatch(result.stdout, /could not be planned/);
    });

    it("without a pin: refused, exit 2", async () => {
      wall = await pubnetWall({ "/weather": [pubnetOption(payTo, CENT)] });
      const result = await run({ config: await config(["weather"], { pinned: null }), dryRun: true, ledgerDir: undefined });
      assert.equal(result.code, 2);
      assert.match(result.stdout, /needs pinned\.payTo and pinned\.asset/);
    });
  });
});
