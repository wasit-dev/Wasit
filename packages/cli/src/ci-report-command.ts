/**
 * `wasit ci-report`: the run report (and the baseline of the default branch, if
 * there is one) in; `comment.md`, the job summary and, when asked, the next
 * baseline out (spec A4, A5).
 *
 * It is a pure function over files. It decides nothing about the job: the job's
 * result is the exit code of `wasit run`. When the run left no usable report (the
 * service never started, never answered, or the config was unusable) it still
 * writes a fixed "no verdict" comment and summary, so the comment of the push
 * before does not stay next to a red check, and it writes no baseline. It exits 2
 * when the report is there but unusable, or when it cannot write what it was asked.
 */

import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";

import {
  MAX_BASELINE_BYTES,
  ReportFormatError,
  deniedEnvValues,
  parseRunReport,
  readBaseline,
  readBuildCommit,
  readToolVersions,
  renderComment,
  renderNoReportComment,
  renderNoReportSummary,
  renderSummary,
  sanitizeText,
  selectBaseline,
  serializeBaseline,
  updateHistory,
  type BaselineResult,
  type RunReport,
} from "@wasit-dev/core";

import { CLI_VERSION } from "./version.js";

export interface CiReportOptions {
  /** The `wasit run --json --out` file. */
  readonly report: string;
  /** The baseline file of the default branch: absent or unusable, the comment says so. */
  readonly baseline?: string;
  /** Where the pull request comment goes. */
  readonly comment: string;
  /** The job summary file, appended to. Default: `$GITHUB_STEP_SUMMARY`, if set. */
  readonly summary?: string;
  /** Where the next baseline goes: the report with its history. The caller uploads it on a push to the default branch. */
  readonly baselineOut?: string;
}

export interface CiReportContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

function readFileText(path: string, max: number): string {
  if (statSync(path).size > max) throw Object.assign(new Error("too large"), { code: "E2BIG" });
  return readFileSync(path, "utf-8");
}

function readBaselineFile(path: string): BaselineResult {
  try {
    return readBaseline(readFileText(path, MAX_BASELINE_BYTES));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: `the baseline file cannot be read${typeof code === "string" ? ` (${code})` : ""}` };
  }
}

export async function executeCiReport(options: CiReportOptions, context: CiReportContext): Promise<number> {
  const secrets = deniedEnvValues(context.env);
  const fail = (message: string): number => {
    context.stderr(sanitizeText(message, { redact: secrets }));
    return 2;
  };

  /** The run left nothing to render: say so in the comment and the summary, and write no baseline. */
  const writeNoReport = (message: string, code: 0 | 2): number => {
    context.stderr(sanitizeText(message, { redact: secrets }));
    try {
      const versions = readToolVersions(CLI_VERSION, readBuildCommit(context.env));
      writeFileSync(options.comment, renderNoReportComment(versions));
      context.stdout(`Wrote ${options.comment}`);
      const summary = options.summary ?? context.env["GITHUB_STEP_SUMMARY"];
      if (summary !== undefined && summary !== "") {
        appendFileSync(summary, renderNoReportSummary(versions));
        context.stdout(`Appended the summary to ${summary}`);
      }
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      return fail(`wasit ci-report: cannot write a file${typeof errno === "string" ? ` (${errno})` : ""}`);
    }
    return code;
  };

  let report: RunReport;
  try {
    report = parseRunReport(JSON.parse(readFileText(options.report, MAX_BASELINE_BYTES)));
  } catch (error) {
    // Nothing from the file is quoted: it is data, and it may be broken or hostile.
    if (error instanceof ReportFormatError) return writeNoReport("wasit ci-report: the report is not a Wasit report", 2);
    if (error instanceof SyntaxError) return writeNoReport("wasit ci-report: the report is not valid JSON", 2);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return writeNoReport("wasit ci-report: wasit run wrote no report, so the comment says no verdict (the reason is in the log of the run step)", 0);
    }
    return writeNoReport(`wasit ci-report: cannot read the report${typeof code === "string" ? ` (${code})` : ""}`, 2);
  }

  const selected = selectBaseline(report, options.baseline === undefined ? undefined : readBaselineFile(options.baseline));
  const input = {
    report,
    ...(selected.baseline === undefined ? {} : { baseline: selected.baseline }),
    ...(selected.note === undefined ? {} : { baselineNote: selected.note }),
    secrets,
  };

  try {
    writeFileSync(options.comment, renderComment(input));
    context.stdout(`Wrote ${options.comment}`);

    const summary = options.summary ?? context.env["GITHUB_STEP_SUMMARY"];
    if (summary !== undefined && summary !== "") {
      appendFileSync(summary, `${renderSummary(input)}\n`);
      context.stdout(`Appended the summary to ${summary}`);
    }

    if (options.baselineOut !== undefined) {
      writeFileSync(options.baselineOut, serializeBaseline(report, updateHistory(selected.baseline?.history, report)));
      context.stdout(`Wrote ${options.baselineOut}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return fail(`wasit ci-report: cannot write a file${typeof code === "string" ? ` (${code})` : ""}`);
  }
  return 0;
}
