/**
 * The baseline: the run report of the default branch, and the history carried
 * with it (spec A5, A8 #4's validation side). It is data from an artifact: it is
 * validated before use, and anything that does not validate is ignored.
 *
 * Also the diff against it ("Changed since main"), and the exit rule of a run
 * with and without one (A8 #3, D-021).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type CheckResult, skipped } from "../../src/check.js";
import {
  HISTORY_LIMIT,
  MAX_BASELINE_BYTES,
  ReportFormatError,
  baselineProblem,
  diffReports,
  findRegressions,
  parseRunReport,
  readBaseline,
  recentFailures,
  selectBaseline,
  serializeBaseline,
  updateHistory,
} from "../../src/baseline.js";
import { buildEndpointReport, buildRunReport, skippedPaymentChecks, type RunReport } from "../../src/report.js";
import { readToolVersions } from "../../src/versions.js";
import { runExitCode } from "../../src/verdict.js";
import type { ProtocolId } from "../../src/catalogue.js";

function pass(id: string): CheckResult {
  return { id, name: `${id} name`, pass: true, detail: "ok" };
}
function fail(id: string, detail = "Expected status 402, got 200."): CheckResult {
  return { id, name: `${id} name`, pass: false, detail, hint: "fix it" };
}
const CHALLENGE = ["X402-01", "X402-02", "X402-03", "X402-04", "X402-05"];

/** All five challenge checks pass; the payment group is skipped, read-only. */
function conformant(): CheckResult[] {
  return [...CHALLENGE.map(pass), ...skippedPaymentChecks("x402", "read-only")];
}
/** An x402 v1 service: X402-01 passes, the other four are unsupported. */
function v1(): CheckResult[] {
  return [pass("X402-01"), ...CHALLENGE.slice(1).map((id) => skipped(id, id, "x402 v1", "unsupported"))];
}

function endpoint(name: string, results: CheckResult[], protocol: ProtocolId = "x402") {
  return buildEndpointReport({ name, protocol, method: "GET", path: `/${name}`, results });
}

function report(endpoints: ReturnType<typeof endpoint>[], overrides: { environment?: string; startedAt?: string } = {}): RunReport {
  return buildRunReport({
    environment: overrides.environment ?? "local",
    network: "stellar:testnet",
    startedAt: overrides.startedAt ?? "2026-11-15T10:00:00.000Z",
    versions: readToolVersions("0.7.0"),
    endpoints,
    notes: [],
  });
}

