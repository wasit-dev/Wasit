/**
 * `renderComment` and `renderSummary`: the pull request comment and the job
 * summary, pure functions over the run report and, when there is one, the
 * baseline of the default branch (spec A4, A5, A8 #6).
 *
 * Text a service sent reaches these through the check details, so the tests
 * hold the output to the rules of the sanitiser: no HTML, no link, no mention,
 * no line a runner reads as a command, no control character, no value over 300
 * characters, and no secret. The shape of a normal comment is pinned by golden
 * files in `test/fixtures/ci-report/`; to rewrite them after a change you meant
 * to make, run the tests with WASIT_UPDATE_SNAPSHOTS=1 and read the diff.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { type Baseline, updateHistory } from "../../src/baseline.js";
import { COMMENT_MARKER, renderComment, renderSummary } from "../../src/ci-report.js";
import { catalogueEntry } from "../../src/catalogue.js";
import { type CheckResult, errored, skipped } from "../../src/check.js";
import { ConfigurationError } from "../../src/errors.js";
import {
  buildEndpointReport,
  buildRunReport,
  skippedPaymentChecks,
  type RunReport,
} from "../../src/report.js";
import type { ProtocolId } from "../../src/catalogue.js";
import { readToolVersions, type ToolVersions } from "../../src/versions.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/ci-report/", import.meta.url));

/** Compares `actual` with the golden file `name`; writes it when WASIT_UPDATE_SNAPSHOTS=1. */
function expectSnapshot(name: string, actual: string): void {
  const file = `${FIXTURES}${name}`;
  if (process.env["WASIT_UPDATE_SNAPSHOTS"] === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.ok(existsSync(file), `no golden file ${name}: run once with WASIT_UPDATE_SNAPSHOTS=1 and read it`);
  assert.equal(actual, readFileSync(file, "utf-8"));
}

/** Fixed versions, so a golden file does not change with an install. */
const VERSIONS: ToolVersions = {
  wasit: { cli: "0.7.0", core: "0.7.0" },
  sdk: {
    x402Version: 2,
    "@x402/core": "2.28.0",
    "@x402/stellar": "2.28.0",
    "@stellar/mpp": "0.7.1",
    mppx: "0.8.14",
    "@stellar/stellar-sdk": "16.1.0",
  },
};

function pass(id: string, name = catalogueEntry(id)?.name ?? id): CheckResult {
  return { id, name, pass: true, detail: "ok" };
}
function fail(
  id: string,
  detail: string,
  hint = "Send the challenge in the PAYMENT-REQUIRED header.",
  values: { expected?: string; actual?: string } = {},
): CheckResult {
  return { id, name: catalogueEntry(id)?.name ?? id, pass: false, detail, hint, ...values };
}
const CHALLENGE = ["X402-01", "X402-02", "X402-03", "X402-04", "X402-05"];

function conformant(): CheckResult[] {
  return [...CHALLENGE.map((id) => pass(id)), ...skippedPaymentChecks("x402", "read-only")];
}
function v1(): CheckResult[] {
  return [
    pass("X402-01"),
    ...CHALLENGE.slice(1).map((id) =>
      skipped(
        id,
        id,
        "the service sent an x402 v1 challenge in its response body. To have it graded, move to x402 v2: send the challenge base64-encoded in a PAYMENT-REQUIRED response header.",
        "unsupported",
      ),
    ),
    ...skippedPaymentChecks("x402", "read-only"),
  ];
}

function endpoint(name: string, results: CheckResult[], protocol: ProtocolId = "x402") {
  return buildEndpointReport({ name, protocol, method: "GET", path: `/${name}`, results });
}

function report(
  endpoints: ReturnType<typeof endpoint>[],
  extra: { environment?: string; notes?: string[] } = {},
): RunReport {
  return buildRunReport({
    environment: extra.environment ?? "local",
    network: "stellar:testnet",
    startedAt: "2026-11-15T10:00:00.000Z",
    versions: VERSIONS,
    endpoints,
    notes: extra.notes ?? [],
  });
}

function baselineOf(runs: RunReport[]): Baseline {
  let history = updateHistory(undefined, runs[0]!);
  for (const run of runs.slice(1)) history = updateHistory(history, run);
  return { report: runs[runs.length - 1]!, history };
}

function lines(text: string): string[] {
  return text.split("\n");
}

describe("the shape of a comment", () => {
  it("starts with the marker, and the first line after it names the outcome and the versions", () => {
    const comment = renderComment({ report: report([endpoint("weather", conformant())]) });
    const [first, second] = lines(comment);
    assert.equal(COMMENT_MARKER, "<!-- wasit-report -->");
    assert.equal(first, COMMENT_MARKER);
    assert.match(second ?? "", /Wasit: conformant/);
    assert.match(second ?? "", /Wasit 0\.7\.0/);
    assert.match(second ?? "", /x402 v2/);
    assert.match(second ?? "", /@x402\/core 2\.28\.0/);
    assert.match(second ?? "", /@stellar\/stellar-sdk 16\.1\.0/);
  });

  it("is the golden comment for a green read-only run with no baseline", () => {
    const comment = renderComment({ report: report([endpoint("weather", conformant())]) });
    assert.match(comment, /No baseline on main yet/);
    assert.match(comment, /payment not run: read-only tier/);
    expectSnapshot("green-read-only-no-baseline.md", comment);
  });

  it("says a service Wasit cannot grade is unsupported, not failed, and does not call the run conformant", () => {
    const comment = renderComment({
      report: report([endpoint("old", v1())], { notes: ["Tier: read-only. Payment checks were not run."] }),
    });
    assert.match(comment, /Wasit: nothing graded/);
    assert.match(comment, /0 graded, 1 unsupported/);
    assert.match(comment, /unsupported/);
    assert.ok(!/Wasit: conformant/.test(comment));
    assert.match(comment, /PAYMENT-REQUIRED response header/, "the way to get graded is not cut off");
    assert.match(comment, /Tier: read-only/);
    expectSnapshot("v1-only-no-baseline.md", comment);
  });

  it("names the checks that failed, with what was found, the fix and the docs link", () => {
    const now = report([
      endpoint("weather", [pass("X402-01"), pass("X402-02"), pass("X402-03"), fail("X402-04", "Option 0 is missing payTo, asset.", undefined, { expected: "payTo, asset present", actual: "payTo, asset missing" }), pass("X402-05")]),
    ]);
    const comment = renderComment({ report: now });
    assert.match(comment, /Wasit: non-conformant/);
    assert.match(comment, /Option 0 is missing payTo, asset\./);
    assert.match(comment, /Send the challenge in the PAYMENT-REQUIRED header\./);
    assert.match(comment, /https:\/\/usewasit\.dev\/docs\/checks\/x402/);
  });

  it("shows, under each FAIL, the reason, then what was expected, then what the service sent, then the fix and the link", () => {
    const now = report([
      endpoint("weather", [
        fail("X402-01", "Expected status 402, got 200.", "Answer with 402.", { expected: "status 402", actual: "status 200" }),
      ]),
    ]);
    const comment = renderComment({ report: now });
    const order = ["- Found:", "- Expected: status 402", "- Actual: status 200", "- Fix:", "- Docs:"].map((needle) => comment.indexOf(needle));
    assert.ok(order.every((position) => position > 0), `all five lines are there: ${order.join(", ")}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "in the order found, expected, actual, fix, docs");
    assert.match(comment, /\*\*weather: X402-01 402 Response Status\*\*/, "the heading names the check once");
  });

  it("leaves the Expected and Actual lines out when the check did not record them", () => {
    const comment = renderComment({ report: report([endpoint("weather", [fail("X402-01", "Expected status 402, got 200.")])]) });
    assert.match(comment, /- Found:/);
    assert.ok(!/- Expected:|- Actual:/.test(comment));
  });

  it("neutralises Markdown, HTML, a mention, :: lines, control characters and a key in a hostile actual value", () => {
    const key = `S${"A".repeat(55)}`;
    const hostile = `[click](https://evil.example/x) <img src=x onerror=alert(1)> @octocat ${key} canary-actual-7f3a\n::set-output name=pwn::1\n## heading \u001b[2J | pipe`;
    const comment = renderComment({
      report: report([endpoint("weather", [fail("X402-05", "bad", undefined, { expected: `${hostile} expected`, actual: hostile })])]),
      secrets: ["canary-actual-7f3a"],
    });
    const line = lines(comment).filter((entry) => entry.startsWith("- Actual:") || entry.startsWith("- Expected:"));
    assert.equal(line.length, 2, "one line each");
    assert.ok(!/<img|onerror=alert\(1\)>/.test(comment));
    assert.ok(!comment.includes("evil.example"));
    assert.ok(!/@octocat/.test(comment));
    assert.ok(!comment.includes(key));
    assert.ok(!comment.includes("canary-actual-7f3a"));
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(comment.replace(/\n/g, "")));
    for (const entry of lines(comment)) assert.ok(!/^\s*(::|##\[)/.test(entry), entry);
    for (const entry of line) assert.ok(Array.from(entry).length < 400, "cut to 300 characters plus the label");
  });

  it("is the golden comment for a failing run against a baseline, with the history", () => {
    const main = report([endpoint("weather", conformant()), endpoint("summarize", conformant())]);
    const olderMain = report([
      endpoint("weather", [pass("X402-01"), pass("X402-02"), pass("X402-03"), fail("X402-04", "Option 0 is missing payTo."), pass("X402-05")]),
      endpoint("summarize", conformant()),
    ]);
    const now = report([
      endpoint("weather", [
        pass("X402-01"),
        pass("X402-02"),
        pass("X402-03"),
        fail("X402-04", "Missing: payTo, asset.", "Add `payTo`: the address that receives the payment. Add `asset`: the address of the token the client pays in.", {
          expected: "payTo, asset present",
          actual: "payTo, asset missing",
        }),
        pass("X402-05"),
      ]),
      endpoint("summarize", conformant()),
      endpoint("fresh", conformant()),
    ]);
    const comment = renderComment({ report: now, baseline: baselineOf([olderMain, main, main]) });
    assert.match(comment, /Changed since main/);
    assert.match(comment, /New FAIL: weather X402-04/);
    assert.match(comment, /- Expected: payTo, asset present\n- Actual: payTo, asset missing\n- Fix:/);
    assert.match(comment, /New endpoint: fresh/);
    assert.match(comment, /weather X402-04: failed in 1 of the last 3 runs on main/);
    expectSnapshot("failing-with-baseline.md", comment);
  });

  it("is the golden comment for a graded endpoint that is now unsupported: a regression", () => {
    const main = report([endpoint("weather", conformant()), endpoint("summarize", conformant())]);
    const now = report([endpoint("weather", conformant()), endpoint("summarize", v1())]);
    const comment = renderComment({ report: now, baseline: baselineOf([main]) });
    assert.match(comment, /Wasit: regression/);
    assert.match(comment, /Regression: summarize was conformant on main and is now unsupported/);
    expectSnapshot("regression-vs-baseline.md", comment);
  });

  it("says nothing changed, when nothing did", () => {
    const main = report([endpoint("weather", conformant())]);
    const comment = renderComment({ report: main, baseline: baselineOf([main]) });
    assert.match(comment, /No change since main/);
  });

  it("says why there is no usable baseline when one was looked for and could not be read", () => {
    const comment = renderComment({
      report: report([endpoint("weather", conformant())]),
      baselineNote: "the baseline is not valid JSON",
    });
    assert.match(comment, /could not be used/);
    assert.match(comment, /not valid JSON/);
    assert.match(comment, /history starts again/);
  });

  it("lists the notes of the report", () => {
    const comment = renderComment({ report: report([endpoint("weather", conformant())], { notes: ["Tier: read-only."] }) });
    assert.match(comment, /Tier: read-only\./);
  });

  it("counts an ERROR as 'could not run' and calls the run no verdict", () => {
    const comment = renderComment({
      report: report([endpoint("weather", [pass("X402-01"), errored("X402-02", "x", new ConfigurationError("could not connect"))])]),
    });
    assert.match(comment, /Wasit: no verdict/);
    assert.match(comment, /1 could not run/);
  });

  it("says the checks of an MPP endpoint need the payment tier", () => {
    const comment = renderComment({
      report: report([endpoint("weather", conformant()), endpoint("chat", skippedPaymentChecks("mpp-charge", "read-only"), "mpp-charge")]),
    });
    assert.match(comment, /chat/);
    assert.match(comment, /MPP charge not run: read-only tier/);
    assert.match(comment, /1 no verdict/);
  });
});

describe("the job summary", () => {
  it("is the comment without the marker", () => {
    const input = { report: report([endpoint("weather", conformant())]) };
    const comment = renderComment(input);
    const summary = renderSummary(input);
    assert.ok(!summary.includes(COMMENT_MARKER));
    assert.equal(summary, comment.slice(comment.indexOf("\n") + 1));
  });
});

describe("a hostile service", () => {
  const HOSTILE = [
    "[click here](https://evil.example/steal)",
    "<img src=x onerror=alert(1)>",
    "<script>alert(1)</script>",
    "@octocat and @github/security-team please look",
    "see #123 and octo/repo#9",
    "https://evil.example/phish www.evil.example mailto:a@evil.example",
    "\u001b[2J\u001b[31mred\u0007bell‮RTL",
    "| pipe | cells | injected |",
    "# a heading",
    "- a list item",
  ].join("\n");
  const CANARY = "canary-header-value-7f3a";
  const STELLAR_KEY = `S${"A".repeat(55)}`;

  /** What a 402 body can do once a check quotes it: every field a service chose, each with the nasty text. */
  function hostileReport(): RunReport {
    const nasty = `${HOSTILE}\n::set-output name=pwn::1\n  ::add-mask::x\n##[warning]hello ${CANARY} ${STELLAR_KEY}`;
    return report(
      [
        endpoint("weather", [
          pass("X402-01"),
          fail("X402-02", nasty, nasty, { expected: nasty, actual: nasty }),
          { id: "X402-03", name: nasty, pass: false, detail: "x".repeat(5000), hint: "short" },
        ]),
      ],
      { notes: [nasty] },
    );
  }

  const comment = renderComment({ report: hostileReport(), secrets: [CANARY] });

  it("lets no HTML through", () => {
    assert.ok(!/<(img|script)/i.test(comment));
    assert.ok(!comment.includes("onerror=alert(1)>"));
  });

  it("lets no link, mention, issue reference or mailto of the service stand", () => {
    assert.ok(!comment.includes("evil.example"));
    assert.ok(!/@octocat|@github/.test(comment));
    assert.ok(!/octo\/repo#9|#123/.test(comment));
    assert.ok(!/\]\(https?:\/\/(?!usewasit\.dev\/)/.test(comment));
  });

  it("starts no line with a workflow command, in either spelling", () => {
    for (const line of lines(comment)) {
      assert.ok(!/^\s*(::|##\[)/.test(line), `line starts a command: ${line.slice(0, 40)}`);
    }
  });

  it("has no control character except newline, and no bidirectional override", () => {
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(comment));
  });

  it("opens no heading, list or table row from the service's text", () => {
    const body = lines(comment).filter((line) => /injected|a heading|a list item|pipe/.test(line));
    assert.ok(body.length > 0, "the text is there, escaped");
    for (const line of body) {
      assert.ok(!/^#{1,6} a heading/.test(line), line);
      assert.ok(!/^- a list item/.test(line), line);
      assert.ok(!/^\| pipe \|/.test(line), line);
    }
  });

  it("cuts a long value to 300 characters", () => {
    for (const line of lines(comment)) assert.ok(Array.from(line).length < 700, `line of ${line.length} characters`);
    assert.ok(!comment.includes("x".repeat(301)));
  });

  it("carries no secret: not the header value it was told, not a Stellar secret key", () => {
    assert.ok(!comment.includes(CANARY));
    assert.ok(!comment.includes(STELLAR_KEY));
    const unredacted = renderComment({ report: hostileReport() });
    assert.ok(!unredacted.includes(STELLAR_KEY), "a Stellar key is masked without being told");
  });

  it("drops a docs link that is not on usewasit.dev", () => {
    const forged = report([endpoint("weather", [fail("X402-01", "bad")])]);
    const tampered: RunReport = {
      ...forged,
      endpoints: [
        {
          ...forged.endpoints[0]!,
          results: forged.endpoints[0]!.results.map((result) => ({ ...result, docs: "https://evil.example/docs" })),
        },
      ],
    };
    const text = renderComment({ report: tampered });
    assert.ok(!text.includes("evil.example"));
    assert.ok(!/Docs:/.test(text));
  });

  it("holds the whole comment under what GitHub allows, and says what it left out", () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      endpoint(`endpoint-${index}`, CHALLENGE.map((id) => fail(id, "y".repeat(2000)))),
    );
    const big = renderComment({ report: report(many) });
    assert.ok(big.length <= 60_000, `comment of ${big.length} characters`);
    assert.match(big, /more failures? not shown/);
  });
});
