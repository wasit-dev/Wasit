/**
 * The run's status on the pull request (Najmi, 2026-11-20): the check run
 * "Wasit conformance" and the running comment. Written before the code.
 *
 * What the tests hold it to: nothing is tried on a pull request from a fork; the
 * check run is created on the commit under test and completed with what the
 * report step wrote, and only when that step succeeded; a 403 (no `checks:
 * write`) or any failure never fails the step; the running comment carries no
 * link but the run's own page and no key; nothing here reads a key.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { COMMENT_MARKER } from "../../packages/core/dist/ci-report.js";
import { CHECK_NAME, NO_REPORT_OUTPUT, checkRunOutput, finish, headSha, runUrl, start } from "../scripts/announce.mjs";

const REPOSITORY = "acme/paywall";
const HEAD = "a".repeat(40);
const PUSHED = "b".repeat(40);
const CANARY = "SCANARYKEYNEVERPRINTED";

function fakeGh(handlers) {
  const calls = [];
  const gh = async (args, options = {}) => {
    calls.push({ args, input: options.input });
    const key = `${args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET"} ${args[1]}`;
    for (const [pattern, answer] of handlers) {
      if (key.startsWith(pattern)) return typeof answer === "function" ? answer(args, options) : answer;
    }
    throw new Error(`unexpected gh call: ${key}`);
  };
  return { gh, calls };
}

const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const http = (status) => ({ code: 1, stdout: "", stderr: `gh: error (HTTP ${status})` });
const quiet = () => {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
};
const NOW = () => new Date("2026-11-20T08:54:10.000Z");

describe("announce.mjs", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-announce-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function eventFile(name, value) {
    const file = path.join(dir, `${name}.json`);
    await writeFile(file, JSON.stringify(value));
    return file;
  }
  const pullEvent = (headRepo = REPOSITORY) => ({
    repository: { full_name: REPOSITORY },
    pull_request: { number: 7, head: { sha: HEAD, repo: { full_name: headRepo } } },
  });

  async function env(name, extra = {}, event = pullEvent()) {
    const output = path.join(dir, `${name}.output`);
    await writeFile(output, "");
    return {
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: await eventFile(name, event),
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "123456789",
      GITHUB_SHA: PUSHED,
      GITHUB_OUTPUT: output,
      // The action blanks these in this step; a key here must still never be read or written.
      STELLAR_PRIVATE_KEY: CANARY,
      ...extra,
    };
  }

  describe("start", () => {
    it("on a pull request from this repository: creates the check run on the head commit, saves its id, writes the running comment", async () => {
      const e = await env("same-repo", { INPUT_ENVIRONMENT: "staging" });
      const { gh, calls } = fakeGh([
        ["POST repos/acme/paywall/check-runs", ok({ id: 4242 })],
        ["GET repos/acme/paywall/issues/7/comments", ok([])],
        ["POST repos/acme/paywall/issues/7/comments", ok({ id: 1 })],
      ]);
      const { log } = quiet();
      assert.equal(await start(e, { gh, log, now: NOW }), 0);
      const created = JSON.parse(calls[0].input);
      assert.equal(created.name, CHECK_NAME);
      assert.equal(created.head_sha, HEAD, "the pull request's head, not the merge commit");
      assert.equal(created.status, "in_progress");
      assert.equal(created.details_url, "https://github.com/acme/paywall/actions/runs/123456789");
      assert.equal(await readFile(e.GITHUB_OUTPUT, "utf-8"), "check_run_id=4242\n");
      const body = JSON.parse(calls.at(-1).input).body;
      assert.ok(body.startsWith(COMMENT_MARKER));
      assert.match(body, /⏳ \*\*Wasit is running\*\* on staging · started 2026-11-20 08:54 UTC · \[follow the run\]\(https:\/\/github\.com\/acme\/paywall\/actions\/runs\/123456789\)/);
      for (const call of calls) assert.ok(!JSON.stringify(call).includes(CANARY), "a key reached GitHub");
    });

    it("on a pull request from a fork: calls nothing at all", async () => {
      const e = await env("fork", {}, pullEvent("someone/paywall"));
      const { gh, calls } = fakeGh([]);
      const { lines, log } = quiet();
      assert.equal(await start(e, { gh, log, now: NOW }), 0);
      assert.equal(calls.length, 0);
      assert.match(lines.join("\n"), /from a fork/);
    });

    it("on a push: creates the check run on GITHUB_SHA, and writes no comment", async () => {
      const e = await env("push", { GITHUB_EVENT_NAME: "push" }, { repository: { full_name: REPOSITORY } });
      const { gh, calls } = fakeGh([["POST repos/acme/paywall/check-runs", ok({ id: 7 })]]);
      assert.equal(await start(e, { gh, log: quiet().log, now: NOW }), 0);
      assert.equal(calls.length, 1);
      assert.equal(JSON.parse(calls[0].input).head_sha, PUSHED);
    });

    it("without checks: write (a 403): logs it, saves no id, still writes the running comment, and does not fail", async () => {
      const e = await env("forbidden");
      const { gh, calls } = fakeGh([
        ["POST repos/acme/paywall/check-runs", http(403)],
        ["GET repos/acme/paywall/issues/7/comments", ok([])],
        ["POST repos/acme/paywall/issues/7/comments", ok({ id: 1 })],
      ]);
      const { lines, log } = quiet();
      assert.equal(await start(e, { gh, log, now: NOW }), 0);
      assert.match(lines.join("\n"), /checks: write/);
      assert.equal(await readFile(e.GITHUB_OUTPUT, "utf-8"), "");
      assert.equal(calls.length, 3);
    });

    it("saves no id GitHub did not give as a whole number, and creates no check run on a commit that is not 40 hex characters", async () => {
      const bad = await env("bad-id");
      const { gh } = fakeGh([
        ["POST repos/acme/paywall/check-runs", ok({ id: "1\ncheck_run_id=9" })],
        ["GET repos/acme/paywall/issues/7/comments", ok([])],
        ["POST repos/acme/paywall/issues/7/comments", ok({ id: 1 })],
      ]);
      await start(bad, { gh, log: quiet().log, now: NOW });
      assert.equal(await readFile(bad.GITHUB_OUTPUT, "utf-8"), "", "nothing that could add a second output line");
      const sha = await env("bad-sha", {}, { ...pullEvent(), pull_request: { ...pullEvent().pull_request, head: { sha: "HEAD; rm -rf /", repo: { full_name: REPOSITORY } } } });
      const second = fakeGh([
        ["GET repos/acme/paywall/issues/7/comments", ok([])],
        ["POST repos/acme/paywall/issues/7/comments", ok({ id: 1 })],
      ]);
      await start(sha, { gh: second.gh, log: quiet().log, now: NOW });
      assert.ok(!second.calls.some((call) => call.args[1].includes("check-runs")));
    });

    it("puts no link in the running comment unless the run's page has GitHub's shape, and sanitises the environment", async () => {
      const e = await env("hostile", {
        GITHUB_SERVER_URL: "javascript:alert(1)//",
        INPUT_ENVIRONMENT: "@octocat [x](https://evil.example) <img src=x>",
      });
      const { gh, calls } = fakeGh([
        ["POST repos/acme/paywall/check-runs", ok({ id: 1 })],
        ["GET repos/acme/paywall/issues/7/comments", ok([])],
        ["POST repos/acme/paywall/issues/7/comments", ok({ id: 1 })],
      ]);
      await start(e, { gh, log: quiet().log, now: NOW });
      const body = JSON.parse(calls.at(-1).input).body;
      assert.ok(!body.includes("follow the run"));
      assert.ok(!body.includes("evil.example") && !/@octocat|<img/.test(body));
      assert.equal(JSON.parse(calls[0].input).details_url, undefined);
    });
  });

  describe("finish", () => {
    async function finishEnv(name, extra) {
      const file = path.join(dir, `${name}.check-run.json`);
      return { GITHUB_REPOSITORY: REPOSITORY, CHECK_RUN_ID: "4242", WASIT_CHECK_RUN_FILE: file, REPORT_OUTCOME: "success", ...extra };
    }

    it("completes the check run with the title, summary and conclusion the report step wrote", async () => {
      const e = await finishEnv("done");
      await writeFile(e.WASIT_CHECK_RUN_FILE, JSON.stringify({ title: "✅ conformant · 10 passed, 1 skipped", summary: "**Wasit: ✅ conformant.**", conclusion: "success" }));
      const { gh, calls } = fakeGh([["PATCH repos/acme/paywall/check-runs/4242", ok({ id: 4242 })]]);
      assert.equal(await finish(e, { gh, log: quiet().log, now: NOW }), 0);
      const sent = JSON.parse(calls[0].input);
      assert.equal(sent.status, "completed");
      assert.equal(sent.conclusion, "success");
      assert.equal(sent.output.title, "✅ conformant · 10 passed, 1 skipped");
    });

    it("uses no file when the report step did not succeed: a file in its place could be anyone's", async () => {
      const e = await finishEnv("planted", { REPORT_OUTCOME: "failure" });
      await writeFile(e.WASIT_CHECK_RUN_FILE, JSON.stringify({ title: "✅ all good [x](https://evil.example)", summary: "@octocat", conclusion: "success" }));
      const { gh, calls } = fakeGh([["PATCH repos/acme/paywall/check-runs/4242", ok({})]]);
      await finish(e, { gh, log: quiet().log, now: NOW });
      const sent = JSON.parse(calls[0].input);
      assert.equal(sent.conclusion, "neutral");
      assert.equal(sent.output.title, NO_REPORT_OUTPUT.title);
      assert.ok(!calls[0].input.includes("evil.example"));
    });

    it("is neutral for a missing or broken file, an unknown conclusion, and cuts the title and summary to GitHub's limits", () => {
      assert.deepEqual(checkRunOutput(undefined), { ...NO_REPORT_OUTPUT });
      assert.deepEqual(checkRunOutput("not json"), { ...NO_REPORT_OUTPUT });
      assert.equal(checkRunOutput(JSON.stringify({ title: "t", summary: "s", conclusion: "action_required" })).conclusion, "neutral");
      const long = checkRunOutput(JSON.stringify({ title: "t".repeat(400), summary: "s".repeat(70_000), conclusion: "failure" }));
      assert.equal(long.title.length, 255);
      assert.equal(long.summary.length, 65_535);
      assert.equal(long.conclusion, "failure");
    });

    it("does nothing without a check run id that is a whole number, and never fails the step", async () => {
      const { gh, calls } = fakeGh([]);
      assert.equal(await finish({ GITHUB_REPOSITORY: REPOSITORY, CHECK_RUN_ID: "1; echo pwned" }, { gh, log: quiet().log, now: NOW }), 0);
      assert.equal(calls.length, 0);
      const failing = fakeGh([["PATCH repos/acme/paywall/check-runs/5", http(500)]]);
      assert.equal(await finish({ GITHUB_REPOSITORY: REPOSITORY, CHECK_RUN_ID: "5" }, { gh: failing.gh, log: quiet().log, now: NOW }), 0);
    });
  });

  describe("the parts it builds from GitHub's variables", () => {
    it("builds the run's page only from a GitHub server, an owner/repo and a numeric run id", () => {
      assert.equal(runUrl({ GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: REPOSITORY, GITHUB_RUN_ID: "42" }), "https://github.com/acme/paywall/actions/runs/42");
      assert.equal(runUrl({ GITHUB_SERVER_URL: "http://github.com", GITHUB_REPOSITORY: REPOSITORY, GITHUB_RUN_ID: "42" }), undefined);
      assert.equal(runUrl({ GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "a/b/c", GITHUB_RUN_ID: "42" }), undefined);
      assert.equal(runUrl({ GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: REPOSITORY, GITHUB_RUN_ID: "42x" }), undefined);
    });

    it("takes the commit under test from the pull request's head on a pull request, else GITHUB_SHA", () => {
      assert.equal(headSha({ GITHUB_EVENT_NAME: "pull_request" }, pullEvent()), HEAD);
      assert.equal(headSha({ GITHUB_EVENT_NAME: "push", GITHUB_SHA: PUSHED }, {}), PUSHED);
      assert.equal(headSha({ GITHUB_EVENT_NAME: "push", GITHUB_SHA: "HEAD" }, {}), undefined);
    });
  });
});