describe("parseRunReport", () => {
  it("accepts a report Wasit wrote, and gives back the same report", () => {
    const original = report([endpoint("weather", conformant()), endpoint("old", v1())]);
    const parsed = parseRunReport(JSON.parse(JSON.stringify(original)));
    assert.deepEqual(parsed, original);
  });

  it("keeps the build a report names, and refuses one that is not seven lower-case hex characters", () => {
    const original = buildRunReport({
      environment: "local",
      network: "stellar:testnet",
      startedAt: "2026-11-15T10:00:00.000Z",
      versions: readToolVersions("0.7.0", "0123456"),
      endpoints: [endpoint("weather", conformant())],
      notes: [],
    });
    const parsed = parseRunReport(JSON.parse(JSON.stringify(original)));
    assert.equal(parsed.wasit.build, "0123456");
    for (const bad of ["main", "ABCDEF0", "0123456789", "012345\n::error::x", 7]) {
      const forged = JSON.parse(JSON.stringify(original));
      forged.wasit.build = bad;
      assert.throws(() => parseRunReport(forged), ReportFormatError, JSON.stringify(bad));
    }
  });

  it("reads an older report that names no build", () => {
    const parsed = parseRunReport(JSON.parse(JSON.stringify(report([endpoint("weather", conformant())]))));
    assert.equal("build" in parsed.wasit, false);
  });

  it("keeps expected and actual on a FAIL, sanitised and cut, and adds none where there were none", () => {
    const withValues: CheckResult = { ...fail("X402-01"), expected: "status 402", actual: "status 200" };
    const original = report([endpoint("weather", [withValues, pass("X402-02")])]);
    const parsed = parseRunReport(JSON.parse(JSON.stringify(original)));
    assert.deepEqual(parsed, original);
    assert.equal(parsed.endpoints[0]!.results[0]!.expected, "status 402");
    assert.equal(parsed.endpoints[0]!.results[0]!.actual, "status 200");
    assert.ok(!("expected" in parsed.endpoints[0]!.results[1]!));

    const forged = JSON.parse(JSON.stringify(original));
    forged.endpoints[0].results[0].actual = `bad\u001b[2J\n::set-output name=x::1 S${"A".repeat(55)} ${"z".repeat(5000)}`;
    forged.endpoints[0].results[0].expected = 7;
    assert.throws(() => parseRunReport(forged), ReportFormatError, "a value that is not a string is refused");
    forged.endpoints[0].results[0].expected = "status 402";
    const clean = parseRunReport(forged).endpoints[0]!.results[0]!.actual ?? "";
    assert.ok(!clean.includes("\u001b"));
    assert.ok(!/^::/m.test(clean));
    assert.ok(!clean.includes("A".repeat(55)));
    assert.ok(clean.length <= 500);
  });

  it("recomputes the totals and the group counts from the endpoints instead of trusting them", () => {
    const original = report([endpoint("weather", conformant())]);
    const forged = JSON.parse(JSON.stringify(original));
    forged.totals.graded = 99;
    forged.endpoints[0].groups.challenge.passed = 99;
    const parsed = parseRunReport(forged);
    assert.equal(parsed.totals.graded, 1);
    assert.equal(parsed.endpoints[0]!.groups.challenge?.passed, 5);
  });

  const mutations: ReadonlyArray<readonly [string, (r: Record<string, any>) => void]> = [
    ["another schema version", (r) => (r["schema"] = 2)],
    ["no endpoints list", (r) => delete r["endpoints"]],
    ["endpoints that are not a list", (r) => (r["endpoints"] = {})],
    ["an unknown outcome", (r) => (r["endpoints"][0].outcome = "great")],
    ["an unknown status", (r) => (r["endpoints"][0].results[0].status = "MAYBE")],
    ["an unknown protocol", (r) => (r["endpoints"][0].protocol = "ftp")],
    ["an unknown skip kind", (r) => (r["endpoints"][0].results[6].skipKind = "whenever")],
    ["a name that is not a string", (r) => (r["endpoints"][0].name = 7)],
    ["a missing versions block", (r) => delete r["wasit"]],
    ["an unknown network class", (r) => (r["networkClass"] = "dev")],
    ["too many endpoints", (r) => (r["endpoints"] = Array(101).fill(r["endpoints"][0]))],
    ["too many results", (r) => (r["endpoints"][0].results = Array(101).fill(r["endpoints"][0].results[0]))],
  ];
  for (const [label, mutate] of mutations) {
    it(`refuses ${label}, naming a path and no value`, () => {
      const value = JSON.parse(JSON.stringify(report([endpoint("weather", conformant())])));
      mutate(value);
      assert.throws(
        () => parseRunReport(value),
        (error: unknown) => error instanceof ReportFormatError && !/great|MAYBE|whenever/.test(error.message),
      );
    });
  }

  it("refuses something that is not an object", () => {
    for (const value of [null, 3, "x", [], true]) assert.throws(() => parseRunReport(value), ReportFormatError);
  });

  it("passes every string through the sanitiser, so a baseline cannot smuggle control characters or a secret", () => {
    const value = JSON.parse(JSON.stringify(report([endpoint("weather", conformant())])));
    value.endpoints[0].results[0].detail = `bad\u001b[2J and S${"A".repeat(55)}\n::set-output name=x::1`;
    const parsed = parseRunReport(value);
    const detail = parsed.endpoints[0]!.results[0]!.detail;
    assert.ok(!detail.includes("\u001b"));
    assert.ok(!detail.includes("A".repeat(55)));
    assert.ok(!/^::/m.test(detail));
  });

  it("cuts a very long detail, and drops keys it does not know", () => {
    const value = JSON.parse(JSON.stringify(report([endpoint("weather", conformant())])));
    value.endpoints[0].results[0].detail = "x".repeat(100_000);
    value.extra = { evil: true };
    const parsed = parseRunReport(value) as unknown as Record<string, unknown>;
    assert.ok(parsed["extra"] === undefined);
    assert.ok((parsed as unknown as RunReport).endpoints[0]!.results[0]!.detail.length <= 4000);
  });
});

