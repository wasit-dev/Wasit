/**
 * What the read-only tier reports for the checks it does not run, the exit
 * rule for one endpoint (`wasit test`, the MCP x402 tool), and the redaction of
 * a report (spec A2, A8 #3 and #6, D-021).
 *
 * The rule: an endpoint counts as tested only when it is `conformant` or
 * `non-conformant`. A service that was never graded exits 2, "no verdict": not
 * green, and not labelled FAIL.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type CheckResult, checkStatus, errored, skipped } from "../../src/check.js";
import { ConfigurationError } from "../../src/errors.js";
import {
  buildEndpointReport,
  buildRunReport,
  endpointOutcome,
  exitCodeForEndpoint,
  redactReport,
  skippedPaymentChecks,
  toGradedRun,
} from "../../src/report.js";
import { readToolVersions } from "../../src/versions.js";

function pass(id: string): CheckResult {
  return { id, name: id, pass: true, detail: "ok" };
}
function fail(id: string): CheckResult {
  return { id, name: id, pass: false, detail: "wrong", hint: "fix it" };
}
const CHALLENGE = ["X402-01", "X402-02", "X402-03", "X402-04", "X402-05"];
const PAYMENT = ["X402-06", "X402-07", "X402-08", "X402-09", "X402-10", "X402-11"];

function v1Results(): CheckResult[] {
  return [pass("X402-01"), ...CHALLENGE.slice(1).map((id) => skipped(id, id, "x402 v1", "unsupported"))];
}

describe("skippedPaymentChecks", () => {
  it("lists X402-06..11 for x402, each a SKIP of the kind it was given, named from the catalogue", () => {
    const checks = skippedPaymentChecks("x402", "read-only");
    assert.deepEqual(checks.map((check) => check.id), ["X402-06", "X402-07", "X402-08", "X402-09", "X402-10", "X402-11"]);
    for (const check of checks) {
      assert.equal(checkStatus(check), "SKIP", check.id);
      assert.equal(check.skipKind, "read-only", check.id);
      assert.notEqual(check.name, check.id, "the name comes from the catalogue");
    }
    assert.equal(checks[0]!.name, "Signature Resubmit Accepted");
  });

  it("says in the reason that the checks pay, and need a payer and the payment tier", () => {
    const [first] = skippedPaymentChecks("x402", "read-only");
    assert.match(first!.skipReason ?? "", /read-only/);
    assert.match(first!.skipReason ?? "", /payer/);
    assert.match(first!.skipReason ?? "", /payment tier/);
  });

  it("gives needs-payer its own reason: the run was allowed to pay and had no key", () => {
    const [first] = skippedPaymentChecks("x402", "needs-payer");
    assert.equal(first!.skipKind, "needs-payer");
    assert.match(first!.skipReason ?? "", /no payer key/);
  });

  it("lists MPP-01 for a charge endpoint", () => {
    assert.deepEqual(skippedPaymentChecks("mpp-charge", "read-only").map((check) => check.id), ["MPP-01"]);
  });

  it("lists MPP-10, 11, 12 and 14 for a channel endpoint, and never MPP-13", () => {
    const ids = skippedPaymentChecks("mpp-channel", "read-only").map((check) => check.id);
    assert.deepEqual(ids, ["MPP-10", "MPP-11", "MPP-12", "MPP-14"]);
    assert.ok(!ids.includes("MPP-13"));
  });
});

describe("exitCodeForEndpoint", () => {
  it("is 0 for a conformant endpoint, with its payment group skipped", () => {
    const results = [...CHALLENGE.map(pass), ...skippedPaymentChecks("x402", "read-only")];
    assert.equal(exitCodeForEndpoint(results, "x402"), 0);
  });

  it("is 1 on any FAIL", () => {
    assert.equal(exitCodeForEndpoint([pass("X402-01"), fail("X402-04")], "x402"), 1);
  });

  it("is 2 for an x402 v1 service: it was never graded, and that is neither green nor a FAIL", () => {
    assert.equal(exitCodeForEndpoint(v1Results(), "x402"), 2);
  });

  it("is 2 when a check errored and nothing failed", () => {
    assert.equal(exitCodeForEndpoint([pass("X402-01"), errored("X402-06", "x", new ConfigurationError("setup"))], "x402"), 2);
  });

  it("is 2 when nothing ran, or everything was skipped", () => {
    assert.equal(exitCodeForEndpoint([], "x402"), 2);
    assert.equal(exitCodeForEndpoint(skippedPaymentChecks("x402", "read-only"), "x402"), 2);
  });

  it("lets a FAIL outrank everything", () => {
    assert.equal(exitCodeForEndpoint([...v1Results(), fail("X402-06")], "x402"), 1);
  });

  // Najmi, 2026-11-15 (review of S1, finding 1): payment checks were asked for and none could be
  // graded on this network (a typo, eip155:1). Green would hide it; 0.7.0 exited 2 here too.
  it("is 2 when the payment group is unsupported: the challenge was graded, but the payment checks asked for were not", () => {
    const results = [...CHALLENGE.map(pass), ...PAYMENT.map((id) => skipped(id, id, "no payment adapter for eip155:1", "unsupported"))];
    assert.equal(exitCodeForEndpoint(results, "x402"), 2);
    assert.equal(endpointOutcome(results, "x402"), "no-verdict");
  });

  it("lets a FAIL in the challenge outrank an unsupported payment group", () => {
    const results = [pass("X402-01"), fail("X402-04"), ...PAYMENT.map((id) => skipped(id, id, "no adapter", "unsupported"))];
    assert.equal(exitCodeForEndpoint(results, "x402"), 1);
  });

  it("stays 0 when the payment group is skipped for another reason: read-only, or no payer key", () => {
    assert.equal(exitCodeForEndpoint([...CHALLENGE.map(pass), ...skippedPaymentChecks("x402", "needs-payer")], "x402"), 0);
  });
});

describe("toGradedRun with an unsupported payment group", () => {
  it("names the run no-verdict, for an MCP agent as for the shell", () => {
    const results = [...CHALLENGE.map(pass), ...PAYMENT.map((id) => skipped(id, id, "no payment adapter for eip155:1", "unsupported"))];
    assert.equal(toGradedRun(results, "x402").outcome, "no-verdict");
  });
});

describe("toGradedRun", () => {
  it("names a v1 service no-verdict, with the counts of toStructuredRun, so an MCP agent cannot read it as conformant", () => {
    const run = toGradedRun(v1Results(), "x402");
    assert.equal(run.outcome, "no-verdict");
    assert.equal(run.passed, 1);
    assert.equal(run.skipped, 4);
    assert.equal(run.failed, 0);
  });

  it("agrees with exitCodeForEndpoint: 0 conformant, 1 non-conformant, 2 no-verdict", () => {
    const conformant = CHALLENGE.map(pass);
    assert.equal(toGradedRun(conformant, "x402").outcome, "conformant");
    assert.equal(toGradedRun([fail("X402-01")], "x402").outcome, "non-conformant");
    assert.equal(toGradedRun([], "x402").outcome, "no-verdict");
  });
});

describe("the reason of an endpoint that only the read-only tier left without a verdict", () => {
  it("names the tier, not 'every check was skipped'", () => {
    const report = buildEndpointReport({
      name: "chat",
      protocol: "mpp-charge",
      method: "GET",
      path: "/mpp/chat",
      results: skippedPaymentChecks("mpp-charge", "read-only"),
    });
    assert.equal(report.outcome, "no-verdict");
    assert.match(report.reason ?? "", /read-only/);
    assert.match(report.reason ?? "", /payment tier/);
  });

  it("keeps the error text for an endpoint that errored", () => {
    const report = buildEndpointReport({
      name: "w",
      protocol: "x402",
      method: "GET",
      path: "/w",
      results: [errored("X402-01", "x", new ConfigurationError("could not connect"))],
    });
    assert.match(report.reason ?? "", /could not connect/);
  });
});

describe("redactReport", () => {
  const CANARY = "canary-header-value-7f3a";

  function reportWith(text: string) {
    const endpoint = buildEndpointReport({
      name: "weather",
      protocol: "x402",
      method: "GET",
      path: "/w",
      results: [
        { id: "X402-01", name: "402 Response Status", pass: false, detail: text, hint: `echoed ${text}` },
      ],
    });
    return buildRunReport({
      environment: "local",
      network: "stellar:testnet",
      startedAt: "2026-11-15T00:00:00.000Z",
      versions: readToolVersions("0.7.0"),
      endpoints: [endpoint],
      notes: [`note ${text}`],
    });
  }

  it("removes a value from every string of the report, a service echo of a header included", () => {
    const report = reportWith(`the service said: ${CANARY}`);
    assert.ok(JSON.stringify(report).includes(CANARY), "the canary is there before");
    const clean = redactReport(report, [CANARY]);
    assert.ok(!JSON.stringify(clean).includes(CANARY));
    assert.match(JSON.stringify(clean), /\[redacted\]/);
  });

  it("changes nothing else, and does not change its input", () => {
    const report = reportWith("plain");
    const before = JSON.stringify(report);
    const clean = redactReport(report, [CANARY]);
    assert.equal(JSON.stringify(clean), before);
    assert.equal(JSON.stringify(report), before);
  });

  it("leaves numbers, booleans and the report's own shape alone", () => {
    const clean = redactReport(reportWith("plain"), [CANARY]);
    assert.equal(clean.schema, 1);
    assert.equal(clean.totals.endpoints, 1);
    assert.equal(clean.endpoints[0]!.results[0]!.destructive, false);
  });
});
