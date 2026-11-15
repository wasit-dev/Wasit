/**
 * The pull request comment (spec A4 step 5, A8 #8): one comment, found by its
 * marker and updated on each push.
 *
 * - Only a comment by github-actions[bot] that STARTS with the marker is Wasit's.
 *   Someone quoting the marker is not.
 * - A pull request from a fork gets a read-only token, so it is not even tried:
 *   the result is in the job summary and in the job's result.
 * - A 403 is logged and does not fail the job. No other failure of this step
 *   does either: the job's result is the exit code of `wasit run`, and the
 *   comment is not the verdict.
 *
 * The body is whatever `wasit ci-report` wrote. This script refuses a file that
 * does not start with the marker, so it posts nothing else.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMMENT_MARKER } from "../../packages/core/dist/ci-report.js";
import { REPOSITORY, oneLine, positiveInteger } from "./common.mjs";
import { realGh } from "./gh.mjs";

/** The author of a comment made with the workflow's own token. */
export const GITHUB_ACTIONS_BOT = "github-actions[bot]";

/** GitHub refuses a comment over 65,536 characters; core cuts at 60,000. */
const MAX_BODY = 65_000;
const MAX_PAGES = 20;

const sameName = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * True when the pull request comes from another repository, or when the event
 * does not say where it comes from: the token is then read-only, or must be
 * treated as if it were.
 */
export function isForkPullRequest(event) {
  const head = event?.pull_request?.head?.repo?.full_name;
  const base = event?.repository?.full_name;
  return typeof head !== "string" || typeof base !== "string" || !sameName(head, base);
}

/** The status gh printed for a failed call (`HTTP 403`), if any. */
export function httpStatus(result) {
  if (result.code === 0) return undefined;
  const match = /\bHTTP (\d{3})\b/.exec(`${result.stderr}\n${result.stdout}`);
  return match === null ? undefined : Number(match[1]);
}

/** The comment Wasit wrote before: by the Actions bot, and starting with the marker. The oldest if there are several. */
export function findOwnComment(comments, marker) {
  return (Array.isArray(comments) ? comments : [])
    .filter(
      (comment) =>
        comment?.user?.login === GITHUB_ACTIONS_BOT &&
        comment.user.type === "Bot" &&
        typeof comment.body === "string" &&
        comment.body.startsWith(marker) &&
        Number.isSafeInteger(comment.id),
    )
    .sort((a, b) => a.id - b.id)[0];
}

/**
 * Creates the comment or updates the one Wasit wrote. Never throws.
 *
 * @returns {Promise<{ action: "created" | "updated" | "skipped", reason?: string }>}
 */
export async function upsertComment({ gh, repository, pullNumber, body, marker = COMMENT_MARKER, log = console.log }) {
  const skip = (reason, line) => {
    log(line);
    return { action: "skipped", reason };
  };
  const number = positiveInteger(pullNumber);
  if (typeof repository !== "string" || !REPOSITORY.test(repository) || number === undefined) {
    return skip("invalid-input", "Wasit warning: no comment posted, the repository or the pull request number is not what a workflow gives.");
  }
  if (typeof body !== "string" || !body.startsWith(marker)) {
    return skip("not-a-wasit-comment", "Wasit warning: no comment posted, the file does not start with the Wasit marker.");
  }
  if (body.length > MAX_BODY) return skip("too-long", "Wasit warning: no comment posted, it is longer than GitHub accepts. The job summary has the report.");

  /** Reports a failed call the way this step does, as a skip. */
  const failure = (what, result) => {
    const status = httpStatus(result);
    if (status === 403) {
      return skip(
        "forbidden",
        `Wasit: GitHub answered 403 to ${what}. The token cannot write comments here (a pull request from a fork gets a read-only one), so no comment was posted. The result is in the job summary.`,
      );
    }
    return skip("error", `Wasit warning: could not ${what}: ${oneLine(result.stderr || result.stdout || "no answer")}`);
  };

  const comments = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await gh(["api", `repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`]);
    if (result.code !== 0) return failure("read the comments", result);
    let batch;
    try {
      batch = JSON.parse(result.stdout);
    } catch {
      return skip("error", "Wasit warning: could not read the comments, GitHub did not answer with JSON.");
    }
    if (!Array.isArray(batch)) return skip("error", "Wasit warning: could not read the comments, GitHub did not answer with a list.");
    comments.push(...batch);
    if (batch.length < 100) break;
  }

  const own = findOwnComment(comments, marker);
  const input = JSON.stringify({ body });
  const write =
    own === undefined
      ? ["api", `repos/${repository}/issues/${number}/comments`, "--method", "POST", "-H", "Content-Type: application/json", "--input", "-"]
      : ["api", `repos/${repository}/issues/comments/${own.id}`, "--method", "PATCH", "-H", "Content-Type: application/json", "--input", "-"];
  const result = await gh(write, { input });
  if (result.code !== 0) return failure(own === undefined ? "post the comment" : "update the comment", result);

  log(own === undefined ? "Wasit: comment posted on the pull request." : "Wasit: comment on the pull request updated.");
  return { action: own === undefined ? "created" : "updated" };
}

/**
 * The step. Reads the workflow's environment, and always exits 0.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ gh?: Function, log?: (line: string) => void }} deps
 */
export async function main(env = process.env, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  try {
    if (env["GITHUB_EVENT_NAME"] !== "pull_request") {
      log("Wasit: not a pull request, so there is no comment to write.");
      return 0;
    }
    let event;
    try {
      event = JSON.parse(readFileSync(env["GITHUB_EVENT_PATH"] ?? "", "utf-8"));
    } catch {
      log("Wasit warning: no comment posted, the event file cannot be read.");
      return 0;
    }
    if (isForkPullRequest(event)) {
      log(
        "Wasit: this pull request is from a fork, so the token is read-only and no comment is posted. " +
          "The result is in the job summary and in the result of this job.",
      );
      return 0;
    }
    let body;
    try {
      body = readFileSync(env["WASIT_COMMENT_FILE"] ?? "", "utf-8");
    } catch {
      log("Wasit warning: no comment posted, the report was not written.");
      return 0;
    }
    await upsertComment({
      gh: deps.gh ?? realGh(env),
      repository: env["GITHUB_REPOSITORY"],
      pullNumber: event.pull_request?.number,
      body,
      log,
    });
  } catch (error) {
    log(`Wasit warning: the comment step failed: ${oneLine(error instanceof Error ? error.message : error)}`);
  }
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await main(process.env);
}