describe("readBaseline", () => {
  const good = report([endpoint("weather", conformant())]);

  it("reads a baseline file: the report with a history", () => {
    const result = readBaseline(serializeBaseline(good, updateHistory(undefined, good)));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.baseline.report.endpoints[0]!.name, "weather");
      assert.equal(result.baseline.history["weather"]?.["X402-01"], "P");
    }
  });

  it("reads a plain run report too, and starts the history from it", () => {
    const result = readBaseline(JSON.stringify(good));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.baseline.history["weather"]?.["X402-06"], "S");
  });

  const rejects: ReadonlyArray<readonly [string, string]> = [
    ["text that is not JSON", "not json {"],
    ["an empty file", ""],
    ["JSON that is not a report", '{"hello":"world"}'],
    ["a list", "[]"],
    ["a report with another schema", JSON.stringify({ ...good, schema: 3 })],
    ["a history with a letter that is not a status", JSON.stringify({ ...good, history: { weather: { "X402-01": "PPXP" } } })],
    ["a history longer than the limit", JSON.stringify({ ...good, history: { weather: { "X402-01": "P".repeat(HISTORY_LIMIT + 1) } } })],
    ["a history that is not an object", JSON.stringify({ ...good, history: [] })],
    ["a history whose entry is not an object", JSON.stringify({ ...good, history: { weather: "PPP" } })],
  ];
  for (const [label, text] of rejects) {
    it(`ignores ${label}: no throw, a reason`, () => {
      const result = readBaseline(text);
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.reason.length > 0);
    });
  }

  it("ignores a file over the size limit before parsing it", () => {
    const result = readBaseline(" ".repeat(MAX_BASELINE_BYTES + 1));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /larger than/);
  });

  it("does not let a __proto__ key change anything", () => {
    const text = `{"schema":1,"__proto__":{"polluted":true},"history":{"__proto__":{"X402-01":"F"}}}`;
    readBaseline(text);
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
    const withProto = readBaseline(
      JSON.stringify(good).replace(/^\{/, '{"history":{"__proto__":{"X402-01":"PPP"}},'),
    );
    assert.equal(({} as Record<string, unknown>)["X402-01"], undefined);
    assert.equal(withProto.ok, true);
  });
});

describe("baselineProblem", () => {
  it("is fine for the same environment", () => {
    const now = report([endpoint("weather", conformant())]);
    assert.equal(baselineProblem(now, report([endpoint("weather", conformant())])), undefined);
  });

  it("refuses another environment: a regression must not come from comparing two different services", () => {
    const now = report([endpoint("weather", conformant())], { environment: "staging" });
    const problem = baselineProblem(now, report([endpoint("weather", conformant())]));
    assert.match(problem ?? "", /environment/);
    assert.match(problem ?? "", /local/);
    assert.match(problem ?? "", /staging/);
  });
});

describe("selectBaseline", () => {
  const now = report([endpoint("weather", conformant())]);

  it("is empty when no baseline was looked for", () => {
    assert.deepEqual(selectBaseline(now, undefined), {});
  });

  it("gives the baseline when it validated and is from the same environment", () => {
    const read = readBaseline(JSON.stringify(now));
    const selected = selectBaseline(now, read);
    assert.ok(selected.baseline !== undefined);
    assert.equal(selected.note, undefined);
  });

  it("gives the reason, and no baseline, when the file was ignored", () => {
    const selected = selectBaseline(now, readBaseline("nope"));
    assert.equal(selected.baseline, undefined);
    assert.match(selected.note ?? "", /not valid JSON/);
  });

  it("gives the reason, and no baseline, for another environment", () => {
    const other = report([endpoint("weather", conformant())], { environment: "staging" });
    const selected = selectBaseline(now, readBaseline(JSON.stringify(other)));
    assert.equal(selected.baseline, undefined);
    assert.match(selected.note ?? "", /staging/);
  });
});

