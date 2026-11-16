/**
 * Choosing the baseline for a run (spec A5, A8 #4, A-A05).
 *
 * The RUN is chosen first: the latest successful run of this workflow on the
 * default branch, from this repository, started by a push, a schedule or a
 * workflow_dispatch. Only then is that run's
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

/**
 * The events whose runs may be a baseline: those that run merged code on the
 * default branch, which are also the only ones where the payment tier pays
 * (D-022a). A pull request run, a merge queue run and a workflow_run never are.
 */
export const BASELINE_EVENTS = Object.freeze(["push", "schedule", "workflow_dispatch"]);

const sameName = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * The run to take the baseline from, out of the runs the API listed.
 *
 * @param {unknown[] | undefined} runs
 * @param {{ repository: string, defaultBranch: string, workflowId: number, currentRunId: number }} context
 * @param {readonly string[]} [conclusions] the conclusions that count; default the green ones
 */
export function selectBaselineRun(runs, context, conclusions = ACCEPTED_CONCLUSIONS) {
  const eligible = (Array.isArray(runs) ? runs : []).filter(
    (run) =>
      run !== null &&
      typeof run === "object" &&
      Number.isSafeInteger(run.id) &&
      run.id !== context.currentRunId &&
      BASELINE_EVENTS.includes(run.event) &&
      run.head_branch === context.defaultBranch &&
      run.status === "completed" &&
      conclusions.includes(run.conclusion) &&
      run.workflow_id === context.workflowId &&
      sameName(run.head_repository?.full_name, context.repository) &&
      sameName(run.repository?.full_name, context.repository),
  );
  const time = (run) => Date.parse(run.created_at) || 0;
  return eligible.sort((a, b) => time(b) - time(a) || b.id - a.id)[0];
}

/**
 * The conclusions of a run whose history counts (D-022b option 2): every run
 * that finished with a verdict, failed ones included, so the recent-failures
 * line can count a failure. Not cancelled, skipped or timed out.
 */
export const HISTORY_CONCLUSIONS = Object.freeze(["success", "failure"]);

/**
 * Finds and downloads the baseline (D-022b option 2): the comparison from the
 * last green run on the default branch, the history from the newest run there
 * that finished, failed or not. Each run is chosen first and its own artifact
 * downloaded by run id. When both are the same run it is downloaded once.
 *
 * @param {{ gh: Function, repository: string, runId: number | string, directory: string, historyDirectory?: string, defaultBranch?: string, log?: (line: string) => void }} options
 * @returns {Promise<{ path?: string, run?: number, history?: string }>}
 */
export async function findBaseline({ gh, repository, runId, directory, historyDirectory, defaultBranch, log = console.log }) {
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

    const context = { repository, defaultBranch: branch, workflowId, currentRunId };
    const listed = async (status) =>
      (
        await api(
          gh,
          // `status=` keeps the runs wanted on the first page of a busy repository. The API
          // takes one event at a time, so the events are filtered here.
          `repos/${repository}/actions/workflows/${workflowId}/runs?branch=${encodeURIComponent(branch)}&status=${status}&per_page=50`,
        )
      ).workflow_runs;

    /** The run's baseline file, downloaded into `into`, or the reason there is none. */
    const download = async (chosen, into) => {
      const artifacts = await api(gh, `repos/${repository}/actions/runs/${chosen.id}/artifacts?per_page=100&name=${BASELINE_ARTIFACT}`);
      const found = (Array.isArray(artifacts.artifacts) ? artifacts.artifacts : [])
        .filter(
          (artifact) =>
            artifact?.name === BASELINE_ARTIFACT &&
            artifact.expired !== true &&
            (artifact.workflow_run?.id === undefined || artifact.workflow_run.id === chosen.id),
        )
        .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))[0];
      if (found === undefined) return { reason: `run ${chosen.id} has no ${BASELINE_ARTIFACT} artifact, or it has expired` };
      await mkdir(into, { recursive: true });
      const result = await gh(["run", "download", String(chosen.id), "--repo", repository, "--name", BASELINE_ARTIFACT, "--dir", into]);
      if (result.code !== 0) return { reason: `the download failed: ${oneLine(result.stderr)}` };
      const files = (await readdir(into)).filter((name) => name.endsWith(".json")).sort();
      if (files.length === 0) return { reason: "the artifact held no JSON file" };
      return { path: path.join(into, files[0]) };
    };

    const result = {};
    const green = selectBaselineRun(await listed("success"), context);
    if (green === undefined) {
      log(`Wasit: no baseline (no successful push, schedule or workflow_dispatch run of this workflow on ${oneLine(branch, 60)} yet). The comment will say there is nothing to compare with.`);
    } else {
      const got = await download(green, directory);
      if (got.path === undefined) {
        log(`Wasit: no baseline (${got.reason}). The comment will say there is nothing to compare with.`);
      } else {
        log(`Wasit: baseline from run ${green.id} on ${oneLine(branch, 60)}, the last green run there.`);
        result.path = got.path;
        result.run = green.id;
      }
    }

    const finished = selectBaselineRun(await listed("completed"), context, HISTORY_CONCLUSIONS);
    if (finished !== undefined) {
      if (green !== undefined && finished.id === green.id) {
        if (result.path !== undefined) result.history = result.path;
      } else {
        const got = await download(finished, historyDirectory ?? `${directory}-history`);
        if (got.path === undefined) {
          log(`Wasit: the history of run ${finished.id} is not used (${got.reason}).`);
        } else {
          log(`Wasit: history from run ${finished.id} on ${oneLine(branch, 60)}, the newest finished run there.`);
          result.history = got.path;
        }
      }
    }
    if (result.history === undefined && result.path !== undefined) result.history = result.path;
    return result;
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
        historyDirectory: path.join(temp, "wasit", "history"),
        ...(defaultBranch === undefined ? {} : { defaultBranch }),
        log,
      });
    }
  } catch (error) {
    log(`Wasit: no baseline (${oneLine(error instanceof Error ? error.message : error)}).`);
  }
  const output = env["GITHUB_OUTPUT"];
  if (typeof output === "string" && output !== "") {
    const lines = `path=${result.path ?? ""}\nrun=${result.run ?? ""}\nhistory=${result.history ?? ""}\n`;
    await new Promise((resolve) => appendFile(output, lines, () => resolve(undefined)));
  }
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await main(process.env);
}
