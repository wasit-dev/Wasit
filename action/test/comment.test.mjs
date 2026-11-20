/**
 * The comment step of the Action (spec A4 step 5, A8 #8): one comment on the pull
 * request, found by its marker, updated on each push; only comments by
 * github-actions[bot] are considered; a 403 (a fork's read-only token) is
 * logged and never fails the job; and a pull request from a fork is not even
 * tried.
 *
 * The `gh` call is injected: nothing here touches the network or a token.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { COMMENT_MARKER } from "../../packages/core/dist/ci-report.js";
import { findOwnComment, httpStatus, isForkPullRequest, main, upsertComment } from "../scripts/comment.mjs";

const REPOSITORY = "acme/paywall";
const BOT = { login: "github-actions[bot]", type: "Bot" };
const BODY = `${COMMENT_MARKER}\n**Wasit: conformant.** 1 graded on local, stellar:testnet.\n`;

/** A fake `gh api`: answers from a table, records every call. */
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
const http = (status, message = "error") => ({ code: 1, stdout: "", stderr: `gh: ${message} (HTTP ${status})` });
const quiet = () => {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
};

describe("isForkPullRequest", () => {
  const event = (headRepo, baseRepo = REPOSITORY) => ({
    repository: { full_name: baseRepo },
    pull_request: { number: 7, head: { repo: headRepo === undefined ? undefined : headRepo === null ? null : { full_name: headRepo } } },
  });

  it("is false when the head repository is the base repository", () => {
    assert.equal(isForkPullRequest(event(REPOSITORY)), false);
  });

  it("is false when only the case of the name differs: GitHub names are not case-sensitive", () => {
    assert.equal(isForkPullRequest(event("Acme/Paywall")), false);
  });

  it("is true for a head repository that is another", () => {
    assert.equal(isForkPullRequest(event("mallory/paywall")), true);
  });

  it("is true when the head repository is gone (a deleted fork) or the event does not say", () => {
    assert.equal(isForkPullRequest(event(null)), true);
    assert.equal(isForkPullRequest(event(undefined)), true);
    assert.equal(isForkPullRequest({}), true);
    assert.equal(isForkPullRequest({ repository: { full_name: REPOSITORY } }), true);
    assert.equal(isForkPullRequest(null), true);
  });
});

describe("httpStatus", () => {
  it("reads the status gh prints on a failed call", () => {
    assert.equal(httpStatus(http(403, "Resource not accessible by integration")), 403);
    assert.equal(httpStatus({ code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }), 404);
  });
  it("is undefined when there is none, or the call worked", () => {
    assert.equal(httpStatus({ code: 1, stdout: "", stderr: "connection reset" }), undefined);
    assert.equal(httpStatus({ code: 0, stdout: "{}", stderr: "" }), undefined);
  });
});

describe("findOwnComment", () => {
  const mine = { id: 10, user: BOT, body: BODY };

  it("finds a comment by github-actions[bot] that starts with the marker", () => {
    assert.equal(findOwnComment([{ id: 1, user: { login: "alice", type: "User" }, body: "hi" }, mine], COMMENT_MARKER)?.id, 10);
  });

  it("ignores a comment by anyone else, however it starts: a person quoting the marker is not Wasit", () => {
    const imposter = { id: 5, user: { login: "mallory", type: "User" }, body: BODY };
    assert.equal(findOwnComment([imposter], COMMENT_MARKER), undefined);
  });

  it("ignores a user that has the bot's name but is not a bot, and another bot", () => {
    assert.equal(findOwnComment([{ id: 5, user: { login: "github-actions[bot]", type: "User" }, body: BODY }], COMMENT_MARKER), undefined);
    assert.equal(findOwnComment([{ id: 6, user: { login: "dependabot[bot]", type: "Bot" }, body: BODY }], COMMENT_MARKER), undefined);
  });

  it("ignores a bot comment that does not start with the marker, or has it only further down", () => {
    assert.equal(findOwnComment([{ id: 5, user: BOT, body: "Something else" }], COMMENT_MARKER), undefined);
    assert.equal(findOwnComment([{ id: 6, user: BOT, body: `intro\n${BODY}` }], COMMENT_MARKER), undefined);
  });

  it("takes the oldest when there are several, so a duplicate does not take over", () => {
    assert.equal(findOwnComment([{ ...mine, id: 30 }, { ...mine, id: 12 }, { ...mine, id: 20 }], COMMENT_MARKER)?.id, 12);
  });

  it("copes with a comment that has no user or no body (a deleted account)", () => {
    assert.equal(findOwnComment([{ id: 1, user: null, body: BODY }, { id: 2, user: BOT, body: null }], COMMENT_MARKER), undefined);
  });
});