describe("updateHistory", () => {
  it("starts from one letter per check: P, F, E, S", () => {
    const history = updateHistory(
      undefined,
      report([endpoint("weather", [pass("X402-01"), fail("X402-02")])]),
    );
    assert.deepEqual(history, { weather: { "X402-01": "P", "X402-02": "F" } });
  });

  it("appends the new run to the previous history, oldest first", () => {
    const first = updateHistory(undefined, report([endpoint("weather", [pass("X402-01")])]));
    const second = updateHistory(first, report([endpoint("weather", [fail("X402-01")])]));
    const third = updateHistory(second, report([endpoint("weather", [skipped("X402-01", "x", "r")])]));
    assert.equal(third["weather"]?.["X402-01"], "PFS");
  });

  it("keeps the last 20 runs only", () => {
    let history = updateHistory(undefined, report([endpoint("weather", [fail("X402-01")])]));
    for (let run = 0; run < 25; run += 1) history = updateHistory(history, report([endpoint("weather", [pass("X402-01")])]));
    assert.equal(history["weather"]?.["X402-01"], "P".repeat(HISTORY_LIMIT));
  });

  it("drops an endpoint or a check that is no longer in the report, and starts a new one", () => {
    const first = updateHistory(undefined, report([endpoint("old", [pass("X402-01")]), endpoint("weather", [pass("X402-01"), pass("X402-02")])]));
    const next = updateHistory(first, report([endpoint("weather", [pass("X402-01")]), endpoint("fresh", [fail("X402-01")])]));
    assert.deepEqual(next, { weather: { "X402-01": "PP" }, fresh: { "X402-01": "F" } });
  });

  it("gives an ERROR the letter E", () => {
    const errorResult: CheckResult = { id: "X402-01", name: "x", pass: false, detail: "d", error: { kind: "unreachable", message: "m" } };
    assert.equal(updateHistory(undefined, report([endpoint("weather", [errorResult])]))["weather"]?.["X402-01"], "E");
  });
});

describe("recentFailures", () => {
  it("counts the F in each history and the length of it, most failures first, and skips checks that never failed", () => {
    const failures = recentFailures({
      weather: { "X402-01": "PPPP", "X402-04": "PFPF" },
      chat: { "X402-01": "FFPP" },
    });
    assert.deepEqual(failures, [
      { endpoint: "weather", check: "X402-04", failed: 2, runs: 4 },
      { endpoint: "chat", check: "X402-01", failed: 2, runs: 4 },
    ]);
  });
});

