/**
 * The run's status on the pull request (Najmi, 2026-11-20): a check run named
 * "Wasit conformance", and a comment that says Wasit is running.
 *
 * - `start`: creates the check run, in progress, on the commit under test, and,
 *   on a pull request from this repository, writes the running comment: the same
 *   comment, found by the same marker, that the result replaces at the end.
 * - `finish`: completes the check run with the title, summary and conclusion
 *   that `wasit ci-report --check-run` wrote, and only when the report step
 *   succeeded; otherwise with a fixed neutral text.
 *
 * What keeps the key and the token apart: this step holds the job's token and
 * never the payer key (the action sets the key variables empty here), and the
 * step that runs Wasit and the service holds the key and never the token. So the
 * check run is not updated check by check during the run: that would put a
 * write token in the run step, beside a service that on a pull request may be
 * the author's own code. The job log shows each check as it runs.
 *
 * A pull request from a fork gets a read-only token, so nothing is tried. No
 * failure here fails the job: the job's result is the exit code of `wasit run`.
 */

import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderRunningComment } from "../../packages/core/dist/ci-report.js";
import { httpStatus, isForkPullRequest, upsertComment } from "./comment.mjs";
import { REPOSITORY, oneLine, positiveInteger } from "./common.mjs";
import { realGh } from "./gh.mjs";

/** The name the check run shows in the pull request's checks. */
export const CHECK_NAME = "Wasit conformance";

const SHA = /^[0-9a-f]{40}$/;
const SERVER = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;
const RUN_ID = /^[0-9]{1,20}$/;
const CONCLUSIONS = new Set(["success", "failure", "neutral"]);
/** GitHub's limits on a check run's output. */
const MAX_TITLE = 255;
const MAX_SUMMARY = 65_535;

/** What the check run says when there is no report to show, or the report step did not succeed. */
export const NO_REPORT_OUTPUT = Object.freeze({
  title: "⚠️ no verdict · Wasit wrote no report",
  summary: "The run ended before Wasit wrote a report, so nothing was graded. The reason is in the job log.",
  conclusion: "neutral",
});

/** The run's page, from the three variables GitHub sets; undefined when one has another shape. */
export function runUrl(env) {
  const server = env["GITHUB_SERVER_URL"];
  const repository = env["GITHUB_REPOSITORY"];
  const id = env["GITHUB_RUN_ID"];
  if (typeof server !== "string" || !SERVER.test(server)) return undefined;
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) return undefined;
  if (typeof id !== "string" || !RUN_ID.test(id)) return undefined;
  return `${server}/${repository}/actions/runs/${id}`;
}

/** The commit under test: the pull request's head on a pull request, else GITHUB_SHA; undefined unless 40 hex characters. */
export function headSha(env, event) {
  const sha = env["GITHUB_EVENT_NAME"] === "pull_request" ? event?.pull_request?.head?.sha : env["GITHUB_SHA"];
  return typeof sha === "string" && SHA.test(sha) ? sha : undefined;
}

function readEvent(env) {
  try {
    return JSON.parse(readFileSync(env["GITHUB_EVENT_PATH"] ?? "", "utf-8"));
  } catch {
    return undefined;
  }
}

function writeOutput(env, name, value) {
  const file = env["GITHUB_OUTPUT"];
  if (typeof file === "string" && file !== "") appendFileSync(file, `${name}=${value}\n`);
}

/** The check run's output from the file the report step wrote: each field checked, cut to GitHub's limits, neutral when unusable. */
export function checkRunOutput(text) {
  if (typeof text !== "string") return { ...NO_REPORT_OUTPUT };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ...NO_REPORT_OUTPUT };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ...NO_REPORT_OUTPUT };
  return {
    title: typeof value.title === "string" && value.title !== "" ? value.title.slice(0, MAX_TITLE) : NO_REPORT_OUTPUT.title,
    summary: typeof value.summary === "string" && value.summary !== "" ? value.summary.slice(0, MAX_SUMMARY) : NO_REPORT_OUTPUT.summary,
    conclusion: CONCLUSIONS.has(value.conclusion) ? value.conclusion : "neutral",
  };
}

/**
 * The start step: the check run, then the running comment. Always exits 0.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ gh?: Function, log?: (line: string) => void, now?: () => Date }} deps
 */
