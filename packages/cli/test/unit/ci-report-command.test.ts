/**
 * `executeCiReport`, the code behind `wasit ci-report` (spec A4, A5): the run
 * report (and the baseline, if there is one) in, `comment.md`, the job summary
 * and, on the default branch, the next baseline out.
 *
 * Mostly in-process with files in a temporary directory. The hostile cases run
 * `executeRun` against a paywall that sends nasty text and feed its report to
 * `executeCiReport`, the way the Action does. No key is real.
 */

import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { parseRunReport, serializeBaseline, updateHistory } from "@wasit-dev/core";

import { executeCiReport, type CiReportOptions } from "../../src/ci-report-command.js";
import { executeRun } from "../../src/run.js";
import { startPaywall, v1Handler, writeConfig, type Handler } from "./run-helpers.js";

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/;
const CANARY = "canary-header-value-7f3a";
const STELLAR_KEY = `S${"A".repeat(55)}`;

describe("wasit ci-report", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-ci-report-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Runs `wasit run --read-only --json` against a paywall and returns the path of the report. */
  async function reportFor(handler: Handler, name: string, env: Record<string, string> = {}): Promise<string> {
    const paywall = await startPaywall(handler);
    try {
      const config = await writeConfig(dir, { baseUrl: paywall.base }, `${name}.config.json`);
      const file = path.join(dir, `${name}.report.json`);
      await executeRun(
        { config, readOnly: true, json: true, start: false, out: file },
        { env: { PATH: process.env["PATH"] ?? "", ...env }, stdout: () => {}, stderr: () => {} },
      );
      return file;
    } finally {
      await paywall.close();
    }
  }

  async function ciReport(options: Partial<CiReportOptions> & { report: string }, env: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await executeCiReport(
      { comment: path.join(dir, "comment.md"), ...options },
      { env: { PATH: process.env["PATH"] ?? "", ...env }, stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    );
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  }

  it("writes comment.md: the marker first, then the outcome and the versions", async () => {
    const report = await reportFor(async (_request, response) => {
      const { challengeHeader } = await import("./run-helpers.js");
      response.writeHead(402, { "payment-required": challengeHeader() });
      response.end("{}");
    }, "green");
    const comment = path.join(dir, "green.comment.md");
    const result = await ciReport({ report, comment });
    assert.equal(result.code, 0, result.stderr);
    const text = await readFile(comment, "utf-8");
    assert.equal(text.split("\n")[0], "<!-- wasit-report -->");
    assert.match(text.split("\n")[1] ?? "", /Wasit: ✅ conformant/);
    assert.match(text, /No baseline on main yet/);
  });

  it("appends the summary to the file named by --summary, or GITHUB_STEP_SUMMARY, and does not overwrite it", async () => {
    const report = await reportFor(v1Handler, "summary");
    const summary = path.join(dir, "step-summary.md");
    await writeFile(summary, "earlier step\n");
    await ciReport({ report, summary, comment: path.join(dir, "s1.md") });
    const viaFlag = await readFile(summary, "utf-8");
    assert.ok(viaFlag.startsWith("earlier step\n"));
    assert.match(viaFlag, /Wasit: ⚪ nothing graded/);
    assert.ok(!viaFlag.includes("<!-- wasit-report -->"));

    const other = path.join(dir, "step-summary-env.md");
    appendFileSync(other, "");
    await ciReport({ report, comment: path.join(dir, "s2.md") }, { GITHUB_STEP_SUMMARY: other });
    assert.match(await readFile(other, "utf-8"), /Wasit: ⚪ nothing graded/);
  });

  it("compares with the baseline, and carries the history into --baseline-out", async () => {
    const good = await reportFor(async (_request, response) => {
      const { challengeHeader } = await import("./run-helpers.js");
      response.writeHead(402, { "payment-required": challengeHeader() });
      response.end("{}");
    }, "main-good");
    const bad = await reportFor((_request, response) => {
      response.writeHead(200);
      response.end("free");
    }, "pr-bad");

    // The run on main: no baseline yet, writes the first one.
    const first = path.join(dir, "baseline-1.json");
    assert.equal((await ciReport({ report: good, comment: path.join(dir, "c1.md"), baselineOut: first })).code, 0);
    const firstFile = JSON.parse(await readFile(first, "utf-8")) as { history: Record<string, Record<string, string>> };
    assert.equal(firstFile.history["weather"]?.["X402-01"], "P");

    // A second run on main, with the first as the baseline: the history grows.
    const second = path.join(dir, "baseline-2.json");
    await ciReport({ report: good, baseline: first, comment: path.join(dir, "c2.md"), baselineOut: second });
    const secondFile = JSON.parse(await readFile(second, "utf-8")) as { history: Record<string, Record<string, string>> };
    assert.equal(secondFile.history["weather"]?.["X402-01"], "PP");

    // A pull request that breaks the paywall.
    const comment = path.join(dir, "c3.md");
    assert.equal((await ciReport({ report: bad, baseline: second, comment })).code, 0, "a failing run is the run's exit code, not ci-report's");
    const text = await readFile(comment, "utf-8");
    assert.match(text, /Wasit: ❌ non-conformant/);
    assert.match(text, /New FAIL: weather X402-01 \(was PASS on main\)/);
    assert.ok(!/### Recent failures/.test(text), "main never failed, so there is no recent-failures section");
  });

  it("says the baseline could not be used, and still writes the comment, when the file is not a report", async () => {
    const report = await reportFor(v1Handler, "bad-baseline");
    const baseline = path.join(dir, "forged-baseline.json");
    await writeFile(baseline, '{"schema":1,"endpoints":"not a list"}');
    const comment = path.join(dir, "c4.md");
    const result = await ciReport({ report, baseline, comment });
    assert.equal(result.code, 0);
    const text = await readFile(comment, "utf-8");
    assert.match(text, /could not be used/);
    assert.match(text, /history starts again/);
  });

  it("starts the history again from this run when it writes a baseline over one that could not be used", async () => {
    const report = await reportFor(v1Handler, "restart");
    const baseline = path.join(dir, "garbage-baseline.json");
    await writeFile(baseline, "garbage");
    const next = path.join(dir, "restart-next.json");
    await ciReport({ report, baseline, comment: path.join(dir, "c5.md"), baselineOut: next });
    const file = JSON.parse(await readFile(next, "utf-8")) as { history: Record<string, Record<string, string>> };
    assert.equal(file.history["weather"]?.["X402-01"], "P");
  });

  // The run left no usable report: the comment says "no verdict" (ci-report-no-report.test.ts
  // holds the detail), so the comment of the push before does not stay next to a red check.
  it("writes the check run's title, summary and conclusion with --check-run, and a neutral one when there is no report", async () => {
    const report = await reportFor(async (_request, response) => {
      const { challengeHeader } = await import("./run-helpers.js");
      response.writeHead(402, { "payment-required": challengeHeader() });
      response.end("{}");
    }, "check-run");
    const checkRun = path.join(dir, "check-run.json");
    const result = await ciReport({ report, comment: path.join(dir, "check-run.comment.md"), checkRun });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(await readFile(checkRun, "utf-8")) as { title: string; summary: string; conclusion: string };
    assert.equal(output.conclusion, "success");
    assert.match(output.title, /^✅ conformant · 5 passed, 6 skipped$/);
    assert.match(output.summary, /Wasit: ✅ conformant/);
    assert.ok(!output.summary.includes("<!-- wasit-report -->"), "the summary is the job summary, without the marker");
    const missing = path.join(dir, "check-run-missing.json");
    await ciReport({ report: path.join(dir, "no-such-report.json"), comment: path.join(dir, "missing.comment.md"), checkRun: missing });
    const neutral = JSON.parse(await readFile(missing, "utf-8")) as { conclusion: string; title: string };
    assert.equal(neutral.conclusion, "neutral");
    assert.match(neutral.title, /no verdict/);
  });

  it("says no verdict when the report is missing (exit 0: the run step carries the failure) or is not a report (exit 2)", async () => {
    const comment = path.join(dir, "never.md");
    const missing = await ciReport({ report: path.join(dir, "no-such-report.json"), comment });
    assert.equal(missing.code, 0);
    assert.match(missing.stderr, /wrote no report/);
    assert.match(await readFile(comment, "utf-8"), /Wasit: ⚠️ no verdict\./);
    const notReport = path.join(dir, "not-a-report.json");
    await writeFile(notReport, JSON.stringify({ schema: 7 }));
    const result = await ciReport({ report: notReport, comment });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /not a Wasit report/);
    assert.match(await readFile(comment, "utf-8"), /Wasit: ⚠️ no verdict\./);
  });

  describe("a hostile service, from the run to the comment", () => {
    const hostileHandler: Handler = (_request, response) => {
      // X402-05 quotes the network the service chose; X402-03 quotes the start of a header it cannot decode.
      const body = Buffer.from(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: `[click](https://evil.example/x) <img src=x onerror=alert(1)> @octocat ${CANARY} ${STELLAR_KEY}`,
              amount: "1",
              asset: "a",
              payTo: "b",
              maxTimeoutSeconds: 60,
            },
          ],
        }),
      ).toString("base64");
      response.writeHead(402, { "payment-required": body });
      response.end("{}");
    };
    const undecodable: Handler = (_request, response) => {
      response.writeHead(402, { "payment-required": Buffer.from("\u001b[2J\n::set-output name=pwn::1\nnot json").toString("base64") });
      response.end("{}");
    };

    // The 402 body: an x402 v1 body challenge is read for notes, and a note quotes what the body said.
    const hostileBody: Handler = (_request, response) => {
      response.writeHead(402, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: `[click](https://evil.example/x) <img src=x onerror=alert(1)> @octocat ${CANARY} ${STELLAR_KEY}\n::set-output name=pwn::1\u001b[2J`,
            },
          ],
        }),
      );
    };

    for (const [label, handler] of [
      ["a quoted field", hostileHandler],
      ["an undecodable header", undecodable],
      ["a v1 body", hostileBody],
    ] as const) {
      it(`${label}: the comment and the summary carry no HTML, link, mention, control character, workflow command or secret`, async () => {
        const env = { WASIT_HEADER_X_API_KEY: CANARY, STELLAR_PRIVATE_KEY: STELLAR_KEY };
        const report = await reportFor(handler, `hostile-${label.replace(/\s/g, "-")}`, env);
        const comment = path.join(dir, `hostile-${label.replace(/\s/g, "-")}.md`);
        const summary = path.join(dir, `hostile-${label.replace(/\s/g, "-")}.summary.md`);
        const result = await ciReport({ report, comment, summary }, env);
        assert.equal(result.code, 0, result.stderr);
        for (const file of [comment, summary]) {
          const text = await readFile(file, "utf-8");
          assert.match(text, /X402-0[2345]|unsupported/, "the finding is there");
          if (label === "a quoted field") {
            // The service chose the network, and the actual value quotes it: one line, neutralised.
            assert.match(text, /- Expected: /);
            assert.match(text, /- Actual: "/);
            assert.ok(!/canary/.test(text), "not even the start of the header value");
          }
          assert.ok(!/<(img|script)/i.test(text), "html");
          assert.ok(!text.includes("evil.example"), "a link");
          assert.ok(!/@octocat/.test(text), "a mention");
          assert.ok(!CONTROL.test(text.replace(/\n/g, "")), "a control character");
          assert.ok(!/^\s*(::|##\[)/m.test(text), "a workflow command");
          assert.ok(!text.includes(CANARY), "the header value");
          assert.ok(!text.includes(STELLAR_KEY), "the key");
        }
        // The report file itself, which the comment is built from: the same rules for every string in it.
        const file = await readFile(report, "utf-8");
        assert.ok(!file.includes(CANARY), "the report file");
        assert.ok(!/canary/.test(file), "not even the start of the header value, where a cut could have left it");
        assert.ok(!file.includes(STELLAR_KEY), "the key in the report file");
        const strings = (JSON.parse(file) as { endpoints: Array<{ results: Array<{ detail: string }> }> }).endpoints.flatMap((endpoint) =>
          endpoint.results.map((result) => result.detail),
        );
        for (const detail of strings) {
          assert.ok(!CONTROL.test(detail.replace(/\n/g, "")), "a control character in the report");
          assert.ok(!/^\s*(::|##\[)/m.test(detail), "a workflow command in the report");
        }
      });
    }
  });
});


// D-022b option 2 (Najmi, 2026-11-16): the comparison from the last green run on
// main (--baseline), the history from the newest completed run on main, failed
// or not (--history), and the comment names the run compared with
// (--baseline-run). Written before the code.
describe("wasit ci-report --history --baseline-run", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-ci-history-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function runReport(handler: Handler, name: string, environment = "local") {
    const paywall = await startPaywall(handler);
    try {
      const config = await writeConfig(dir, { baseUrl: paywall.base, environment }, `${name}.config.json`);
      const file = path.join(dir, `${name}.report.json`);
      await executeRun(
        { config, readOnly: true, json: true, start: false, out: file },
        { env: { PATH: process.env["PATH"] ?? "" }, stdout: () => {}, stderr: () => {} },
      );
      return { file, report: parseRunReport(JSON.parse(await readFile(file, "utf-8"))) };
    } finally {
      await paywall.close();
    }
  }
  const conformantHandler: Handler = async (_request, response) => {
    const { challengeHeader } = await import("./run-helpers.js");
    response.writeHead(402, { "payment-required": challengeHeader() });
    response.end("{}");
  };
  // X402-01 fails: the paid route answers 200 without a payment.
  const openHandler: Handler = (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  };

  async function run(options: Partial<CiReportOptions> & { report: string }) {
    const err: string[] = [];
    const comment = path.join(dir, `comment-${Math.random().toString(36).slice(2)}.md`);
    const code = await executeCiReport(
      { comment, ...options },
      { env: { PATH: process.env["PATH"] ?? "" }, stdout: () => {}, stderr: (line) => err.push(line) },
    );
    return { code, comment: await readFile(comment, "utf-8"), stderr: err.join("\n") };
  }

  it("compares with --baseline, counts recent failures from --history, and names the run", async () => {
    const green = await runReport(conformantHandler, "green");
    const red = await runReport(openHandler, "red");
    const baseline = path.join(dir, "baseline.json");
    await writeFile(baseline, serializeBaseline(green.report, updateHistory(undefined, green.report)));
    const history = path.join(dir, "history.json");
    await writeFile(history, serializeBaseline(red.report, updateHistory(updateHistory(updateHistory(undefined, green.report), red.report), red.report)));
    const next = path.join(dir, "next.json");

    const result = await run({ report: green.file, baseline, history, baselineRun: "43724229283", baselineOut: next });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.comment, /Compared with the last green run on main: run 43724229283, started /);
    assert.match(result.comment, /No change since main\./);
    assert.match(result.comment, /weather X402-01: failed in 2 of the last 3 runs on main/);
    // The next baseline carries the history of every run on, with this run added.
    const written = JSON.parse(await readFile(next, "utf-8"));
    assert.equal(written.history.weather["X402-01"], "PFFP");
  });

  it("ignores a history from another environment, or one it cannot read, and keeps the baseline's own", async () => {
    const green = await runReport(conformantHandler, "green2");
    const other = await runReport(openHandler, "other", "staging");
    const baseline = path.join(dir, "baseline2.json");
    await writeFile(baseline, serializeBaseline(green.report, updateHistory(undefined, green.report)));
    const foreign = path.join(dir, "foreign-history.json");
    await writeFile(foreign, serializeBaseline(other.report, updateHistory(undefined, other.report)));
    for (const history of [foreign, path.join(dir, "missing.json")]) {
      const next = path.join(dir, "next2.json");
      const result = await run({ report: green.file, baseline, history, baselineOut: next });
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.comment, /### Recent failures on main/);
      assert.match(result.stderr, /history .*not used/);
      assert.equal(JSON.parse(await readFile(next, "utf-8")).history.weather["X402-01"], "PP");
    }
  });

  it("does not print a run id that is not a whole number", async () => {
    const green = await runReport(conformantHandler, "green3");
    const baseline = path.join(dir, "baseline3.json");
    await writeFile(baseline, serializeBaseline(green.report, updateHistory(undefined, green.report)));
    for (const baselineRun of ["12; rm", "-1", "0x10", ""]) {
      const result = await run({ report: green.file, baseline, baselineRun });
      assert.match(result.comment, /Compared with the last green run on main, started /, baselineRun);
    }
  });
});
