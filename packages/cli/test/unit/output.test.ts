/**
 * What `wasit test`, `wasit mpp-charge` and `wasit mpp-channel` print, and the
 * exit code they return. Text a service sent reaches the terminal through the
 * check details, so it goes through the one sanitiser (spec A8 #6): no control
 * character, no `::` at the start of a line (a workflow command in a CI log), no
 * secret. And the exit rule of `wasit test` (A8 #3, D-021): a service that was
 * never graded exits 2.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type CheckResult, skipped } from "@wasit-dev/core";

import { report } from "../../src/output.js";

const CANARY = "canary-header-value-7f3a";
const STELLAR_KEY = `S${"A".repeat(55)}`;

function run(results: CheckResult[], json: boolean, protocol?: "x402") {
  const lines: string[] = [];
  const code = report(results, json, {
    emit: (line) => lines.push(line),
    secrets: [CANARY],
    ...(protocol === undefined ? {} : { protocol }),
  });
  return { code, text: lines.join("\n") };
}

const hostile: CheckResult = {
  id: "X402-04",
  name: "Required Fields Present",
  pass: false,
  detail: `bad \u001b[2J\u0007 body\n::set-output name=pwn::1\n  ::add-mask::x\n##[warning]hi ${CANARY} ${STELLAR_KEY}`,
  hint: `try \u001b[31m this\n::stop-commands::token ${CANARY}`,
};

describe("report, text", () => {
  const { text } = run([hostile], false);

  it("strips control characters", () => {
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text));
  });

  it("starts no line with a workflow command, in either spelling", () => {
    for (const line of text.split("\n")) assert.ok(!/^\s*(::|##\[)/.test(line), line);
  });

  it("carries no secret", () => {
    assert.ok(!text.includes(CANARY));
    assert.ok(!text.includes(STELLAR_KEY));
  });

  it("still prints the check, its detail and the fix", () => {
    assert.match(text, /FAIL {2}X402-04 {2}Required Fields Present/);
    assert.match(text, /bad \[2J body/);
    assert.match(text, /Fix: try/);
  });
});

describe("report, json", () => {
  it("is parseable JSON with no secret and no control character in any string", () => {
    const { text } = run([hostile], true);
    const parsed = JSON.parse(text);
    assert.equal(parsed.results[0].status, "FAIL");
    assert.ok(!text.includes(CANARY));
    assert.ok(!text.includes(STELLAR_KEY));
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text.replace(/\n/g, "")));
  });
});

describe("payment checks asked for and not gradable on the network (Najmi, 2026-11-15)", () => {
  // A typo in --network, or a chain with no payment adapter: the challenge was graded, the payment checks were not.
  const challenge: CheckResult[] = ["X402-01", "X402-02", "X402-03", "X402-04", "X402-05"].map((id) => ({
    id,
    name: id,
    pass: true,
    detail: "ok",
  }));
  const unsupportedPayment: CheckResult[] = [
    ...challenge,
    ...["X402-06", "X402-07", "X402-08", "X402-09", "X402-10"].map((id) => skipped(id, id, "no payment adapter for eip155:1", "unsupported")),
  ];

  it("exits 2, as 0.7.0 did, not 0", () => {
    assert.equal(run(unsupportedPayment, false, "x402").code, 2);
  });

  it("says in the text that the payment checks were asked for and could not be graded, and that nothing was signed", () => {
    const { text } = run(unsupportedPayment, false, "x402");
    assert.match(text, /No verdict/);
    assert.match(text, /payment checks/);
    assert.match(text, /nothing was signed/i);
  });

  it("names the outcome no-verdict in json", () => {
    assert.equal(JSON.parse(run(unsupportedPayment, true, "x402").text).outcome, "no-verdict");
  });
});

describe("the exit rule of wasit test", () => {
  const v1: CheckResult[] = [
    { id: "X402-01", name: "402 Response Status", pass: true, detail: "ok" },
    ...["X402-02", "X402-03", "X402-04", "X402-05"].map((id) => skipped(id, id, "x402 v1", "unsupported")),
  ];

  it("exits 2 for a v1 service when the protocol is given: it was never graded", () => {
    assert.equal(run(v1, false, "x402").code, 2);
  });

  it("says it is no verdict, not a failure and not a pass, in the text", () => {
    const { text } = run(v1, false, "x402");
    assert.match(text, /No verdict/);
    assert.match(text, /could not grade/);
    assert.match(text, /unsupported/);
  });

  it("names the outcome no-verdict in json, so a script cannot read it as conformant", () => {
    const parsed = JSON.parse(run(v1, true, "x402").text);
    assert.equal(parsed.outcome, "no-verdict");
    assert.equal(parsed.failed, 0);
  });

  it("keeps 0 for the commands that do not pass a protocol (mpp-charge, mpp-channel)", () => {
    assert.equal(run(v1, false).code, 0);
  });

  it("carries expected and actual in --json for a FAIL that has them, and the old fields as before", () => {
    const failing: CheckResult = {
      id: "X402-01",
      name: "402 Response Status",
      pass: false,
      detail: "Expected status 402, got 200.",
      hint: "Answer with 402.",
      expected: "status 402",
      actual: "status 200",
    };
    const parsed = JSON.parse(run([failing], true, "x402").text);
    assert.equal(parsed.results[0].expected, "status 402");
    assert.equal(parsed.results[0].actual, "status 200");
    assert.equal(parsed.results[0].detail, "Expected status 402, got 200.");
    assert.equal(parsed.results[0].fix, "Answer with 402.");
  });

  it("still exits 0 for a conformant service and 1 for a failure", () => {
    const ok: CheckResult[] = ["X402-01", "X402-02", "X402-03", "X402-04", "X402-05"].map((id) => ({
      id,
      name: id,
      pass: true,
      detail: "ok",
    }));
    assert.equal(run(ok, false, "x402").code, 0);
    assert.equal(run([hostile], false, "x402").code, 1);
  });
});
