/**
 * The steps of the Action that run Wasit: `check` the inputs, `run` the CLI,
 * `report` (the comment, the summary and the next baseline).
 *
 * The Action is a thin wrapper. Every decision (the verdict, the exit code, what
 * the comment says, how the baseline is read) is the CLI's, which is unit-tested
 * offline. This file builds the command line, takes the job's token out of the
 * environment it passes on, and returns the CLI's exit code unchanged.
 *
 * Plain ES module: no build. Needs Node 22 or later, which the first step of the
 * Action checks. Imports nothing from Wasit, so `check` can run before the install.
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { InputError, MainnetRefusedError, buildReportArgs, buildRunArgs, parseInputs, scrubTokens } from "./inputs.mjs";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The directory of this Action's files in the runner's temp directory. Never inside the checkout. */
function workDirectory(env) {
  const temp = env["RUNNER_TEMP"];
  if (typeof temp !== "string" || !path.isAbsolute(temp)) throw new InputError("RUNNER_TEMP is not set: this script runs as a step of a workflow.");
  return path.join(temp, "wasit");
}

/** The CLI, in the checkout this Action was fetched in: the Wasit repository root is the parent of action/. */
function cliPath(env) {
  const actionPath = env["ACTION_PATH"];
  if (typeof actionPath !== "string" || actionPath === "") throw new InputError("ACTION_PATH is not set: this script runs as a step of the Action.");
  return path.resolve(actionPath, "..", "packages", "cli", "dist", "index.js");
}

/** A file the baseline step downloaded (`BASELINE_PATH`, `HISTORY_PATH`), if it is a file inside the work directory. Anything else is ignored. */
function baselineFile(env, work, name = "BASELINE_PATH") {
  const given = env[name];
  if (typeof given !== "string" || given === "") return undefined;
  const resolved = path.resolve(given);
  if (!resolved.startsWith(`${work}${path.sep}`)) return undefined;
  try {
    return statSync(resolved).isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** Appends `text` to the job summary, when the runner gives one. A summary that cannot be written is not an error. */
function writeSummary(env, text) {
  const file = env["GITHUB_STEP_SUMMARY"];
  if (typeof file !== "string" || !path.isAbsolute(file)) return;
  try {
    appendFileSync(file, text);
  } catch {
    // The refusal is in the log already.
  }
}

/**
 * Says to later steps whether this is a mainnet run (`mainnet=true|false`), when
 * the runner gives an output file: the ledger upload's condition (B18 O3). An
 * output that cannot be written is an error: the upload would not run.
 */
function writeMainnetOutput(env, mainnet) {
  const file = env["GITHUB_OUTPUT"];
  if (typeof file !== "string" || file === "") return;
  if (!path.isAbsolute(file)) throw new InputError("GITHUB_OUTPUT is not an absolute path.");
  appendFileSync(file, `mainnet=${mainnet ? "true" : "false"}\n`);
}

/** Runs the CLI with `args`, passes signals on to it, and resolves to its exit code. */
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: scrubTokens(env), stdio: "inherit" });
    const forward = (signal) => child.kill(signal);
    for (const signal of SIGNALS) process.on(signal, forward);
    const finish = (code) => {
      for (const signal of SIGNALS) process.removeListener(signal, forward);
      resolve(code);
    };
    child.on("error", () => finish(2));
    child.on("close", (code, signal) => finish(code ?? 128 + (signal === null ? 0 : (os.constants.signals[signal] ?? 0))));
  });
}

/**
 * @param {string} command `check`, `run` or `report`
 * @param {Record<string, string | undefined>} env the environment of the step
 * @param {{ stdout?: (line: string) => void, stderr?: (line: string) => void }} io
 * @returns {Promise<number>} the exit code of the step
 */
export async function main(command, env = process.env, io = {}) {
  const stderr = io.stderr ?? ((line) => console.error(line));
  try {
    if (command === "check") {
      const inputs = parseInputs(env);
      mkdirSync(workDirectory(env), { recursive: true });
      writeMainnetOutput(env, inputs.mainnet);
      return 0;
    }

    if (command === "run" || command === "report") {
      const work = workDirectory(env);
      const cli = cliPath(env);
      if (!existsSync(cli)) throw new InputError("the Wasit CLI is not built where this action was fetched: the install step did not run.");
      const paths = {
        cli,
        report: path.join(work, "report.json"),
        comment: path.join(work, "comment.md"),
        baselineOut: path.join(work, "baseline-next.json"),
        checkRun: path.join(work, "check-run.json"),
        // A mainnet run's ledger and lock (B18 O3); the last step uploads the ledger.
        ledgerDir: path.join(work, "ledger"),
        baseline: baselineFile(env, work),
        history: baselineFile(env, work, "HISTORY_PATH"),
        // A run id is digits only; anything else is not passed on.
        baselineRun: /^[1-9][0-9]{0,15}$/.test(env["BASELINE_RUN"] ?? "") ? env["BASELINE_RUN"] : undefined,
      };
      const args = command === "run" ? buildRunArgs(parseInputs(env), paths) : buildReportArgs(paths);
      return await runCli(args, env);
    }

    throw new InputError("unknown command: expected check, run or report.");
  } catch (error) {
    if (error instanceof InputError) {
      stderr(`Wasit: ${error.message}`);
      // Spec B5: a run that asked for mainnet says in its summary that it was refused.
      if (error instanceof MainnetRefusedError) writeSummary(env, `## Wasit: refused\n\n${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await main(process.argv[2] ?? "", process.env);
}
