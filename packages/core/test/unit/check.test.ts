import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type CheckResult,
  checkStatus,
  errored,
  skipped,
  skippedDestructive,
  summarize,
  toStructuredRun,
} from "../../src/check.js";
import {
  CheckSetupError,
  ConfigurationError,
  MalformedResponseError,
  TargetUnreachableError,
} from "../../src/errors.js";

function result(overrides: Partial<CheckResult>): CheckResult {
  return {
    id: "X402-01",
    name: "402 Response Status",
    pass: true,
    detail: "",
    ...overrides,
  };
}

describe("checkStatus", () => {
  it("reports PASS and FAIL from the pass flag", () => {
    assert.equal(checkStatus(result({ pass: true })), "PASS");
    assert.equal(checkStatus(result({ pass: false })), "FAIL");
  });

  it("reports ERROR when the check produced no verdict", () => {
    const noVerdict = result({ pass: false, error: { kind: "unreachable", message: "x" } });
    assert.equal(checkStatus(noVerdict), "ERROR");
  });

  // Order matters: a check that never ran cannot also have errored while
  // running, so SKIP is decided first.
  it("puts SKIP ahead of ERROR", () => {
    const both = result({
      pass: false,
      skipped: true,
      error: { kind: "harness", message: "x" },
    });
    assert.equal(checkStatus(both), "SKIP");
  });

  // The pass flag is never consulted for an errored result, so a harness bug
  // that leaves pass true cannot be laundered into a conformance claim.
  it("never reports PASS for an errored check, whatever the pass flag says", () => {
    const contradictory = result({ pass: true, error: { kind: "harness", message: "x" } });
    assert.equal(checkStatus(contradictory), "ERROR");
  });
});

describe("summarize", () => {
  it("counts each status separately", () => {
    const summary = summarize([
      result({ pass: true }),
      result({ pass: false }),
      result({ pass: false, error: { kind: "unreachable", message: "x" } }),
      result({ pass: false, skipped: true }),
    ]);

    assert.deepEqual(summary, { passed: 1, failed: 1, errored: 1, skipped: 1, exitCode: 1 });
  });

  it("exits 0 when everything conformed", () => {
    assert.equal(summarize([result({ pass: true })]).exitCode, 0);
  });

  it("exits 0 when the only non-passes are skips", () => {
    const results = [result({ pass: true }), result({ pass: false, skipped: true })];
    assert.equal(summarize(results).exitCode, 0);
  });

  it("exits 2 when a check produced no verdict", () => {
    const results = [result({ pass: false, error: { kind: "configuration", message: "x" } })];
    assert.equal(summarize(results).exitCode, 2);
  });

  // A real finding outranks a missing one.
  it("exits 1 when a run has both a failure and an error", () => {
    const results = [
      result({ pass: false }),
      result({ pass: false, error: { kind: "harness", message: "x" } }),
    ];
    assert.equal(summarize(results).exitCode, 1);
  });

  // Characterises current behaviour: an empty run reports as conformant.
  it("exits 0 for an empty run", () => {
    assert.deepEqual(summarize([]), {
      passed: 0,
      failed: 0,
      errored: 0,
      skipped: 0,
      exitCode: 0,
    });
  });
});

describe("errored", () => {
  // The target answered and the answer was wrong: that is a conformance
  // failure, not an inability to reach a verdict.
  it("turns a malformed response into an ordinary failure", () => {
    const built = errored(
      "X402-04",
      "Required Fields Present",
      new MalformedResponseError("price field missing"),
    );

    assert.equal(checkStatus(built), "FAIL");
    assert.equal(built.error, undefined);
    assert.equal(built.detail, "Connected, but the response did not conform: price field missing");
  });

  it("turns an unreachable target into an errored result", () => {
    const built = errored(
      "X402-01",
      "402 Response Status",
      new TargetUnreachableError("http://x.test/", new Error("down")),
    );

    assert.equal(checkStatus(built), "ERROR");
    assert.equal(built.error?.kind, "unreachable");
    assert.match(built.detail, /^Check could not run \(unreachable\)/);
  });

  it("turns a configuration error into an errored result", () => {
    const built = errored("PREFLIGHT", "Run Preflight", new ConfigurationError("bad url"));

    assert.equal(built.error?.kind, "configuration");
    assert.match(built.detail, /^Check could not run \(configuration\)/);
  });

  it("reports a setup failure as no verdict rather than as a defect", () => {
    const result = errored("MPP-11", "Cumulative Commitment Ordering", new CheckSetupError("refused 3 times"));

    assert.equal(checkStatus(result), "ERROR");
    assert.equal(result.pass, false);
    assert.equal(result.error?.kind, "setup");
    assert.equal(summarize([result]).exitCode, 2);
    assert.equal(toStructuredRun([result]).outcome, "no-verdict");
  });

  it("never marks an errored result as passing", () => {
    assert.equal(errored("X402-01", "402 Response Status", new Error("boom")).pass, false);
  });
});

describe("skip builders", () => {
  it("marks a skipped check as neither pass nor failure", () => {
    const built = skipped("X402-02", "Payment Header Present", "the target was never reached");

    assert.equal(checkStatus(built), "SKIP");
    assert.equal(built.pass, false);
    assert.equal(built.skipReason, "the target was never reached");
    assert.equal(built.detail, "Skipped: the target was never reached");
  });

  it("flags a destructive skip so a reporter can gate on it", () => {
    const built = skippedDestructive("MPP-13", "Close Settlement", "not opted in");

    assert.equal(checkStatus(built), "SKIP");
    assert.equal(built.destructive, true);
    assert.equal(built.detail, "Skipped (destructive): not opted in");
  });
});

describe("toStructuredRun", () => {
  // "no-verdict" must never be readable as "compliant" by a script or an
  // agent, which is why the outcome is named rather than left as an exit code.
  it("names the outcome rather than leaking an exit code", () => {
    assert.equal(toStructuredRun([result({ pass: true })]).outcome, "conformant");
    assert.equal(toStructuredRun([result({ pass: false })]).outcome, "non-conformant");

    const noVerdict = [result({ pass: false, error: { kind: "harness", message: "x" } })];
    assert.equal(toStructuredRun(noVerdict).outcome, "no-verdict");
  });

  it("carries errorKind only for errored results", () => {
    const run = toStructuredRun([
      result({ id: "A", pass: true }),
      result({ id: "B", pass: false, error: { kind: "configuration", message: "x" } }),
    ]);

    assert.ok(!("errorKind" in run.results[0]!));
    assert.equal(run.results[1]!.errorKind, "configuration");
  });

  it("always states destructive as a boolean", () => {
    const run = toStructuredRun([
      result({ pass: true }),
      result({ pass: false, skipped: true, destructive: true }),
    ]);

    assert.equal(run.results[0]!.destructive, false);
    assert.equal(run.results[1]!.destructive, true);
  });

  // The CLI's --json and the MCP server's structuredContent both call this,
  // so it must never disagree with the exit code the CLI reports.
  it("agrees with summarize about the counts", () => {
    const results = [
      result({ pass: true }),
      result({ pass: false }),
      result({ pass: false, skipped: true }),
      result({ pass: false, error: { kind: "unreachable", message: "x" } }),
    ];
    const run = toStructuredRun(results);
    const summary = summarize(results);

    assert.equal(run.passed, summary.passed);
    assert.equal(run.failed, summary.failed);
    assert.equal(run.errored, summary.errored);
    assert.equal(run.skipped, summary.skipped);
    assert.equal(run.results.length, results.length);
  });
});