describe("upsertComment", () => {
  const base = { repository: REPOSITORY, pullNumber: 7, body: BODY, marker: COMMENT_MARKER };

  it("creates the comment when there is none", async () => {
    const { gh, calls } = fakeGh([
      ["GET repos/acme/paywall/issues/7/comments", ok([{ id: 1, user: { login: "alice", type: "User" }, body: "hi" }])],
      ["POST repos/acme/paywall/issues/7/comments", ok({ id: 99 })],
    ]);
    const { log } = quiet();
    const result = await upsertComment({ ...base, gh, log });
    assert.equal(result.action, "created");
    const post = calls.find((call) => call.args.includes("POST"));
    assert.deepEqual(JSON.parse(post.input), { body: BODY });
  });

  it("updates the comment it wrote before, and creates none", async () => {
    const { gh, calls } = fakeGh([
      ["GET repos/acme/paywall/issues/7/comments", ok([{ id: 41, user: BOT, body: `${COMMENT_MARKER}\nold` }])],
      ["PATCH repos/acme/paywall/issues/comments/41", ok({ id: 41 })],
    ]);
    const result = await upsertComment({ ...base, gh, log: () => {} });
    assert.equal(result.action, "updated");
    assert.equal(calls.filter((call) => call.args.includes("POST")).length, 0);
    assert.deepEqual(JSON.parse(calls.find((call) => call.args.includes("PATCH")).input), { body: BODY });
  });

  it("never updates someone else's comment that carries the marker: it writes its own", async () => {
    const { gh, calls } = fakeGh([
      ["GET repos/acme/paywall/issues/7/comments", ok([{ id: 8, user: { login: "mallory", type: "User" }, body: BODY }])],
      ["POST repos/acme/paywall/issues/7/comments", ok({ id: 100 })],
    ]);
    const result = await upsertComment({ ...base, gh, log: () => {} });
    assert.equal(result.action, "created");
    assert.equal(calls.filter((call) => call.args.includes("PATCH")).length, 0);
  });

  it("looks through every page of comments", async () => {
    const page1 = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, user: { login: "alice", type: "User" }, body: "x" }));
    const { gh, calls } = fakeGh([
      ["GET repos/acme/paywall/issues/7/comments?per_page=100&page=1", ok(page1)],
      ["GET repos/acme/paywall/issues/7/comments?per_page=100&page=2", ok([{ id: 500, user: BOT, body: BODY }])],
      ["PATCH repos/acme/paywall/issues/comments/500", ok({ id: 500 })],
    ]);
    const result = await upsertComment({ ...base, gh, log: () => {} });
    assert.equal(result.action, "updated");
    assert.equal(calls.filter((call) => call.args[1].includes("page=")).length, 2);
  });

  it("sends the body on stdin as JSON, never on the command line", async () => {
    const nasty = `${COMMENT_MARKER}\n"; rm -rf / #\n$(whoami) \`id\``;
    const { gh, calls } = fakeGh([
      ["GET", ok([])],
      ["POST", ok({ id: 1 })],
    ]);
    await upsertComment({ ...base, body: nasty, gh, log: () => {} });
    for (const call of calls) for (const arg of call.args) assert.ok(!arg.includes("rm -rf"), arg);
    assert.equal(JSON.parse(calls.find((call) => call.args.includes("POST")).input).body, nasty);
  });

  describe("a 403, as a fork's token gets", () => {
    it("on listing: logged, nothing posted, no throw", async () => {
      const { gh, calls } = fakeGh([["GET", http(403, "Resource not accessible by integration")]]);
      const { lines, log } = quiet();
      const result = await upsertComment({ ...base, gh, log });
      assert.equal(result.action, "skipped");
      assert.equal(result.reason, "forbidden");
      assert.match(lines.join("\n"), /403/);
      assert.match(lines.join("\n"), /not posted|no comment/i);
      assert.equal(calls.length, 1);
    });

    it("on creating: logged, no throw", async () => {
      const { gh } = fakeGh([["GET", ok([])], ["POST", http(403)]]);
      const { lines, log } = quiet();
      const result = await upsertComment({ ...base, gh, log });
      assert.equal(result.action, "skipped");
      assert.match(lines.join("\n"), /403/);
    });

    it("on updating: logged, no throw", async () => {
      const { gh } = fakeGh([["GET", ok([{ id: 2, user: BOT, body: BODY }])], ["PATCH", http(403)]]);
      const { lines, log } = quiet();
      const result = await upsertComment({ ...base, gh, log });
      assert.equal(result.action, "skipped");
      assert.match(lines.join("\n"), /403/);
    });
  });

  describe("any other failure", () => {
    it("is logged as a warning and does not throw: the comment is not the verdict of the job", async () => {
      for (const failure of [http(500, "Server Error"), { code: 1, stdout: "", stderr: "connection reset" }, { code: 0, stdout: "not json", stderr: "" }]) {
        const { gh } = fakeGh([["GET", failure]]);
        const { lines, log } = quiet();
        const result = await upsertComment({ ...base, gh, log });
        assert.equal(result.action, "skipped");
        assert.match(lines.join("\n"), /warning/i);
      }
    });

    it("does not let text from gh start a workflow command in the log", async () => {
      const { gh } = fakeGh([["GET", { code: 1, stdout: "", stderr: "\u001b[2J\n::set-output name=x::1\nHTTP 500" }]]);
      const { lines, log } = quiet();
      await upsertComment({ ...base, gh, log });
      for (const line of lines.join("\n").split("\n")) assert.ok(!/^\s*(::|##\[)/.test(line), line);
      assert.ok(!lines.join("\n").includes("\u001b"));
    });
  });

  it("refuses a body that does not start with the marker: it posts only what Wasit wrote", async () => {
    const { gh, calls } = fakeGh([]);
    const result = await upsertComment({ ...base, body: "just some text", gh, log: () => {} });
    assert.equal(result.action, "skipped");
    assert.equal(result.reason, "not-a-wasit-comment");
    assert.equal(calls.length, 0);
  });

  it("refuses a body over what GitHub accepts", async () => {
    const { gh, calls } = fakeGh([]);
    const result = await upsertComment({ ...base, body: `${COMMENT_MARKER}\n${"x".repeat(66_000)}`, gh, log: () => {} });
    assert.equal(result.action, "skipped");
    assert.equal(calls.length, 0);
  });

  it("refuses a repository or a pull request number that is not one", async () => {
    const { gh, calls } = fakeGh([]);
    for (const bad of [{ repository: "acme/paywall; id" }, { repository: "no-slash" }, { pullNumber: 0 }, { pullNumber: -3 }, { pullNumber: "7; id" }, { pullNumber: 1.5 }]) {
      const result = await upsertComment({ ...base, ...bad, gh, log: () => {} });
      assert.equal(result.action, "skipped", JSON.stringify(bad));
    }
    assert.equal(calls.length, 0);
  });
});

