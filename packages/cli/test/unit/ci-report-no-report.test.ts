/**
 * `wasit ci-report` when the run left no usable report (the service never
 * started, never answered, or the config could not be used).
 *
 * SOW 2 Deliverable 1: one comment, updated on each push. A comment from the
 * push before must not stay next to a red check, so the report step writes a
 * "no verdict" comment and summary instead of nothing. It decides nothing about
 * the job (the result of `wasit run` does), and it never writes a baseline.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { executeCiReport, type CiReportOptions } from "../../src/ci-report-command.js";

const MARKER = "<!-- wasit-report -->";

describe("wasit ci-report without a usable report", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-ci-report-none-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function ciReport(options: Partial<CiReportOptions> & { report: string }, name: string) {
    const comment = path.join(dir, `${name}.comment.md`);
    const summary = path.join(dir, `${name}.summary.md`);
    const baselineOut = path.join(dir, `${name}.baseline.json`);
    const out: string[] = [];
    const err: string[] = [];
    const code = await executeCiReport(
      { comment, summary, baselineOut, ...options },
      { env: { PATH: process.env["PATH"] ?? "" }, stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    );
    return { code, stdout: out.join("\n"), stderr: err.join("\n"), comment, summary, baselineOut };
  }

  it("writes a no-verdict comment and summary when the report was never written, and exits 0", async () => {
    const result = await ciReport({ report: path.join(dir, "missing.report.json") }, "missing");
    assert.equal(result.code, 0, result.stderr);
    const comment = await readFile(result.comment, "utf-8");
    assert.ok(comment.startsWith(`${MARKER}\n`), "the marker is the first line, so the comment replaces the earlier one");
    assert.match(comment, /Wasit: no verdict\./);
    assert.match(comment, /nothing was graded/i);
    assert.match(comment, /job log/);
    assert.ok(!/conformant\./.test(comment.replace("non-conformant", "")), "it never says conformant");
    const summary = await readFile(result.summary, "utf-8");
    assert.ok(!summary.includes(MARKER), "the summary has no marker");
    assert.match(summary, /Wasit: no verdict\./);
  });

  it("names the Wasit and SDK versions, as every result does", async () => {
    const result = await ciReport({ report: path.join(dir, "missing-2.report.json") }, "versions");
    const comment = await readFile(result.comment, "utf-8");
    assert.match(comment, /Wasit \d+\.\d+\.\d+\S* \(core \d+\.\d+\.\d+\S*\), x402 v2, @x402\/core /);
  });

  it("never writes a baseline: a run that graded nothing must not become the baseline of main", async () => {
    const result = await ciReport({ report: path.join(dir, "missing-3.report.json") }, "nobaseline");
    assert.equal(existsSync(result.baselineOut), false);
  });

  it("writes the same comment, and exits 2, when the report is not usable, without quoting the file", async () => {
    const bad = path.join(dir, "bad.report.json");
    await writeFile(bad, '{"canary-from-the-file": "S' + "A".repeat(55) + '" ');
    const result = await ciReport({ report: bad }, "bad");
    assert.equal(result.code, 2);
    const comment = await readFile(result.comment, "utf-8");
    assert.ok(comment.startsWith(`${MARKER}\n`));
    assert.match(comment, /Wasit: no verdict\./);
    assert.ok(!comment.includes("canary-from-the-file"), "nothing from the file reaches the comment");
    assert.ok(!result.stderr.includes("canary-from-the-file"));
    assert.equal(existsSync(result.baselineOut), false);
  });

  it("does not fail when no summary file is wanted", async () => {
    const comment = path.join(dir, "only.comment.md");
    const code = await executeCiReport(
      { report: path.join(dir, "missing-4.report.json"), comment },
      { env: { PATH: process.env["PATH"] ?? "" }, stdout: () => {}, stderr: () => {} },
    );
    assert.equal(code, 0);
    assert.ok(existsSync(comment));
  });
});
