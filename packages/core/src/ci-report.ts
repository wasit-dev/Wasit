/**
 * The pull request comment and the job summary (spec A4, A5), as pure
 * functions over the run report and, when there is one, the baseline of the
 * default branch.
 *
 * Every value that can carry text a service chose goes through
 * `sanitizeForMarkdown`: one line, links and mentions removed, 300 characters at
 * most, Markdown and HTML escaped. What is not passed through it is a constant
 * of this file, a number, or a value checked against a fixed set (an outcome, a
 * status, a protocol, a version, a docs link on usewasit.dev).
 */

import {
  baselineProblem,
  diffReports,
  recentFailures,
  type Baseline,
  type Change,
  type ChangeKind,
  type History,
} from "./baseline.js";
import type { SkipKind } from "./check.js";
import { checkGroup, describeTotals, type CheckGroup, type EndpointReport, type RunReport } from "./report.js";
import { sanitizeForMarkdown } from "./sanitize.js";
import { isShortCommit, type ToolVersions } from "./versions.js";
import { runExitCode } from "./verdict.js";

/** The comment that starts with this is the one Wasit updates. */
export const COMMENT_MARKER = "<!-- wasit-report -->";

/** GitHub refuses a comment over 65,536 characters; stay well under. */
const MAX_COMMENT_CHARACTERS = 60_000;
const MAX_FAILURES_SHOWN = 20;
const MAX_CHANGES_SHOWN = 30;
const MAX_RECENT_SHOWN = 10;

export interface CiReportInput {
  readonly report: RunReport;
  /** The baseline of the default branch, when one was found and could be read. */
  readonly baseline?: Baseline;
  /** Why no baseline could be used, when one was looked for: shown in place of "no baseline yet". */
  readonly baselineNote?: string;
  /** The id of the run on main the baseline came from: the last green one (D-022b). */
  readonly baselineRun?: number;
  /**
   * The history of every completed run on main, failed ones included (D-022b),
   * for the recent-failures line. Absent: the baseline's own history.
   */
  readonly history?: History;
  /** Values no output may carry (a header value, a key, an RPC url). */
  readonly secrets?: readonly string[];
}

/** Docs links go in only if they point at the site: the file they come from is data. */
const DOCS_LINK = /^https:\/\/usewasit\.dev\/[A-Za-z0-9/_.-]*$/;
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;

const GROUP_LABEL: Readonly<Record<CheckGroup, string>> = {
  challenge: "challenge",
  payment: "payment",
  mppCharge: "MPP charge",
  mppChannel: "MPP channel",
};
const GROUP_ORDER: readonly CheckGroup[] = ["challenge", "payment", "mppCharge", "mppChannel"];

const SKIP_KIND_TEXT: Readonly<Record<SkipKind, string>> = {
  "read-only": "read-only tier",
  "needs-payer": "no payer key",
  unsupported: "unsupported",
  "resource-consumed": "resource consumed",
  "not-applicable": "not applicable",
  dependency: "an earlier check did not pass",
};

const CHANGE_ORDER: readonly ChangeKind[] = [
  "regression",
  "new-failure",
  "status-changed",
  "fixed",
  "graded",
  "new-endpoint",
  "removed-endpoint",
];

function version(value: string): string {
  return VERSION.test(value) ? value : "unknown";
}

/** "Wasit 0.7.0 (core 0.7.0)", and ", built from commit 0123456" when an Action build names its commit. */
function wasitText(wasit: ToolVersions["wasit"]): string {
  const build = isShortCommit(wasit.build) ? `, built from commit ${wasit.build}` : "";
  return `Wasit ${version(wasit.cli)} (core ${version(wasit.core)})${build}`;
}