describe("main, the step as the workflow runs it", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-action-comment-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function setup({ eventName = "pull_request", headRepo = REPOSITORY, comment = BODY } = {}) {
    const eventPath = path.join(dir, `event-${Math.random().toString(16).slice(2)}.json`);
    const commentPath = path.join(dir, `comment-${Math.random().toString(16).slice(2)}.md`);
    await writeFile(eventPath, JSON.stringify({ repository: { full_name: REPOSITORY }, pull_request: { number: 7, head: { repo: { full_name: headRepo } } } }));
    await writeFile(commentPath, comment);
    return { GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: REPOSITORY, WASIT_COMMENT_FILE: commentPath };
  }

  it("posts on a pull request from the same repository, and exits 0", async () => {
    const env = await setup();
    const { gh, calls } = fakeGh([["GET", ok([])], ["POST", ok({ id: 1 })]]);
    const { log } = quiet();
    assert.equal(await main(env, { gh, log }), 0);
    assert.equal(calls.filter((call) => call.args.includes("POST")).length, 1);
  });

  it("does not call gh at all for a pull request from a fork, says why, and exits 0", async () => {
    const env = await setup({ headRepo: "mallory/paywall" });
    const { gh, calls } = fakeGh([]);
    const { lines, log } = quiet();
    assert.equal(await main(env, { gh, log }), 0);
    assert.equal(calls.length, 0);
    assert.match(lines.join("\n"), /fork/);
    assert.match(lines.join("\n"), /job summary/);
  });

  it("does nothing on a push, and exits 0", async () => {
    const env = await setup({ eventName: "push" });
    const { gh, calls } = fakeGh([]);
    assert.equal(await main(env, { gh, log: () => {} }), 0);
    assert.equal(calls.length, 0);
  });

  it("exits 0 when the comment file is missing: the report may not have been written", async () => {
    const env = await setup();
    const { gh, calls } = fakeGh([]);
    assert.equal(await main({ ...env, WASIT_COMMENT_FILE: path.join(dir, "no-such-comment.md") }, { gh, log: () => {} }), 0);
    assert.equal(calls.length, 0);
  });

  it("exits 0 when gh answers 403", async () => {
    const env = await setup();
    const { gh } = fakeGh([["GET", http(403)]]);
    assert.equal(await main(env, { gh, log: () => {} }), 0);
  });
});