describe("diffReports", () => {
  it("is empty when nothing changed", () => {
    const now = report([endpoint("weather", conformant())]);
    assert.deepEqual(diffReports(now, report([endpoint("weather", conformant())])), []);
  });

  // main runs the payment tier, a pull request the read-only one (D-022a): a check
  // the tier did not run says nothing about the service, in either direction.
  const PAYMENT = ["X402-06", "X402-07", "X402-08", "X402-09", "X402-10"];
  const paid = (): CheckResult[] => [...CHALLENGE.map(pass), ...PAYMENT.map(pass)];
  const tierSkip = (reason: string, kind: "read-only" | "needs-payer"): CheckResult[] =>
    [...CHALLENGE.map(pass), ...PAYMENT.map((id) => skipped(id, id, reason, kind))];

  it("shows no change for payment checks a pull request did not run, against a main that paid", () => {
    const main = report([endpoint("weather", paid())]);
    for (const now of [
      report([endpoint("weather", conformant())]),
      report([endpoint("weather", tierSkip("payment checks not run: pull request", "read-only"))]),
      report([endpoint("weather", tierSkip("no payer key", "needs-payer"))]),
    ]) {
      assert.deepEqual(diffReports(now, main), []);
      assert.equal(runExitCode(now, main).code, 0);
    }
  });

  it("does not show a FAIL on main as fixed by a pull request that did not run that check", () => {
    const main = report([endpoint("weather", [...CHALLENGE.map(pass), pass("X402-06"), fail("X402-07"), ...["X402-08", "X402-09", "X402-10"].map(pass)])]);
    const now = report([endpoint("weather", conformant())]);
    assert.deepEqual(diffReports(now, main), []);
  });

  it("still shows a payment check that changed between two runs that both ran it", () => {
    const main = report([endpoint("weather", paid())]);
    const now = report([endpoint("weather", [...CHALLENGE.map(pass), pass("X402-06"), fail("X402-07"), ...["X402-08", "X402-09", "X402-10"].map(pass)])]);
    assert.deepEqual(
      diffReports(now, main).filter((change) => change.check === "X402-07").map((change) => change.kind),
      ["new-failure"],
    );
  });

  it("shows no change when main did not run a check that the run now passes", () => {
    const main = report([endpoint("weather", conformant())]);
    const now = report([endpoint("weather", paid())]);
    assert.deepEqual(diffReports(now, main), []);
  });

  it("names a new FAIL with the check and what it was", () => {
    const before = report([endpoint("weather", conformant())]);
    const now = report([endpoint("weather", [pass("X402-01"), fail("X402-02")])]);
    const changes = diffReports(now, before);
    assert.deepEqual(
      changes.filter((change) => change.kind === "new-failure"),
      [{ kind: "new-failure", endpoint: "weather", check: "X402-02", from: "PASS", to: "FAIL" }],
    );
  });

  it("names a fixed check", () => {
    const before = report([endpoint("weather", [pass("X402-01"), fail("X402-02")])]);
    const now = report([endpoint("weather", conformant())]);
    assert.deepEqual(
      diffReports(now, before).filter((change) => change.kind === "fixed"),
      [{ kind: "fixed", endpoint: "weather", check: "X402-02", from: "FAIL", to: "PASS" }],
    );
  });

  it("names a new endpoint and a removed one", () => {
    const before = report([endpoint("weather", conformant()), endpoint("gone", conformant())]);
    const now = report([endpoint("weather", conformant()), endpoint("fresh", conformant())]);
    const changes = diffReports(now, before);
    assert.ok(changes.some((change) => change.kind === "new-endpoint" && change.endpoint === "fresh"));
    assert.ok(changes.some((change) => change.kind === "removed-endpoint" && change.endpoint === "gone"));
  });

  it("names a graded endpoint that is now unsupported a regression, and the checks that changed under it", () => {
    const before = report([endpoint("weather", conformant())]);
    const now = report([endpoint("weather", [...v1(), ...skippedPaymentChecks("x402", "read-only")])]);
    const changes = diffReports(now, before);
    assert.deepEqual(
      changes.filter((change) => change.kind === "regression"),
      [{ kind: "regression", endpoint: "weather", from: "conformant", to: "unsupported" }],
    );
    assert.ok(changes.some((change) => change.kind === "status-changed" && change.check === "X402-02"));
  });

  it("names an endpoint that is graded now and was not 'graded'", () => {
    const before = report([endpoint("weather", v1())]);
    const now = report([endpoint("weather", conformant())]);
    assert.deepEqual(
      diffReports(now, before).filter((change) => change.kind === "graded"),
      [{ kind: "graded", endpoint: "weather", from: "unsupported", to: "conformant" }],
    );
  });

  it("does not report a check that is only in one of the two as a change", () => {
    const before = report([endpoint("weather", [pass("X402-01")])]);
    const now = report([endpoint("weather", [pass("X402-01"), pass("X402-02")])]);
    assert.deepEqual(diffReports(now, before), []);
  });
});

describe("findRegressions", () => {
  it("is a graded endpoint (conformant or non-conformant) that is now unsupported or without a verdict", () => {
    const before = report([endpoint("a", conformant()), endpoint("b", [fail("X402-01")]), endpoint("c", conformant())]);
    const now = report([endpoint("a", v1()), endpoint("b", skippedPaymentChecks("x402", "read-only")), endpoint("c", conformant())]);
    assert.deepEqual(findRegressions(now, before), [
      { endpoint: "a", was: "conformant", now: "unsupported" },
      { endpoint: "b", was: "non-conformant", now: "no-verdict" },
    ]);
  });

  it("is not a regression when the endpoint was not graded before, or is gone", () => {
    const before = report([endpoint("a", v1()), endpoint("gone", conformant())]);
    const now = report([endpoint("a", v1())]);
    assert.deepEqual(findRegressions(now, before), []);
  });
});