/** The reason follows "unsupported." in the list, so it starts a sentence. */
function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "challenge 5/5", or "payment not run: read-only tier" when the whole group was skipped for one reason. */
function groupText(endpoint: EndpointReport, group: CheckGroup): string | undefined {
  const results = endpoint.results.filter((result) => checkGroup(result.id, endpoint.protocol) === group);
  if (results.length === 0) return undefined;
  const count = (status: string): number => results.filter((result) => result.status === status).length;
  const label = GROUP_LABEL[group];
  const skipped = count("SKIP");
  if (skipped === results.length) {
    const kinds = new Set(results.map((result) => result.skipKind));
    const [only] = [...kinds];
    return kinds.size === 1 && only !== undefined ? `${label} not run: ${SKIP_KIND_TEXT[only]}` : `${label} not run`;
  }
  const parts = [`${label} ${count("PASS")}/${results.length}`];
  if (count("FAIL") > 0) parts.push(`${count("FAIL")} failed`);
  if (count("ERROR") > 0) parts.push(`${count("ERROR")} could not run`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.join(", ");
}

function checksCell(endpoint: EndpointReport): string {
  return GROUP_ORDER.map((group) => groupText(endpoint, group)).filter((text) => text !== undefined).join("; ");
}

function renderBody(input: CiReportInput): string {
  const { report } = input;
  const md = (value: string): string => sanitizeForMarkdown(value, { redact: input.secrets ?? [] });

  // A baseline from another environment is another service: it is not compared.
  const problem = input.baseline === undefined ? undefined : baselineProblem(report, input.baseline.report);
  const baseline = problem === undefined ? input.baseline : undefined;
  const note = problem ?? input.baselineNote;

  const verdict = runExitCode(report, baseline?.report);
  const couldNotRun = report.endpoints.some((endpoint) => endpoint.results.some((result) => result.status === "ERROR"));
  const word =
    verdict.code === 0
      ? "conformant"
      : verdict.code === 1
        ? report.totals.nonConformant > 0
          ? "non-conformant"
          : "regression"
        : report.totals.graded === 0 && !couldNotRun
          ? "nothing graded"
          : "no verdict";

  const sdk = report.sdk;
  const out: string[] = [
    `**Wasit: ${word}.** ${describeTotals(report.totals)} on ${md(report.environment)}, ${md(report.network)}. ` +
      `${wasitText(report.wasit)}, x402 v2, ` +
      `@x402/core ${version(sdk["@x402/core"])}, @x402/stellar ${version(sdk["@x402/stellar"])}, ` +
      `@stellar/mpp ${version(sdk["@stellar/mpp"])}, mppx ${version(sdk.mppx)}, ` +
      `@stellar/stellar-sdk ${version(sdk["@stellar/stellar-sdk"])}.`,
    "",
    "| Endpoint | Protocol | Outcome | Checks |",
    "| --- | --- | --- | --- |",
    ...report.endpoints.map(
      (endpoint) => `| ${md(endpoint.name)} | ${endpoint.protocol} | ${endpoint.outcome} | ${checksCell(endpoint)} |`,
    ),
  ];

  const notGraded = report.endpoints.filter(
    (endpoint) => (endpoint.outcome === "unsupported" || endpoint.outcome === "no-verdict") && endpoint.reason !== undefined,
  );
  if (notGraded.length > 0) {
    out.push("", "### Not graded");
    for (const endpoint of notGraded) out.push(`- **${md(endpoint.name)}**: ${endpoint.outcome}. ${md(upperFirst(endpoint.reason ?? ""))}`);
  }

  out.push("", "### Changed since main");
  if (baseline === undefined) {
    out.push(
      note === undefined
        ? "No baseline on main yet, so nothing is compared. The next run on main creates it."
        : `The baseline from main could not be used (${md(note)}), so nothing is compared and the history starts again with the next run on main.`,
    );
  } else {
    const changes = diffReports(report, baseline.report).sort(
      (a: Change, b: Change) => CHANGE_ORDER.indexOf(a.kind) - CHANGE_ORDER.indexOf(b.kind),
    );
    out.push(comparedWith(baseline.report.startedAt, input.baselineRun));
    if (changes.length === 0) out.push("No change since main.");
    for (const change of changes.slice(0, MAX_CHANGES_SHOWN)) out.push(`- ${describeChange(change, md)}`);
    if (changes.length > MAX_CHANGES_SHOWN) out.push(`- ${changes.length - MAX_CHANGES_SHOWN} more changes not shown.`);
  }

  const failures = report.endpoints.flatMap((endpoint) =>
    endpoint.results.filter((result) => result.status === "FAIL").map((result) => ({ endpoint, result })),
  );
  if (failures.length > 0) {
    out.push("", "### Failures");
    for (const { endpoint, result } of failures.slice(0, MAX_FAILURES_SHOWN)) {
      out.push("", `**${md(endpoint.name)}: ${md(result.id)} ${md(result.name)}**`, `- Found: ${md(result.detail)}`);
      // What the check expected and what the service sent: quoted from the service, so cut and escaped like the rest.
      if (result.expected !== undefined) out.push(`- Expected: ${md(result.expected)}`);
      if (result.actual !== undefined) out.push(`- Actual: ${md(result.actual)}`);
      if (result.fix !== undefined) out.push(`- Fix: ${md(result.fix)}`);
      if (result.docs !== undefined && DOCS_LINK.test(result.docs)) out.push(`- Docs: ${result.docs}`);
    }
    if (failures.length > MAX_FAILURES_SHOWN) {
      const rest = failures.length - MAX_FAILURES_SHOWN;
      out.push("", `${rest} more failure${rest === 1 ? "" : "s"} not shown.`);
    }
  }

  const recent = baseline === undefined ? [] : recentFailures(input.history ?? baseline.history);
  if (recent.length > 0) {
    out.push("", "### Recent failures on main");
    for (const item of recent.slice(0, MAX_RECENT_SHOWN)) {
      out.push(`- ${md(item.endpoint)} ${md(item.check)}: failed in ${item.failed} of the last ${item.runs} runs on main`);
    }
  }

  if (report.notes.length > 0) {
    out.push("", "### Notes");
    for (const item of report.notes) out.push(`- ${md(item)}`);
  }

  return out.join("\n");
}

/** "2026-11-15 10:00 UTC", from the report's own start time; nothing that is not a time. */
function utcMinute(iso: string): string | undefined {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return undefined;
  return `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The line that says what "Changed since main" compares with (D-022b): the last
 * green run on main, so a FAIL that main has now is not read as this run's.
 */
function comparedWith(startedAt: string, run: number | undefined): string {
  const when = utcMinute(startedAt);
  const id = run !== undefined && Number.isSafeInteger(run) && run > 0 ? run : undefined;
  const started = when === undefined ? "" : `started ${when}`;
  const which = id !== undefined ? `: run ${id}${started === "" ? "" : `, ${started}`}` : started === "" ? "" : `, ${started}`;
  return `Compared with the last green run on main${which}. Runs on main that failed after it are counted under Recent failures on main, not here.`;
}

function describeChange(change: Change, md: (value: string) => string): string {
  const endpoint = md(change.endpoint);
  const check = md(change.check ?? "");
  switch (change.kind) {
    case "regression":
      return `Regression: ${endpoint} was ${change.from} on main and is now ${change.to}.`;
    case "new-failure":
      return `New FAIL: ${endpoint} ${check} (was ${change.from} on main).`;
    case "fixed":
      return `Fixed: ${endpoint} ${check} (was FAIL on main).`;
    case "status-changed":
      return `${endpoint} ${check}: ${change.from} on main, now ${change.to}.`;
    case "graded":
      return `Now graded: ${endpoint} (was ${change.from} on main).`;
    case "new-endpoint":
      return `New endpoint: ${endpoint}.`;
    case "removed-endpoint":
      return `Removed endpoint: ${endpoint}.`;
  }
}

/** A text over the limit is cut at a line break, and says so. */
function withinLimit(text: string): string {
  if (text.length <= MAX_COMMENT_CHARACTERS) return text;
  const cut = text.lastIndexOf("\n", MAX_COMMENT_CHARACTERS - 200);
  return `${text.slice(0, cut > 0 ? cut : MAX_COMMENT_CHARACTERS - 200)}\n\n(The rest is cut: the full report is in the job's wasit-report.json.)`;
}

/** The pull request comment: the marker, then the report. */
export function renderComment(input: CiReportInput): string {
  return withinLimit(`${COMMENT_MARKER}\n${renderBody(input)}\n`);
}

/** The job summary: the same text without the marker. */
export function renderSummary(input: CiReportInput): string {
  return withinLimit(`${renderBody(input)}\n`);
}

/**
 * What the comment says when the run left no report to render: the service did
 * not start, never answered, or the config could not be used. The comment from
 * the push before must not stay next to a red check, so this replaces it. The
 * text is fixed: nothing from the service, the config or the broken report is
 * quoted, because none of it can be trusted to be there or to be safe.
 */
function renderNoReportBody(versions: ToolVersions): string {
  const sdk = versions.sdk;
  return [
    "**Wasit: no verdict.** The run ended before it wrote a report, so nothing was graded. " +
      `${wasitText(versions.wasit)}, x402 v2, ` +
      `@x402/core ${version(sdk["@x402/core"])}, @x402/stellar ${version(sdk["@x402/stellar"])}, ` +
      `@stellar/mpp ${version(sdk["@stellar/mpp"])}, mppx ${version(sdk.mppx)}, ` +
      `@stellar/stellar-sdk ${version(sdk["@stellar/stellar-sdk"])}.`,
    "",
    "This is not a failure of the service and not a pass: the service did not start or never answered, " +
      "or the config could not be used. The reason is in the job log. This comment is replaced on the next push.",
  ].join("\n");
}

/** The pull request comment for a run that left no report: the marker, then the fixed text. */
export function renderNoReportComment(versions: ToolVersions): string {
  return `${COMMENT_MARKER}\n${renderNoReportBody(versions)}\n`;
}

/** The job summary for a run that left no report: the same text without the marker. */
export function renderNoReportSummary(versions: ToolVersions): string {
  return `${renderNoReportBody(versions)}\n`;
}
