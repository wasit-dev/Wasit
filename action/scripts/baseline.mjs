/**
 * Choosing the baseline for a run (spec A5, A8 #4, A-A05).
 *
 * The RUN is chosen first: the latest successful `push` run of this workflow on
 * the default branch, from this repository. Only then is that run's
 * `wasit-baseline` artifact downloaded, by run id. Never "the newest artifact
 * with that name": a pull request run (a fork's too, which runs the fork's copy
 * of the workflow file) can upload an artifact with that name, and a fork can
 * have a branch called main.
 *
 * Whether the file is a report, and whether it may be compared, is the CLI's to
 * say (core `readBaseline`); this script only picks and downloads. It never fails
 * the job: no baseline is a state the comment already explains.
 */

import { mkdir, readdir } from "node:fs/promises";
import { appendFile, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPOSITORY, api, oneLine, positiveInteger } from "./common.mjs";
import { realGh } from "./gh.mjs";

/** The name the baseline is uploaded under. */
export const BASELINE_ARTIFACT = "wasit-baseline";

/**
 * Which finished runs may be a baseline. Only 'success': a run that failed or
 * was cancelled is not the state of main to compare with.
 */
export const ACCEPTED_CONCLUSIONS = Object.freeze(["success"]);

const sameName = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * The run to take the baseline from, out of the runs the API listed.
 *
 * @param {unknown[] | undefined} runs
 * @param {{ repository: string, defaultBranch: string, workflowId: number, currentRunId: number }} context
 */
export function selectBaselineRun(runs, context) {
  const eligible = (Array.isArray(runs) ? runs : []).filter(
    (run) =>
      run !== null &&
      typeof run === "object" &&
      Number.isSafeInteger(run.id) &&
      run.id !== context.currentRunId &&
      run.event === "push" &&
      run.head_branch === context.defaultBranch &&
      run.status === "completed" &&
      ACCEPTED_CONCLUSIONS.includes(run.conclusion) &&
      run.workflow_id === context.workflowId &&
      sameName(run.head_repository?.full_name, context.repository) &&
      sameName(run.repository?.full_name, context.repository),
  );
  const time = (run) => Date.parse(run.created_at) || 0;
  return eligible.sort((a, b) => time(b) - time(a) || b.id - a.id)[0];
}

/**
 * Finds and downloads the baseline.
 *
 * @param {{ gh: Function, repository: string, runId: number | string, directory: string, defaultBranch?: string, log?: (line: string) => void }} options
 * @returns {Promise<{ path?: string }>} the downloaded file, if there is one
 */
export async function findBaseline({ gh, repository, runId, directory, defaultBranch, log = console.log }) {
  const none = (reason) => {
    log(`Wasit: no baseline (${reason}). The comment will say there is nothing to compare with.`);
    return {};
  };

  const currentRunId = positiveInteger(runId);
  if (typeof repository !== "string" || !REPOSITORY.test(repository) || currentRunId === undefined) {
    return none("the repository or the run id is not what a workflow gives");
  }

  try {
    const branch = defaultBranch ?? (await api(gh, `repos/${repository}`)).default_branch;
    if (typeof branch !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(branch)) return none("the default branch is unknown");

    const workflowId = positiveInteger((await api(gh, `repos/${repository}/actions/runs/${currentRunId}`)).workflow_id);
    if (workflowId === undefined) return none("this run does not name its workflow");

    // `status=success` keeps the newest successful runs on the first page of a busy repository.
    const conclusion = ACCEPTED_CONCLUSIONS.length === 1 ? `&status=${ACCEPTED_CONCLUSIONS[0]}` : "";
    const listing = await api(
      gh,
      `repos/${repository}/actions/workflows/${workflowId}/runs?branch=${encodeURIComponent(branch)}&event=push${conclusion}&per_page=50`,
    );
    const chosen = selectBaselineRun(listing.workflow_runs, { repository, defaultBranch: branch, workflowId, currentRunId });
    if (chosen === undefined) return none(`no successful push run of this workflow on ${oneLine(branch, 60)} yet`);

    const artifacts = await api(gh, `repos/${repository}/actions/runs/${chosen.id}/artifacts?per_page=100&name=${BASELINE_ARTIFACT}`);
    const found = (Array.isArray(artifacts.artifacts) ? artifacts.artifacts : [])
      .filter(
        (artifact) =>
          artifact?.name === BASELINE_ARTIFACT &&
          artifact.expired !== true &&
          (artifact.workflow_run?.id === undefined || artifact.workflow_run.id === chosen.id),
      )
      .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))[0];
    if (found === undefined) return none(`run ${chosen.id} has no ${BASELINE_ARTIFACT} artifact, or it has expired`);

    await mkdir(directory, { recursive: true });
    const download = await gh(["run", "download", String(chosen.id), "--repo", repository, "--name", BASELINE_ARTIFACT, "--dir", directory]);
    if (download.code !== 0) return none(`the download failed: ${oneLine(download.stderr)}`);

    const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    if (files.length === 0) return none("the artifact held no JSON file");
    log(`Wasit: baseline from run ${chosen.id} on ${oneLine(branch, 60)}.`);
    return { path: path.join(directory, files[0]) };
  } catch (error) {
    return none(oneLine(error instanceof Error ? error.message : error));
  }
}

/**
 * The step: reads the workflow's environment, finds the baseline, writes
 * `path=<file>` (empty when there is none) to the step output. Always exits 0.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ gh?: Function, log?: (line: string) => void }} deps
 */
export async function main(env = process.env, deps = {}) {
  const log = deps.log ?? ((line) => console.log(line));
  let result = {};
  try {
    const gh = deps.gh ?? realGh(env);
    let defaultBranch;
    try {
      const event = JSON.parse(readFileSync(env["GITHUB_EVENT_PATH"] ?? "", "utf-8"));
      if (typeof event?.repository?.default_branch === "string") defaultBranch = event.repository.default_branch;
    } catch {
      // The event file may be absent or have no repository (a schedule): findBaseline asks the API.
    }
    const temp = env["RUNNER_TEMP"];
    if (typeof temp !== "string" || !path.isAbsolute(temp)) {
      log("Wasit: no baseline (RUNNER_TEMP is not set).");
    } else {
      result = await findBaseline({
        gh,
        repository: env["GITHUB_REPOSITORY"],
        runId: env["GITHUB_RUN_ID"],
        directory: path.join(temp, "wasit", "baseline"),
        ...(defaultBranch === undefined ? {} : { defaultBranch }),
        log,
      });
    }
  } catch (error) {
    log(`Wasit: no baseline (${oneLine(error instanceof Error ? error.message : error)}).`);
  }
  const output = env["GITHUB_OUTPUT"];
  if (typeof output === "string" && output !== "") {
    await new Promise((resolve) => appendFile(output, `path=${result.path ?? ""}\n`, () => resolve(undefined)));
  }
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await main(process.env);
}
