/**
 * `wasit run` and `wasit ci-report` as the built binary (`npm run build`
 * first): what only a real process shows. `.env` loading and CI (spec A8 #2),
 * flags that are not registered, the service stopped on a signal (A8 #1), and
 * the service's environment taken from the real process environment.
 *
 * Runs in an empty temporary directory with an empty HOME. Every key is made up
 * (none can sign); nothing leaves 127.0.0.1. POSIX signals: the signal tests
 * are skipped on Windows, where `--start` has not been run.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import { challengeHeader, freePort, startPaywall, writeConfig } from "./run-helpers.js";

const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const POSIX = process.platform !== "win32";

interface Finished {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function start(args: string[], cwd: string, env: Record<string, string> = {}): { child: ChildProcess; done: Promise<Finished> } {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", HOME: cwd, NO_COLOR: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += chunk));
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  const done = new Promise<Finished>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

const wasit = (args: string[], cwd: string, env: Record<string, string> = {}): Promise<Finished> => start(args, cwd, env).done;

async function waitFor(condition: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("the wasit binary", () => {
  let cwd: string;
  before(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "wasit-run-cli-"));
  });
  after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  describe("flags that are not offered", () => {
    for (const flag of [["--payer-key", "x"], ["--commitment-key", "x"], ["--allow-destructive"]]) {
      it(`wasit run ${flag[0]} is an unknown option, exit 2`, async () => {
        const result = await wasit(["run", "--read-only", ...flag], cwd);
        assert.equal(result.code, 2, result.stderr);
        assert.match(result.stderr, /unknown option/);
      });
    }

    it("wasit run --mainnet through the binary: refused with --read-only, and it reads the config (B18 O2)", async () => {
      const both = await wasit(["run", "--read-only", "--mainnet"], cwd);
      assert.equal(both.code, 2, both.stderr);
      assert.match(both.stderr, /--mainnet is for a paying run on stellar:pubnet: choose --mainnet or --read-only/);
      const missing = await wasit(["run", "--mainnet", "--config", "nope.json"], cwd);
      assert.equal(missing.code, 2, missing.stderr);
      assert.match(missing.stderr, /nope\.json/);
      assert.doesNotMatch(missing.stderr, /unknown option|MAINNET RUN/);
    });

    it("wasit run --ledger-dir without --mainnet is refused, exit 2", async () => {
      const result = await wasit(["run", "--read-only", "--ledger-dir", "ledgers"], cwd);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /--ledger-dir is for a --mainnet run/);
    });

    it("wasit run --mainnet takes no value", async () => {
      const result = await wasit(["run", "--mainnet=true"], cwd);
      assert.equal(result.code, 2);
    });

    for (const command of [["test", "--target", "http://127.0.0.1:9/paid"], ["mpp-charge", "--target", "http://127.0.0.1:9/paid"]]) {
      it(`wasit ${command[0]} --mainnet is an unknown option: the switch is on wasit run only`, async () => {
        const result = await wasit([...command, "--mainnet"], cwd);
        // These commands keep commander's own exit code for a usage error, as in 0.7.0.
        assert.notEqual(result.code, 0, result.stderr);
        assert.match(result.stderr, /unknown option/);
      });
    }

    it("wasit ci-report without --report is a usage error, exit 2", async () => {
      assert.equal((await wasit(["ci-report"], cwd)).code, 2);
    });

    it("the payment tier with no payer key sends no payment and exits 2, with the variable to set", async () => {
      const paywall = await startPaywall();
      try {
        const config = await writeConfig(cwd, { baseUrl: paywall.base });
        const result = await wasit(["run", "--config", config], cwd);
        assert.equal(result.code, 2);
        assert.match(result.stdout, /no payer key: set STELLAR_PRIVATE_KEY/);
        for (const request of paywall.received) assert.equal(request.headers["payment-signature"], undefined);
      } finally {
        await paywall.close();
      }
    });

    it("a pull request run with a payer key is refused before anything is sent, exit 2", async () => {
      const paywall = await startPaywall();
      try {
        const config = await writeConfig(cwd, { baseUrl: paywall.base });
        const result = await wasit(["run", "--config", config], cwd, {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REF: "refs/pull/1/merge",
          STELLAR_PRIVATE_KEY: "SNOTAKEY",
        });
        assert.equal(result.code, 2);
        assert.match(result.stderr, /STELLAR_PRIVATE_KEY is set, and this run may not pay \(pull request\)/);
        assert.equal(paywall.received.length, 0);
      } finally {
        await paywall.close();
      }
    });

    it("--help works and exits 0, offers --dry-run, --mainnet with its rules and --ledger-dir, and no key flag", async () => {
      const result = await wasit(["run", "--help"], cwd);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /--start/);
      assert.match(result.stdout, /--dry-run/);
      assert.match(result.stdout, /--mainnet\s+Pay real USDC on stellar:pubnet/);
      assert.match(result.stdout, /WASIT_MAINNET_PAYER_SECRET/);
      assert.match(result.stdout, /--ledger-dir <dir>/);
      assert.ok(!/--payer-key/.test(result.stdout));
    });

    it("wasit run --dry-run with --read-only is refused, exit 2", async () => {
      const result = await wasit(["run", "--read-only", "--dry-run"], cwd);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /choose --dry-run or --read-only/);
    });
  });

  describe(".env and CI (spec A8 #2)", () => {
    let dir: string;
    before(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "wasit-dotenv-"));
      await writeFile(path.join(dir, ".env"), "WASIT_HEADER_X_FROM_DOTENV=from-dotenv\nMPP_PAYER_SECRET=not-a-stellar-secret\n");
    });
    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    async function headerSeen(env: Record<string, string>): Promise<{ code: number | null; value: string | string[] | undefined }> {
      const paywall = await startPaywall();
      try {
        const config = await writeConfig(dir, { baseUrl: paywall.base });
        const result = await wasit(["run", "--read-only", "--config", config, "--json"], dir, env);
        assert.notEqual(paywall.received.length, 0, result.stderr);
        return { code: result.code, value: paywall.received[0]?.headers["x-from-dotenv"] };
      } finally {
        await paywall.close();
      }
    }

    it("is read by wasit run outside CI", async () => {
      const seen = await headerSeen({});
      assert.equal(seen.value, "from-dotenv");
      assert.equal(seen.code, 0);
    });

    it("is not read by wasit run when CI is set", async () => {
      assert.equal((await headerSeen({ CI: "true" })).value, undefined);
      assert.equal((await headerSeen({ CI: "1" })).value, undefined);
    });

    it("is not read by wasit run when GITHUB_ACTIONS is set", async () => {
      assert.equal((await headerSeen({ GITHUB_ACTIONS: "true" })).value, undefined);
    });

    it("is read again when CI is set but empty", async () => {
      assert.equal((await headerSeen({ CI: "" })).value, "from-dotenv");
    });

    it("is still read by the commands that were there before, in CI too", async () => {
      const paywall = await startPaywall();
      try {
        const result = await wasit(["mpp-charge", "--target", `${paywall.base}/paid`, "--json"], dir, { CI: "true" });
        // With .env read the made-up key is found, so the "no payer key" refusal does not come.
        assert.ok(!/No payer key/.test(result.stderr), result.stderr);
        // The made-up key cannot sign: no payment header reached the service.
        assert.ok(paywall.received.every((entry) => entry.headers["authorization"] === undefined));
        assert.equal((await wasit(["mpp-charge", "--target", `${paywall.base}/paid`, "--json"], cwd, { CI: "true" })).code, 2);
      } finally {
        await paywall.close();
      }
    });
  });

  describe(".env and --mainnet (B5: the key from the shell's variable only)", () => {
    let dir: string;
    const key = Keypair.random();
    before(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "wasit-dotenv-mainnet-"));
      // A key left in a file beside the service, and an RPC: a mainnet run reads neither.
      await writeFile(path.join(dir, ".env"), `WASIT_MAINNET_PAYER_SECRET=${key.secret()}\nWASIT_RPC_URL=https://127.0.0.1:9/from-dotenv\n`);
      await writeFile(
        path.join(dir, "wasit.config.json"),
        JSON.stringify({
          version: 1,
          environments: {
            mainnet: {
              baseUrl: "http://127.0.0.1:9",
              network: "stellar:pubnet",
              operatedByMe: true,
              pinned: { payTo: Keypair.random().publicKey(), asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" },
            },
          },
          endpoints: [{ name: "weather", protocol: "x402", path: "/weather", method: "GET" }],
        }),
      );
    });
    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("is not read by wasit run --mainnet: the key in .env is not found, exit 2, nothing started", async () => {
      const result = await wasit(["run", "--mainnet", "--env", "mainnet"], dir);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.stderr, /WASIT_MAINNET_PAYER_SECRET is not set: a mainnet run reads its key from that variable only/);
      assert.ok(!(result.stdout + result.stderr).includes(key.secret()), "the key was printed");
      assert.ok(!/from-dotenv/.test(result.stdout + result.stderr), "the RPC of .env was read");
    });

    it("says so in --mainnet's help", async () => {
      const result = await wasit(["run", "--help"], cwd);
      assert.match(result.stdout.replace(/\s+/g, " "), /With --mainnet, wasit run does not read \.env: the variables come from the shell/);
    });
  });

  describe("--start", () => {
    /** A service that records its pid and environment, and answers `delayMs` late. */
    async function service(name: string, delayMs: number) {
      const port = await freePort();
      const script = path.join(cwd, `${name}.mjs`);
      const pidFile = path.join(cwd, `${name}.pid`);
      const envFile = path.join(cwd, `${name}.env.json`);
      await writeFile(
        script,
        `import http from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.log("service says hello");
console.log("::set-output name=pwn::1");
http.createServer((req, res) => {
  writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));
  setTimeout(() => {
    res.writeHead(402, { "payment-required": ${JSON.stringify(challengeHeader())} });
    res.end("{}");
  }, req.url === "/api/weather" ? ${delayMs} : 0);
}).listen(${port}, "127.0.0.1");
`,
      );
      const config = await writeConfig(
        cwd,
        {
          baseUrl: `http://127.0.0.1:${port}`,
          service: { start: `node ${JSON.stringify(script)}`, ready: { url: `http://127.0.0.1:${port}/ready`, timeoutSeconds: 20 } },
        },
        `${name}.config.json`,
      );
      return { config, pidFile, envFile };
    }

    it("takes the service's environment from the real process environment: no key, no header value, no RPC url", async () => {
      const { config, pidFile, envFile } = await service("env-run", 0);
      const canaries = {
        STELLAR_PRIVATE_KEY: "canary-stellar-key",
        EVM_PRIVATE_KEY: "canary-evm-key",
        SVM_PRIVATE_KEY: "canary-svm-key",
        MPP_PAYER_SECRET: "canary-mpp-payer",
        COMMITMENT_SECRET_HEX: "canary-commitment",
        WASIT_MAINNET_PAYER_SECRET: "canary-mainnet-payer",
        WASIT_HEADER_X_API_KEY: "canary-header",
        WASIT_RPC_URL: "https://rpc.example/canary-rpc-key",
      };
      const result = await wasit(["run", "--read-only", "--start", "--config", config, "--json"], cwd, { ...canaries, KEEP_ME: "kept" });
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotThrow(() => JSON.parse(result.stdout), "stdout is the JSON report only");
      assert.match(result.stderr, /\[service\] service says hello/);
      assert.ok(!/^::/m.test(result.stderr), "the service's ::-line is behind the prefix");
      assert.ok(!result.stdout.includes("canary") && !result.stderr.includes("canary"));
      const seen = JSON.parse(await readFile(envFile, "utf-8")) as Record<string, string>;
      assert.equal(seen["KEEP_ME"], "kept");
      for (const name of Object.keys(canaries)) assert.equal(seen[name], undefined, `${name} reached the service`);
      const pid = Number(await readFile(pidFile, "utf-8"));
      assert.equal(await waitFor(() => !alive(pid), 3000), true, "the service was stopped at the end");
    });

    for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
      it(`stops the service when Wasit gets ${signal} in the middle of a run, and exits ${code}`, { skip: !POSIX && "POSIX signals; --start not run on Windows" }, async () => {
        const { config, pidFile } = await service(`signal-${signal}`, 20_000);
        const { child, done } = start(["run", "--read-only", "--start", "--config", config, "--json"], cwd);
        assert.equal(await waitFor(async () => (await readFile(pidFile, "utf-8").catch(() => "")) !== "", 15_000), true, "the service started");
        const pid = Number(await readFile(pidFile, "utf-8"));
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.ok(alive(pid));
        child.kill(signal);
        const result = await done;
        assert.equal(result.code, code, result.stderr);
        assert.equal(await waitFor(() => !alive(pid), 5000), true, "the service is gone");
      });
    }

    it("stops the service and exits 2 when nothing answers in time", async () => {
      const port = await freePort();
      const script = path.join(cwd, "mute.mjs");
      const pidFile = path.join(cwd, "mute.pid");
      await writeFile(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
      const config = await writeConfig(
        cwd,
        {
          baseUrl: `http://127.0.0.1:${port}`,
          service: { start: `node ${JSON.stringify(script)}`, ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 1 } },
        },
        "mute.config.json",
      );
      const result = await wasit(["run", "--read-only", "--start", "--config", config], cwd);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /no answer/);
      const pid = Number(await readFile(pidFile, "utf-8"));
      assert.equal(await waitFor(() => !alive(pid), 3000), true);
    });
  });
});