export async function start(env = process.env, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  const now = deps.now ?? (() => new Date());
  try {
    const repository = env["GITHUB_REPOSITORY"];
    if (typeof repository !== "string" || !REPOSITORY.test(repository)) {
      log("Wasit warning: no check run and no running comment, the repository is not what a workflow gives.");
      return 0;
    }
    const event = readEvent(env);
    const pullRequest = env["GITHUB_EVENT_NAME"] === "pull_request";
    if (pullRequest && isForkPullRequest(event)) {
      log("Wasit: this pull request is from a fork, so the token is read-only: no check run and no running comment. The job's own check shows the run.");
      return 0;
    }
    const gh = deps.gh ?? realGh(env);
    const url = runUrl(env);
    const startedAt = now().toISOString();

    const sha = headSha(env, event);
    if (sha === undefined) {
      log("Wasit warning: no check run, the commit under test is not named the way GitHub names it.");
    } else {
      const input = JSON.stringify({
        name: CHECK_NAME,
        head_sha: sha,
        status: "in_progress",
        started_at: startedAt,
        ...(url === undefined ? {} : { details_url: url }),
        output: {
          title: "Running Wasit",
          summary: "Wasit is running. The result replaces this when the run ends; the job log shows each check as it runs.",
        },
      });
      const result = await gh(["api", `repos/${repository}/check-runs`, "--method", "POST", "-H", "Content-Type: application/json", "--input", "-"], {
        input,
      });
      if (result.code !== 0) {
        log(
          httpStatus(result) === 403
            ? "Wasit: GitHub answered 403 to the check run, so the workflow does not give `checks: write`: there is no Wasit conformance check. The job's own check shows the run."
            : `Wasit warning: could not create the check run: ${oneLine(result.stderr || result.stdout || "no answer")}`,
        );
      } else {
        let id;
        try {
          id = positiveInteger(JSON.parse(result.stdout)?.id);
        } catch {
          id = undefined;
        }
        if (id === undefined) {
          log("Wasit warning: GitHub's answer names no check run id, so the check run cannot be completed.");
        } else {
          writeOutput(env, "check_run_id", String(id));
          log(`Wasit: check run "${CHECK_NAME}" started.`);
        }
      }
    }

    if (pullRequest) {
      const environment = env["INPUT_ENVIRONMENT"];
      await upsertComment({
        gh,
        repository,
        pullNumber: event?.pull_request?.number,
        body: renderRunningComment({
          startedAt,
          ...(url === undefined ? {} : { runUrl: url }),
          ...(typeof environment === "string" && environment !== "" ? { environment } : {}),
        }),
        log,
      });
    }
  } catch (error) {
    log(`Wasit warning: the start step failed: ${oneLine(error instanceof Error ? error.message : error)}`);
  }
  return 0;
}

/**
 * The finish step: completes the check run. Always exits 0.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ gh?: Function, log?: (line: string) => void, now?: () => Date }} deps
 */
export async function finish(env = process.env, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  const now = deps.now ?? (() => new Date());
  try {
    const repository = env["GITHUB_REPOSITORY"];
    const id = positiveInteger(env["CHECK_RUN_ID"]);
    if (typeof repository !== "string" || !REPOSITORY.test(repository) || id === undefined) {
      log("Wasit warning: the check run is not completed, the repository or its id is not what a workflow gives.");
      return 0;
    }
    // Only a file the report step wrote is used: if that step did not succeed, a
    // file in its place could have been left by anything that ran before it.
    let text;
    if (env["REPORT_OUTCOME"] === "success") {
      try {
        text = readFileSync(env["WASIT_CHECK_RUN_FILE"] ?? "", "utf-8");
      } catch {
        text = undefined;
      }
    }
    const output = checkRunOutput(text);
    const input = JSON.stringify({
      status: "completed",
      conclusion: output.conclusion,
      completed_at: now().toISOString(),
      output: { title: output.title, summary: output.summary },
    });
    const gh = deps.gh ?? realGh(env);
    const result = await gh(["api", `repos/${repository}/check-runs/${id}`, "--method", "PATCH", "-H", "Content-Type: application/json", "--input", "-"], {
      input,
    });
    if (result.code !== 0) {
      log(`Wasit warning: could not complete the check run: ${oneLine(result.stderr || result.stdout || "no answer")}`);
    } else {
      log(`Wasit: check run "${CHECK_NAME}" completed (${output.conclusion}).`);
    }
  } catch (error) {
    log(`Wasit warning: the finish step failed: ${oneLine(error instanceof Error ? error.message : error)}`);
  }
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const mode = process.argv[2];
  process.exitCode = mode === "start" ? await start(process.env) : mode === "finish" ? await finish(process.env) : 0;
}
