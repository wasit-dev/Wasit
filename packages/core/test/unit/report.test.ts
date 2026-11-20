/**
 * The run report model (spec A2, A3, A8 #3): the endpoint outcome, the counts per
 * group, the totals and the line that says how many endpoints were graded.
 *
 * The rule the exit code will rest on: an endpoint counts as tested only when
 * its outcome is `conformant` or `non-conformant`. A service Wasit cannot grade
 * is `unsupported`, which is neither a FAIL nor a pass.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type CheckResult, errored, skipped } from "../../src/check.js";
import { ConfigurationError } from "../../src/errors.js";
import {
  buildEndpointReport,
  buildRunReport,
  checkGroup,
  describeTotals,
  endpointOutcome,
  reportTotals,
  type EndpointReport,
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

describe("checkGroup", () => {
  it("puts X402-01..05 in challenge and X402-06..11 in payment", () => {
    for (const id of CHALLENGE) assert.equal(checkGroup(id, "x402"), "challenge", id);
    for (const id of PAYMENT) assert.equal(checkGroup(id, "x402"), "payment", id);
  });

  it("puts MPP-01 in mppCharge and MPP-10..14 in mppChannel", () => {
    assert.equal(checkGroup("MPP-01", "mpp-charge"), "mppCharge");
    for (const id of ["MPP-10", "MPP-11", "MPP-12", "MPP-13", "MPP-14"]) assert.equal(checkGroup(id, "mpp-channel"), "mppChannel", id);
  });

  it("puts an id with no catalogue entry (PREFLIGHT) in the endpoint's own group", () => {
    assert.equal(checkGroup("PREFLIGHT", "x402"), "challenge");
    assert.equal(checkGroup("PREFLIGHT", "mpp-charge"), "mppCharge");
    assert.equal(checkGroup("PREFLIGHT", "mpp-channel"), "mppChannel");
  });
});

describe("endpointOutcome", () => {
  it("is conformant when the checks that ran passed and the rest were skipped", () => {
    const results = [...CHALLENGE.map(pass), ...PAYMENT.map((id) => skipped(id, id, "no payer", "needs-payer"))];
    assert.equal(endpointOutcome(results, "x402"), "conformant");
  });

  it("is non-conformant on any FAIL", () => {
    assert.equal(endpointOutcome([pass("X402-01"), fail("X402-04")], "x402"), "non-conformant");
  });

  it("is no-verdict when a check errored and nothing failed", () => {
    const results = [pass("X402-01"), errored("X402-06", "x", new ConfigurationError("setup"))];
    assert.equal(endpointOutcome(results, "x402"), "no-verdict");
  });

  it("is no-verdict when nothing passed: nothing was graded", () => {
    assert.equal(endpointOutcome([], "x402"), "no-verdict");
    assert.equal(endpointOutcome(CHALLENGE.map((id) => skipped(id, id, "dependency", "dependency")), "x402"), "no-verdict");
  });

  it("is unsupported for an x402 v1 challenge, although X402-01 passed", () => {
    assert.equal(endpointOutcome(v1Results(), "x402"), "unsupported");
  });

  it("lets a FAIL outrank unsupported, and unsupported outrank an error", () => {
    assert.equal(endpointOutcome([...v1Results().slice(0, 3), fail("X402-04"), v1Results()[4]!], "x402"), "non-conformant");
    assert.equal(
      endpointOutcome([...v1Results(), errored("X402-06", "x", new ConfigurationError("setup"))], "x402"),
      "unsupported",
    );
  });

  it("does not call an endpoint unsupported because the payment group was, but not conformant either: no verdict (Najmi, 2026-11-15)", () => {
    // The challenge was graded, so the endpoint is not "unsupported"; the payment checks were asked for and
    // none could be graded, so it is not green.
    const results = [...CHALLENGE.map(pass), ...PAYMENT.map((id) => skipped(id, id, "not a network Wasit pays on", "unsupported"))];
    assert.equal(endpointOutcome(results, "x402"), "no-verdict");
  });

  it("calls an MPP endpoint unsupported when its only group is", () => {
    assert.equal(endpointOutcome([skipped("MPP-01", "x", "network", "unsupported")], "mpp-charge"), "unsupported");
    assert.equal(endpointOutcome([skipped("MPP-10", "x", "network", "unsupported"), pass("MPP-11")], "mpp-channel"), "unsupported");
  });

  it("does not treat an unsupported skip in another protocol's group as the endpoint's", () => {
    assert.equal(endpointOutcome([pass("X402-01"), skipped("MPP-01", "x", "r", "unsupported")], "x402"), "conformant");
  });
});

describe("buildEndpointReport", () => {
  it("counts per group, with sanitised structured results", () => {
    const report = buildEndpointReport({
      name: "weather",
      protocol: "x402",
      method: "GET",
      path: "/api/weather",
      results: [...CHALLENGE.map(pass), ...PAYMENT.map((id) => skipped(id, id, "read-only", "read-only"))],
    });
    assert.equal(report.outcome, "conformant");
    assert.deepEqual(report.groups["challenge"], { passed: 5, failed: 0, errored: 0, skipped: 0 });
    assert.deepEqual(report.groups["payment"], { passed: 0, failed: 0, errored: 0, skipped: 6 });
    assert.equal(report.groups["mppCharge"], undefined);
    assert.equal(report.results.length, 11);
    assert.equal(report.results[5]?.skipKind, "read-only");
  });

  it("states why an endpoint is unsupported or without a verdict, and nothing otherwise", () => {
    const v1 = buildEndpointReport({ name: "a", protocol: "x402", method: "GET", path: "/a", results: v1Results() });
    assert.equal(v1.outcome, "unsupported");
    assert.equal(v1.reason, "x402 v1");

    const broken = buildEndpointReport({
      name: "b", protocol: "x402", method: "GET", path: "/b",
      results: [errored("X402-01", "402 Response Status", new ConfigurationError("The route redirects to http://other"))],
    });
    assert.equal(broken.outcome, "no-verdict");
    assert.match(broken.reason ?? "", /The route redirects to/);

    const fine = buildEndpointReport({ name: "c", protocol: "x402", method: "GET", path: "/c", results: CHALLENGE.map(pass) });
    assert.equal(fine.reason, undefined);
  });

  it("passes the name, method and path through the sanitiser", () => {
    const report = buildEndpointReport({
      name: "a\u001b[2J", protocol: "x402", method: "GET", path: "/p\u0007\n::error::x", results: CHALLENGE.map(pass),
    });
    assert.equal(report.name, "a[2J");
    assert.equal(report.path, "/p\n: :error::x");
  });
});

function endpoint(outcome: EndpointReport["outcome"]): EndpointReport {
  return { name: outcome, protocol: "x402", method: "GET", path: "/", outcome, groups: {}, results: [] };
}

describe("reportTotals and describeTotals", () => {
  it("counts an endpoint as graded only when it is conformant or non-conformant", () => {
    const totals = reportTotals([endpoint("conformant"), endpoint("non-conformant"), endpoint("unsupported"), endpoint("no-verdict")]);
    assert.deepEqual(totals, { endpoints: 4, graded: 2, conformant: 1, nonConformant: 1, noVerdict: 1, unsupported: 1 });
  });

  it("says '0 graded, 1 unsupported' so a green run cannot be read as a pass", () => {
    assert.equal(describeTotals(reportTotals([endpoint("unsupported")])), "0 graded, 1 unsupported");
  });

  it("lists only the categories that have endpoints", () => {
    assert.equal(describeTotals(reportTotals([endpoint("conformant"), endpoint("conformant")])), "2 graded");
    assert.equal(describeTotals(reportTotals([endpoint("conformant"), endpoint("non-conformant"), endpoint("no-verdict")])), "2 graded (1 non-conformant), 1 no verdict");
    assert.equal(describeTotals(reportTotals([])), "0 graded");
  });
});

describe("buildRunReport", () => {
  it("builds the report: schema 1, versions as given, the guard's class of the network, totals, notes", () => {
    const versions = readToolVersions("0.7.0");
    const endpoints = [buildEndpointReport({ name: "a", protocol: "x402", method: "GET", path: "/a", results: v1Results() })];
    const report = buildRunReport({
      environment: "local", network: "stellar:testnet", startedAt: "2026-11-15T10:00:00.000Z", versions, endpoints,
    });
    assert.equal(report.schema, 1);
    assert.deepEqual(report.wasit, versions.wasit);
    assert.deepEqual(report.sdk, versions.sdk);
    assert.equal(report.networkClass, "test");
    assert.equal(report.environment, "local");
    assert.equal(report.startedAt, "2026-11-15T10:00:00.000Z");
    assert.deepEqual(report.totals, { endpoints: 1, graded: 0, conformant: 0, nonConformant: 0, noVerdict: 0, unsupported: 1 });
    assert.deepEqual(report.notes, []);
    assert.equal(JSON.parse(JSON.stringify(report)).endpoints[0].outcome, "unsupported");
  });

  it("classifies mainnet and an unknown network through the guard's table, and keeps notes sanitised", () => {
    const base = { environment: "e", startedAt: "2026-11-15T10:00:00.000Z", versions: readToolVersions("0.7.0"), endpoints: [] };
    assert.equal(buildRunReport({ ...base, network: "stellar:pubnet" }).networkClass, "mainnet-optin");
    assert.equal(buildRunReport({ ...base, network: "ach:us" }).networkClass, "unknown");
    assert.deepEqual(buildRunReport({ ...base, network: "stellar:testnet", notes: ["a\u001b[2J", "::error::x"] }).notes, ["a[2J", ": :error::x"]);
  });
});

describe("a secret in a check's text", () => {
  it("does not reach the report: not in a detail, a name, a reason or a note", () => {
    const secret = `S${"C".repeat(55)}`;
    const report = buildRunReport({
      environment: `e-${secret}`,
      network: "stellar:testnet",
      startedAt: "2026-11-15T10:00:00.000Z",
      versions: readToolVersions("0.7.0"),
      notes: [`note ${secret}`],
      endpoints: [
        buildEndpointReport({
          name: `name-${secret}`,
          protocol: "x402",
          method: "GET",
          path: `/p?k=${secret}`,
          results: [
            { id: "X402-01", name: `n-${secret}`, pass: false, detail: `got ${secret}`, hint: `fix ${secret}` },
            errored("X402-02", "x", new ConfigurationError(`cannot ${secret}`)),
          ],
        }),
      ],
    });
    assert.equal(JSON.stringify(report).includes(secret), false);
  });
});
