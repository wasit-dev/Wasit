/**
 * Which GitHub events may run the payment tier (D-022a option 2, D-032; Najmi's
 * answers of 2026-11-16 in s2-build-plan.md): push to the default branch,
 * schedule, and workflow_dispatch on the default branch. Every pull request event
 * is refused, and so is every other event. Outside GitHub Actions the gate is
 * open: a laptop run is the builder's own choice.
 *
 * This stops a mistake in a workflow, not its author (B-A10): a step can hide
 * the runner's variables from the CLI. Written before the code (CONTEXT rule 3).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { payerKeyVariables, paymentEventGate, readGithubEvent } from "../../src/guard/ci-event.js";

const main = { repository: { default_branch: "main" } };

function gha(event: string, ref = "refs/heads/main"): Record<string, string> {
  return { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: event, GITHUB_REF: ref };
}

describe("paymentEventGate", () => {
  it("is open outside CI", () => {
    assert.deepEqual(paymentEventGate({}, undefined), { allowed: true });
    assert.deepEqual(paymentEventGate({ CI: "" }, undefined), { allowed: true });
  });

  it("is closed in a CI that is not GitHub Actions, and says so (review R9 a, Najmi 2026-11-17)", () => {
    for (const value of ["true", "1", "yes"]) {
      const gate = paymentEventGate({ CI: value }, undefined);
      assert.equal(gate.allowed, false, value);
      assert.equal(gate.ciOutsideGithub, true, value);
      assert.equal(gate.reason, "payment checks not run: CI is set, and this is not GitHub Actions");
    }
    // GitHub Actions sets CI too: its own rules apply, not this one.
    assert.equal(paymentEventGate({ CI: "true", ...gha("push") }, main).allowed, true);
    assert.equal(paymentEventGate({ CI: "true", ...gha("push") }, main).ciOutsideGithub, undefined);
  });

  it("allows a push to the default branch", () => {
    assert.equal(paymentEventGate(gha("push"), main).allowed, true);
  });

  it("allows a schedule, with or without a repository in the event", () => {
    assert.equal(paymentEventGate(gha("schedule"), { schedule: "0 6 * * *" }).allowed, true);
    assert.equal(paymentEventGate(gha("schedule"), main).allowed, true);
    assert.equal(paymentEventGate(gha("schedule"), undefined).allowed, true);
  });

  it("counts any non-empty GITHUB_ACTIONS as GitHub Actions, as the CLI's CI test does (review R9 b)", () => {
    for (const value of ["1", "TRUE", "yes"]) {
      const gate = paymentEventGate({ GITHUB_ACTIONS: value }, undefined);
      assert.equal(gate.allowed, false, value);
    }
    assert.equal(paymentEventGate({ GITHUB_ACTIONS: "" }, undefined).allowed, true, "an empty value is not set");
  });

  it("refuses a schedule whose payload names no repository unless its ref is a branch (review R9 c)", () => {
    for (const ref of ["refs/pull/1/merge", "refs/tags/v1", "", "main"]) {
      const gate = paymentEventGate(gha("schedule", ref), { schedule: "0 6 * * *" });
      assert.equal(gate.allowed, false, ref);
      assert.match(gate.reason ?? "", /payment checks not run/);
    }
    assert.equal(paymentEventGate(gha("schedule", "refs/heads/main"), undefined).allowed, true);
  });

  it("allows workflow_dispatch on the default branch", () => {
    assert.equal(paymentEventGate(gha("workflow_dispatch"), main).allowed, true);
  });

  for (const event of ["pull_request", "pull_request_target", "pull_request_review", "pull_request_review_comment"]) {
    it(`refuses ${event} with "payment checks not run: pull request"`, () => {
      const gate = paymentEventGate(gha(event, "refs/pull/7/merge"), main);
      assert.equal(gate.allowed, false);
      assert.equal(gate.reason, "payment checks not run: pull request");
    });
  }

  it("refuses a pull request even when GITHUB_ACTIONS is not set but the event name is", () => {
    const gate = paymentEventGate({ GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/7/merge" }, main);
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, "payment checks not run: pull request");
  });

  for (const event of ["merge_group", "workflow_run", "issue_comment", "release", "repository_dispatch", ""]) {
    it(`refuses the ${event === "" ? "unnamed" : event} event`, () => {
      const gate = paymentEventGate(gha(event), main);
      assert.equal(gate.allowed, false);
      assert.match(gate.reason ?? "", /^payment checks not run: /);
      assert.match(gate.reason ?? "", /push to the default branch, schedule and workflow_dispatch/);
    });
  }

  it("refuses a push to another branch, and to a tag", () => {
    for (const ref of ["refs/heads/feature", "refs/tags/v1.0.0", "refs/heads/main-copy", ""]) {
      const gate = paymentEventGate(gha("push", ref), main);
      assert.equal(gate.allowed, false, ref);
      assert.match(gate.reason ?? "", /not the default branch/);
    }
  });

  it("refuses workflow_dispatch on another branch", () => {
    const gate = paymentEventGate(gha("workflow_dispatch", "refs/heads/feature"), main);
    assert.equal(gate.allowed, false);
    assert.match(gate.reason ?? "", /not the default branch/);
  });

  it("refuses a push or a dispatch when the event does not name the default branch", () => {
    for (const event of ["push", "workflow_dispatch"]) {
      for (const payload of [undefined, {}, { repository: {} }, { repository: { default_branch: 7 } }, "text"]) {
        const gate = paymentEventGate(gha(event), payload);
        assert.equal(gate.allowed, false, `${event} ${JSON.stringify(payload)}`);
        assert.match(gate.reason ?? "", /default branch/);
      }
    }
  });

  it("refuses a schedule whose ref is not the default branch the event names", () => {
    assert.equal(paymentEventGate(gha("schedule", "refs/heads/other"), main).allowed, false);
  });

  it("never echoes an event name or a ref that carries control characters", () => {
    const gate = paymentEventGate(gha("evil\u001b[31m\nname", "refs/heads/x\u0007"), main);
    assert.equal(gate.allowed, false);
    assert.doesNotMatch(gate.reason ?? "", /[\u0000-\u001f\u007f]/);
  });
});

describe("payerKeyVariables", () => {
  it("names each key variable that has a value, in upper case", () => {
    assert.deepEqual(payerKeyVariables({ STELLAR_PRIVATE_KEY: "S...", PATH: "/bin" }), ["STELLAR_PRIVATE_KEY"]);
    assert.deepEqual(
      payerKeyVariables({
        EVM_PRIVATE_KEY: "0x1",
        SVM_PRIVATE_KEY: "x",
        MPP_PAYER_SECRET: "S",
        COMMITMENT_SECRET_HEX: "ab",
        WASIT_MAINNET_PAYER_SECRET: "S",
      }).sort(),
      ["COMMITMENT_SECRET_HEX", "EVM_PRIVATE_KEY", "MPP_PAYER_SECRET", "SVM_PRIVATE_KEY", "WASIT_MAINNET_PAYER_SECRET"],
    );
    // Windows spells variables in any case; it is the same variable there.
    assert.deepEqual(payerKeyVariables({ Stellar_Private_Key: "S" }), ["STELLAR_PRIVATE_KEY"]);
  });

  it("does not count an empty or blank value: a fork's pull request gets empty secrets", () => {
    assert.deepEqual(payerKeyVariables({ STELLAR_PRIVATE_KEY: "", EVM_PRIVATE_KEY: "   ", SVM_PRIVATE_KEY: undefined }), []);
  });

  it("does not count header or RPC variables: they are not payer keys", () => {
    assert.deepEqual(payerKeyVariables({ WASIT_HEADER_X_API_KEY: "k", WASIT_RPC_URL: "https://rpc" }), []);
  });
});

describe("readGithubEvent", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-event-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the event file GITHUB_EVENT_PATH names", async () => {
    const file = path.join(dir, "event.json");
    await writeFile(file, JSON.stringify(main));
    assert.deepEqual(readGithubEvent({ GITHUB_EVENT_PATH: file }), main);
  });

  it("gives undefined for no path, a missing file, a file that is not JSON, or one above 1 MiB", async () => {
    assert.equal(readGithubEvent({}), undefined);
    assert.equal(readGithubEvent({ GITHUB_EVENT_PATH: path.join(dir, "missing.json") }), undefined);
    const text = path.join(dir, "text.json");
    await writeFile(text, "not json");
    assert.equal(readGithubEvent({ GITHUB_EVENT_PATH: text }), undefined);
    const big = path.join(dir, "big.json");
    await writeFile(big, JSON.stringify({ repository: { default_branch: "main" }, pad: "x".repeat(1024 * 1024) }));
    assert.equal(readGithubEvent({ GITHUB_EVENT_PATH: big }), undefined);
  });
});
