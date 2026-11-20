/**
 * `executeRun`, the code behind `wasit run` (spec A2, A8 #1 to #3, #5, #6).
 *
 * In-process, against paywalls on 127.0.0.1, with the environment injected. In
 * this version every run is read-only: the payment tier is refused before
 * anything is loaded or sent. No key is real, nothing leaves 127.0.0.1.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { RunReport } from "@wasit-dev/core";

import { executeRun, type RunCommandOptions } from "../../src/run.js";
import {
  challengeHeader,
  freePort,
  startPaywall,
  v1Handler,
  writeConfig,
  type Paywall,
} from "./run-helpers.js";

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly report: () => RunReport;
}

async function run(
  options: Partial<RunCommandOptions> & { config: string },
  env: Record<string, string> = {},
  cwd?: string,
): Promise<Outcome> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await executeRun(
    { readOnly: true, json: false, start: false, ...options },
    {
      env: { PATH: process.env["PATH"] ?? "", ...env },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      now: () => new Date("2026-11-15T10:00:00.000Z"),
      ...(cwd === undefined ? {} : { cwd }),
    },
  );
  const stdout = out.join("\n");
  return { code, stdout, stderr: err.join("\n"), report: () => JSON.parse(stdout) as RunReport };
}

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

describe("wasit run", () => {
  let dir: string;
  let paywall: Paywall | undefined;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-run-"));
  });
  after(async () => {
    // The paywall of the last test is still open: close it, or the process never exits.
    await paywall?.close();
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await paywall?.close();
    paywall = undefined;
  });

  it("refuses the payment tier before it reads a config or sends anything", async () => {
    paywall = await startPaywall();
    const config = await writeConfig(dir, { baseUrl: paywall.base });
    const result = await run({ config, readOnly: false });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /not available in this version/);
    assert.match(result.stderr, /--read-only/);
    assert.equal(paywall.received.length, 0);
    assert.equal((await run({ config: path.join(dir, "missing.json"), readOnly: false })).code, 2, "even for a missing config");
  });

  describe("a conformant paywall", () => {
    it("exits 0 and reports conformant, with the payment group skipped as read-only", async () => {
      paywall = await startPaywall();
      const config = await writeConfig(dir, { baseUrl: paywall.base });
      const result = await run({ config, json: true });
      assert.equal(result.code, 0, result.stderr);
      const report = result.report();
      assert.equal(report.schema, 1);
      assert.equal(report.environment, "local");
      assert.equal(report.network, "stellar:testnet");
      assert.equal(report.networkClass, "test");
      assert.equal(report.startedAt, "2026-11-15T10:00:00.000Z");
      const [weather] = report.endpoints;
      assert.equal(weather?.outcome, "conformant");
      assert.equal(weather?.groups.challenge?.passed, 5);
      assert.equal(weather?.groups.payment?.skipped, 5);
      const payment = weather?.results.filter((check) => check.status === "SKIP") ?? [];
      assert.deepEqual(payment.map((check) => check.id), ["X402-06", "X402-07", "X402-08", "X402-09", "X402-10"]);
      for (const check of payment) assert.equal(check.skipKind, "read-only", check.id);
      assert.equal(report.totals.graded, 1);
      assert.ok(report.notes.some((note) => /read-only/.test(note)));
      assert.match(report.wasit.core, /^\d+\.\d+\.\d+/);
      assert.match(report.sdk["@x402/core"], /^\d+\.\d+\.\d+/);
    });

    it("names the commit an Action build came from in the report, only when the action ref is a full commit id", async () => {
      paywall = await startPaywall();
      const config = await writeConfig(dir, { baseUrl: paywall.base });
      const sha = "0123456789abcdef0123456789abcdef01234567";
      assert.equal((await run({ config, json: true }, { WASIT_BUILD_COMMIT: sha })).report().wasit.build, "0123456");
      for (const ref of ["v0.8.0-beta.1", "main", `${sha}\n::error::x`, ""]) {
        const report = (await run({ config, json: true }, { WASIT_BUILD_COMMIT: ref })).report();
        assert.equal("build" in report.wasit, false, JSON.stringify(ref));
      }
      assert.equal("build" in (await run({ config, json: true })).report().wasit, false, "no variable, no build");
    });

    it("sends the one unpaid request and nothing else: no payment header, no second request", async () => {
      paywall = await startPaywall();
      const config = await writeConfig(dir, { baseUrl: paywall.base });
      await run({ config, json: true });
      assert.equal(paywall.received.length, 1);
      assert.equal(paywall.received[0]?.url, "/api/weather");
      assert.equal(paywall.received[0]?.headers["payment-signature"], undefined);
      assert.equal(paywall.received[0]?.headers["x-payment"], undefined);
    });

    it("prints only the JSON document to stdout with --json, and writes the same to --out", async () => {
      paywall = await startPaywall();
      const config = await writeConfig(dir, { baseUrl: paywall.base });
      const outFile = path.join(dir, "report.json");
      const result = await run({ config, json: true, out: outFile });
      assert.doesNotThrow(() => JSON.parse(result.stdout));
      assert.deepEqual(JSON.parse(await readFile(outFile, "utf-8")), JSON.parse(result.stdout));
    });

    it("says the result and why on stderr with --json, so a job log shows it, and keeps it off stdout", async () => {
      paywall = await startPaywall(v1Handler);
      const config = await writeConfig(dir, { baseUrl: paywall.base });
      const result = await run({ config, json: true });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /Result: nothing could be graded: 0 graded, 1 unsupported \(exit 2\)/);
      assert.ok(!result.stdout.includes("Result:"), "stdout is the JSON document only");
    });

    it("prints readable text without --json, and writes the JSON to --out", async () => {
      paywall = await startPaywall();
      const config = await writeConfig(dir, { baseUrl: paywall.base });
      const outFile = path.join(dir, "report-text.json");
      const result = await run({ config, out: outFile });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /Environment local/);
      assert.match(result.stdout, /weather/);
      assert.match(result.stdout, /PASS {2}X402-01/);
      assert.match(result.stdout, /X402-06/);
      assert.match(result.stdout, /read-only/);
      assert.match(result.stdout, /1 graded/);
      assert.ok(!CONTROL.test(result.stdout.replace(/\n/g, "")));
      assert.equal((JSON.parse(await readFile(outFile, "utf-8")) as RunReport).schema, 1);
    });

    it("sends the method, the body and the headers of the endpoint, and the header variables of the environment", async () => {
      paywall = await startPaywall();
      const config = await writeConfig(dir, {
        baseUrl: paywall.base,
        endpoints: [
          {
            name: "summarize",
            protocol: "x402",
            path: "/api/summarize",
            method: "POST",
            headers: { "x-tenant": "demo" },
            body: { text: "hello" },
          },
        ],
      });
      await run({ config, json: true }, { WASIT_HEADER_X_API_KEY: "canary-header-value-7f3a" });
      const sent = paywall.received[0]!;
      assert.equal(sent.method, "POST");
      assert.equal(sent.headers["x-tenant"], "demo");
      assert.equal(sent.headers["x-api-key"], "canary-header-value-7f3a");
      assert.deepEqual(JSON.parse(sent.body), { text: "hello" });
      assert.match(String(sent.headers["content-type"]), /application\/json/);
    });

    it("runs only the endpoints asked for with --endpoint, and names the choices when one does not exist", async () => {
      paywall = await startPaywall();
      const config = await writeConfig(dir, {
        baseUrl: paywall.base,
        endpoints: [
          { name: "a", protocol: "x402", path: "/a" },
          { name: "b", protocol: "x402", path: "/b" },
        ],
      });
      const one = await run({ config, json: true, endpoint: ["b"] });
      assert.deepEqual(one.report().endpoints.map((endpoint) => endpoint.name), ["b"]);
      assert.deepEqual(paywall.received.map((entry) => entry.url), ["/b"]);
      const none = await run({ config, json: true, endpoint: ["c"] });
      assert.equal(none.code, 2);
      assert.match(none.stderr, /no endpoint named c/);
      assert.match(none.stderr, /a, b/);
    });

    it("runs the endpoints one after another, in the order of the file", async () => {
      paywall = await startPaywall();
      const config = await writeConfig(dir, {
        baseUrl: paywall.base,
        endpoints: ["one", "two", "three"].map((name) => ({ name, protocol: "x402", path: `/${name}` })),
      });
      await run({ config, json: true });
      assert.deepEqual(paywall.received.map((entry) => entry.url), ["/one", "/two", "/three"]);
    });
  });

  describe("MPP endpoints, which have no read-only check", () => {
    it("sends nothing for them, names the tier as the reason, and does not fail a run that graded something else", async () => {
      paywall = await startPaywall();
      const config = await writeConfig(dir, {
        baseUrl: paywall.base,
        endpoints: [
          { name: "weather", protocol: "x402", path: "/w" },
          { name: "chat", protocol: "mpp-charge", path: "/mpp/chat" },
          { name: "stream", protocol: "mpp-channel", path: "/mpp/stream" },
        ],
      });
      const result = await run({ config, json: true });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(paywall.received.map((entry) => entry.url), ["/w"]);
      const [, chat, stream] = result.report().endpoints;
      assert.equal(chat?.outcome, "no-verdict");
      assert.match(chat?.reason ?? "", /read-only/);
      assert.deepEqual(chat?.results.map((check) => check.id), ["MPP-01"]);
      assert.deepEqual(stream?.results.map((check) => check.id), ["MPP-10", "MPP-11", "MPP-12", "MPP-14"]);
      assert.ok(chat?.results.every((check) => check.status === "SKIP" && check.skipKind === "read-only"));
    });

    it("exits 2 when they are all there is: nothing could be graded", async () => {
      paywall = await startPaywall();
      const config = await writeConfig(dir, {
        baseUrl: paywall.base,
        endpoints: [{ name: "chat", protocol: "mpp-charge", path: "/mpp/chat" }],
      });
      const result = await run({ config });
      assert.equal(result.code, 2);
      assert.match(result.stdout, /nothing could be graded/);
      assert.equal(paywall.received.length, 0);
    });
  });

  describe("the exit rule", () => {
    it("is 1 for a non-conformant endpoint", async () => {
      paywall = await startPaywall((_request, response) => {
        response.writeHead(200);
        response.end("free");
      });
      const config = await writeConfig(dir, { baseUrl: paywall.base });
      const result = await run({ config, json: true });
      assert.equal(result.code, 1);
      assert.equal(result.report().endpoints[0]?.outcome, "non-conformant");
      const first = result.report().endpoints[0]?.results[0];
      assert.equal(first?.expected, "status 402", "the report carries what was expected");
      assert.equal(first?.actual, "status 200", "and what the service sent");
      assert.equal(first?.detail, "Expected status 402, got 200.", "detail is unchanged");
      const text = await run({ config });
      assert.match(text.stdout, /Expected: status 402/);
      assert.match(text.stdout, /Actual: status 200/);
    });

    it("is 2 for an x402 v1 service, and says nothing could be graded: neither green nor a FAIL", async () => {
      paywall = await startPaywall(v1Handler);
      const config = await writeConfig(dir, { baseUrl: paywall.base });
      const result = await run({ config });
      assert.equal(result.code, 2);
      assert.match(result.stdout, /nothing could be graded/);
      assert.match(result.stdout, /0 graded, 1 unsupported/);
      assert.ok(!/FAIL/.test(result.stdout));
      const json = await run({ config, json: true });
      assert.equal(json.report().endpoints[0]?.outcome, "unsupported");
      assert.equal(json.report().totals.graded, 0);
    });

    it("is 2 when the service cannot be reached", async () => {
      const port = await freePort();
      const config = await writeConfig(dir, { baseUrl: `http://127.0.0.1:${port}` });
      const result = await run({ config, json: true });
      assert.equal(result.code, 2);
      assert.equal(result.report().endpoints[0]?.outcome, "no-verdict");
    });

    describe("against a baseline", () => {
      async function baselineOf(handlerPaywall: Paywall, name: string, environment = "local"): Promise<string> {
        const config = await writeConfig(dir, { baseUrl: handlerPaywall.base, environment }, `${name}.config.json`);
        const result = await run({ config, json: true });
        const file = path.join(dir, `${name}.baseline.json`);
        await writeFile(file, result.stdout);
        return file;
      }

      it("is 1 when an endpoint that was graded on main is unsupported now, and says so", async () => {
        const main = await startPaywall();
        const baseline = await baselineOf(main, "main-good");
        await main.close();
        paywall = await startPaywall(v1Handler);
        const config = await writeConfig(dir, { baseUrl: paywall.base });
        const without = await run({ config, json: true });
        assert.equal(without.code, 2, "without the baseline it is only 'nothing graded'");
        const result = await run({ config, json: true, baseline });
        assert.equal(result.code, 1);
        const text = await run({ config, baseline });
        assert.match(text.stdout, /regression against main/);
        assert.match(text.stdout, /weather/);
      });

      it("ignores a baseline that is not a report, and says so in the report", async () => {
        paywall = await startPaywall(v1Handler);
        const config = await writeConfig(dir, { baseUrl: paywall.base });
        const bad = path.join(dir, "bad-baseline.json");
        await writeFile(bad, '{"hello":"world"}');
        const result = await run({ config, json: true, baseline: bad });
        assert.equal(result.code, 2);
        assert.ok(result.report().notes.some((note) => /Baseline not used/.test(note)));
      });

      it("ignores a baseline file that is not there, and says so", async () => {
        paywall = await startPaywall();
        const config = await writeConfig(dir, { baseUrl: paywall.base });
        const result = await run({ config, json: true, baseline: path.join(dir, "no-such-baseline.json") });
        assert.equal(result.code, 0);
        assert.ok(result.report().notes.some((note) => /Baseline not used/.test(note)));
      });

      it("does not compare with a baseline from another environment", async () => {
        const main = await startPaywall();
        const baseline = await baselineOf(main, "main-staging", "staging");
        await main.close();
        paywall = await startPaywall(v1Handler);
        const config = await writeConfig(dir, { baseUrl: paywall.base });
        const result = await run({ config, json: true, baseline });
        assert.equal(result.code, 2, "no regression, only 'nothing graded'");
        assert.ok(result.report().notes.some((note) => /environment staging/.test(note)));
      });
    });
  });

  describe("a bad config", () => {
    it("exits 2 and names the key, never the value", async () => {
      const config = path.join(dir, "bad.config.json");
      await writeFile(config, JSON.stringify({ version: 1, environments: {}, endpoints: [], payerKey: "S" + "A".repeat(55) }));
      const result = await run({ config });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /payerKey/);
      assert.ok(!result.stderr.includes("A".repeat(55)));
    });

    it("exits 2 for a missing file and for an environment that is not there", async () => {
      assert.equal((await run({ config: path.join(dir, "absent.json") })).code, 2);
      paywall = await startPaywall();
      const config = await writeConfig(dir, { baseUrl: paywall.base });
      const result = await run({ config, env: "prod" });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /no such environment/);
      assert.equal(paywall.received.length, 0);
    });
  });

  describe("targets and redirects (A8 #5)", () => {
    it("does not follow a redirect to another origin: it is reported, and that origin is never contacted", async () => {
      const elsewhere = await startPaywall();
      paywall = await startPaywall((_request, response) => {
        response.writeHead(302, { location: `${elsewhere.base}/stolen` });
        response.end();
      });
      try {
        const config = await writeConfig(dir, { baseUrl: paywall.base });
        const result = await run({ config, json: true }, { WASIT_HEADER_X_API_KEY: "canary-header-value-7f3a" });
        assert.equal(result.code, 2);
        assert.equal(result.report().endpoints[0]?.outcome, "no-verdict");
        assert.match(result.report().endpoints[0]?.reason ?? "", /redirect/i);
        assert.equal(elsewhere.received.length, 0, "the other origin was never contacted");
      } finally {
        await elsewhere.close();
      }
    });
  });

  describe("text a service sent, and secrets", () => {
    const CANARY = "canary-header-value-7f3a";
    const STELLAR_KEY = `S${"A".repeat(55)}`;

    it("reaches no output with a control character, a leading ::, or a secret: terminal, JSON or file", async () => {
      // X402-03 quotes the start of an undecodable header and X402-05 the network the service chose.
      const hostile = Buffer.from("\u001b[2J\n::set-output name=pwn::1\nnot json").toString("base64");
      const echo = Buffer.from(
        JSON.stringify({
          x402Version: 2,
          accepts: [{ scheme: "exact", network: `${CANARY} ${STELLAR_KEY}`, amount: "1", asset: "a", payTo: "b", maxTimeoutSeconds: 60 }],
        }),
      ).toString("base64");
      for (const header of [hostile, echo]) {
        const wall = await startPaywall((_request, response) => {
          response.writeHead(402, { "payment-required": header });
          response.end("{}");
        });
        try {
          const config = await writeConfig(dir, { baseUrl: wall.base });
          const outFile = path.join(dir, "hostile.json");
          const env = { WASIT_HEADER_X_API_KEY: CANARY, STELLAR_PRIVATE_KEY: STELLAR_KEY };
          const text = await run({ config, out: outFile }, env);
          const json = await run({ config, json: true }, env);
          const file = await readFile(outFile, "utf-8");
          for (const output of [text.stdout, text.stderr, json.stdout, json.stderr, file]) {
            assert.ok(!output.includes(CANARY), "the header value");
            assert.ok(!output.includes(STELLAR_KEY), "the key");
            assert.ok(!CONTROL.test(output.replace(/\n/g, "")), "a control character");
            assert.ok(!/^\s*(::|##\[)/m.test(output), "a line that starts a workflow command");
          }
        } finally {
          await wall.close();
        }
      }
    });
  });

  describe("--start", () => {
    it("needs service.start and service.ready in the config, and says which is missing", async () => {
      paywall = await startPaywall();
      const none = await writeConfig(dir, { baseUrl: paywall.base });
      const noStart = await run({ config: none, start: true });
      assert.equal(noStart.code, 2);
      assert.match(noStart.stderr, /service\.start/);
      const noReady = await writeConfig(dir, { baseUrl: paywall.base, service: { start: "node -e 0" } }, "no-ready.config.json");
      const result = await run({ config: noReady, start: true });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /service\.ready/);
      assert.equal(paywall.received.length, 0);
    });

    it("starts the service, runs against it, stops it, and the service never saw a key or a header value", async () => {
      const port = await freePort();
      const script = path.join(dir, "paywall.mjs");
      const pidFile = path.join(dir, "paywall.pid");
      const envFile = path.join(dir, "paywall.env.json");
      await writeFile(
        script,
        `import http from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
http.createServer((req, res) => {
  writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));
  res.writeHead(402, { "payment-required": ${JSON.stringify(challengeHeader())} });
  res.end("{}");
}).listen(${port}, "127.0.0.1");
`,
      );
      const config = await writeConfig(dir, {
        baseUrl: `http://127.0.0.1:${port}`,
        service: { start: `node ${JSON.stringify(script)}`, ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 15 } },
      });
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
      const result = await run({ config, start: true, json: true }, { ...canaries, KEEP_ME: "kept" });
      assert.equal(result.code, 0, result.stderr);
      const seen = JSON.parse(await readFile(envFile, "utf-8")) as Record<string, string>;
      assert.equal(seen["KEEP_ME"], "kept");
      for (const name of Object.keys(canaries)) assert.equal(seen[name], undefined, `${name} reached the service`);
      assert.ok(!JSON.stringify(seen).includes("canary"));
      const pid = Number(await readFile(pidFile, "utf-8"));
      const gone = await (async () => {
        for (let i = 0; i < 60; i += 1) {
          try {
            process.kill(pid, 0);
          } catch {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
      })();
      assert.equal(gone, true, "the service was stopped");
      assert.ok(existsSync(pidFile));
    });

    it("exits 2 and stops the service when nothing answers in time", async () => {
      const port = await freePort();
      const script = path.join(dir, "silent.mjs");
      const pidFile = path.join(dir, "silent.pid");
      await writeFile(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
      const config = await writeConfig(dir, {
        baseUrl: `http://127.0.0.1:${port}`,
        service: { start: `node ${JSON.stringify(script)}`, ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 1 } },
      });
      const result = await run({ config, start: true });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /no answer/);
      const pid = Number(await readFile(pidFile, "utf-8"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.throws(() => process.kill(pid, 0), "the silent service is gone");
    });
  });

  // The Action passes --start-if-local: the CLI decides whether the service is started, so one
  // rule serves the laptop and the job. A deployed endpoint (even on mainnet) is only read.
  describe("--start-if-local", () => {
    it("without service.start it reads the configured baseUrl as it is, and says so", async () => {
      paywall = await startPaywall();
      const config = await writeConfig(dir, { baseUrl: paywall.base });
      const result = await run({ config, startIfLocal: true });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(paywall.received.length, 1, "the endpoint was read");
      assert.match(result.stderr, /service\.start is not set/);
    });

    it("with service.start but an environment that is not on this machine, it does not start the service", async () => {
      const marker = path.join(dir, "not-started.marker");
      const script = path.join(dir, "marker.mjs");
      await writeFile(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "1"); setInterval(() => {}, 1000);`);
      const port = await freePort();
      // .invalid never resolves (RFC 2606): nothing is contacted, and the run has no verdict.
      const config = await writeConfig(dir, {
        baseUrl: "https://wasit-test.invalid",
        service: { start: `node ${JSON.stringify(script)}`, ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 1 } },
      });
      const result = await run({ config, startIfLocal: true });
      assert.match(result.stderr, /not on this machine/);
      assert.match(result.stderr, /https:\/\/wasit-test\.invalid/);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(existsSync(marker), false, "service.start was not run");
      assert.equal(result.code, 2, "an unreachable endpoint is no verdict");
    });

    it("with service.start and a loopback environment it starts the service, runs, and stops it", async () => {
      const port = await freePort();
      const script = path.join(dir, "local-paywall.mjs");
      const pidFile = path.join(dir, "local-paywall.pid");
      await writeFile(
        script,
        `import http from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
http.createServer((req, res) => {
  res.writeHead(402, { "payment-required": ${JSON.stringify(challengeHeader())} });
  res.end("{}");
}).listen(${port}, "127.0.0.1");
`,
      );
      const config = await writeConfig(dir, {
        baseUrl: `http://127.0.0.1:${port}`,
        service: { start: `node ${JSON.stringify(script)}`, ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 15 } },
      });
      const result = await run({ config, startIfLocal: true });
      assert.equal(result.code, 0, result.stderr);
      const pid = Number(await readFile(pidFile, "utf-8"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.throws(() => process.kill(pid, 0), "the service was stopped");
    });

    it("asks to choose when --start and --start-if-local are both given", async () => {
      paywall = await startPaywall();
      const config = await writeConfig(dir, { baseUrl: paywall.base });
      const result = await run({ config, start: true, startIfLocal: true });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /--start or --start-if-local/);
      assert.equal(paywall.received.length, 0, "nothing was sent");
    });
  });
});