describe("runExitCode", () => {
  it("is 0 when every endpoint is conformant", () => {
    const verdict = runExitCode(report([endpoint("a", conformant()), endpoint("b", conformant())]));
    assert.equal(verdict.code, 0);
  });

  it("is 1 for a non-conformant endpoint, even beside one that could not run", () => {
    const errorResult: CheckResult = { id: "X402-01", name: "x", pass: false, detail: "d", error: { kind: "unreachable", message: "m" } };
    const verdict = runExitCode(report([endpoint("a", [fail("X402-01")]), endpoint("b", [errorResult])]));
    assert.equal(verdict.code, 1);
    assert.match(verdict.reason, /non-conformant/);
  });

  it("is 2 when nothing was graded: only an unsupported endpoint, said with the counts", () => {
    const verdict = runExitCode(report([endpoint("old", v1())]));
    assert.equal(verdict.code, 2);
    assert.match(verdict.reason, /nothing could be graded/);
    assert.match(verdict.reason, /0 graded, 1 unsupported/);
  });

  it("is 2 when a check could not run, although something else was graded", () => {
    const errorResult: CheckResult = { id: "X402-01", name: "x", pass: false, detail: "d", error: { kind: "unreachable", message: "m" } };
    const verdict = runExitCode(report([endpoint("a", conformant()), endpoint("b", [errorResult])]));
    assert.equal(verdict.code, 2);
    assert.match(verdict.reason, /could not run/);
  });

  it("stays 0 for an unsupported endpoint beside a graded one, and the reason counts it", () => {
    const verdict = runExitCode(report([endpoint("a", conformant()), endpoint("old", v1())]));
    assert.equal(verdict.code, 0);
    assert.match(verdict.reason, /1 graded, 1 unsupported/);
  });

  it("is 2 when payment checks were asked for and could not be graded on one endpoint, although another was graded (review of S1, finding 1)", () => {
    const unsupportedPayment = [
      ...CHALLENGE.map(pass),
      ...["X402-06", "X402-07", "X402-08", "X402-09", "X402-10"].map((id) => skipped(id, `${id} name`, "no payment adapter for eip155:1", "unsupported")),
    ];
    const now = report([endpoint("a", conformant()), endpoint("pay", unsupportedPayment)]);
    const verdict = runExitCode(now);
    assert.equal(verdict.code, 2);
    assert.match(verdict.reason, /payment checks/);
    assert.match(verdict.reason, /could not be graded/);
    assert.equal(now.endpoints[1]!.outcome, "no-verdict");
    assert.match(now.endpoints[1]!.reason ?? "", /no payment adapter/);
    // A FAIL elsewhere still outranks it.
    assert.equal(runExitCode(report([endpoint("a", [fail("X402-01")]), endpoint("pay", unsupportedPayment)])).code, 1);
  });

  it("stays 0 for an MPP endpoint the read-only tier could not grade, beside a conformant x402 one", () => {
    const verdict = runExitCode(
      report([endpoint("a", conformant()), endpoint("chat", skippedPaymentChecks("mpp-charge", "read-only"), "mpp-charge")]),
    );
    assert.equal(verdict.code, 0);
    assert.match(verdict.reason, /1 no verdict/);
  });

  it("is 1 with a baseline when a graded endpoint is now unsupported, and lists it", () => {
    const before = report([endpoint("a", conformant()), endpoint("b", conformant())]);
    const now = report([endpoint("a", conformant()), endpoint("b", v1())]);
    assert.equal(runExitCode(now).code, 0, "without the baseline it is green");
    const verdict = runExitCode(now, before);
    assert.equal(verdict.code, 1);
    assert.deepEqual(verdict.regressions, [{ endpoint: "b", was: "conformant", now: "unsupported" }]);
    assert.match(verdict.reason, /b/);
    assert.match(verdict.reason, /regress/);
  });

  it("is 1 with a baseline when the only endpoint turns unsupported: the regression outranks 'nothing graded'", () => {
    const before = report([endpoint("a", conformant())]);
    const now = report([endpoint("a", v1())]);
    assert.equal(runExitCode(now, before).code, 1);
  });

  it("is 2 without a baseline for the same report: never graded is not green", () => {
    assert.equal(runExitCode(report([endpoint("a", v1())])).code, 2);
  });

  it("does not call an endpoint that was never graded on main a regression", () => {
    const before = report([endpoint("a", v1())]);
    const now = report([endpoint("a", v1())]);
    const verdict = runExitCode(now, before);
    assert.equal(verdict.code, 2);
    assert.deepEqual(verdict.regressions, []);
  });
});
