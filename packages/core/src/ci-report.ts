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
import type { CheckStatus, SkipKind } from "./check.js";
import {
  checkGroup,
  describeTotals,
  type CheckGroup,
  type EndpointOutcome,
  type EndpointReport,
  type RunReport,
} from "./report.js";
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

/** A check's status at a glance (Najmi, 2026-11-20): emoji are safe in a comment, which is HTML. */
const STATUS_MARK: Readonly<Record<CheckStatus, string>> = { PASS: "✅", FAIL: "❌", SKIP: "⚪", ERROR: "⚠️" };
const OUTCOME_MARK: Readonly<Record<EndpointOutcome, string>> = {
  conformant: "✅",
  "non-conformant": "❌",
  "no-verdict": "⚠️",
  unsupported: "⚪",
};
/** The run's verdict words, as the headline says them. */
type VerdictWord = "conformant" | "non-conformant" | "regression" | "nothing graded" | "no verdict";
const VERDICT_MARK: Readonly<Record<VerdictWord, string>> = {
  conformant: "✅",
  "non-conformant": "❌",
  regression: "❌",
  "nothing graded": "⚪",
  "no verdict": "⚠️",
};
/** Endpoints shown with a table of their checks; a config with more points at the report file for the rest. */
const MAX_ENDPOINT_SECTIONS = 10;
/** A Stellar transaction hash: the only reference a payment proof links, and only on the test network. */
const STELLAR_TX = /^[0-9a-f]{64}$/;
/** A run's page, as `GITHUB_SERVER_URL/GITHUB_REPOSITORY/actions/runs/GITHUB_RUN_ID` gives it. */
const RUN_URL = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]{1,20}$/;
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

/** The baseline the run is compared with (one of another environment is not), and the run's verdict. */
function verdictOf(input: CiReportInput): {
  readonly baseline: Baseline | undefined;
  readonly note: string | undefined;
  readonly code: number;
  readonly word: VerdictWord;
} {
  const { report } = input;
  // A baseline from another environment is another service: it is not compared.
  const problem = input.baseline === undefined ? undefined : baselineProblem(report, input.baseline.report);
  const baseline = problem === undefined ? input.baseline : undefined;
  const note = problem ?? input.baselineNote;

  const verdict = runExitCode(report, baseline?.report);
  const couldNotRun = report.endpoints.some((endpoint) => endpoint.results.some((result) => result.status === "ERROR"));
  const word: VerdictWord =
    verdict.code === 0
      ? "conformant"
      : verdict.code === 1
        ? report.totals.nonConformant > 0
          ? "non-conformant"
          : "regression"
        : report.totals.graded === 0 && !couldNotRun
          ? "nothing graded"
          : "no verdict";
  return { baseline, note, code: verdict.code, word };
}

/** The check whose settlement a protocol's payment proof links: the one that pays once and is read back from the chain. */
const PROOF_CHECK: Readonly<Partial<Record<EndpointReport["protocol"], string>>> = {
  x402: "X402-06",
  "mpp-charge": "MPP-01",
};

/**
 * The payment proof under an endpoint: a link to the transaction of X402-06
 * (x402) or MPP-01 (MPP charge) on Stellar Expert, and only when every part is
 * Wasit's own and checked: the run is on `stellar:testnet`, that check passed,
 * and its reference (read back from the chain by the check) is a 64-character
 * lower-case hex hash. Never a link built from a service's text.
 */
function paymentProof(endpoint: EndpointReport, network: string): string | undefined {
  if (network !== "stellar:testnet") return undefined;
  const check = PROOF_CHECK[endpoint.protocol];
  if (check === undefined) return undefined;
  const honest = endpoint.results.find((result) => result.id === check && result.status === "PASS");
  const reference = honest?.reference;
  if (reference === undefined || !STELLAR_TX.test(reference)) return undefined;
  return (
    `**Payment proof**: ${check} settled on stellar:testnet, ` +
    `[tx ${reference.slice(0, 4)}…${reference.slice(-4)} on Stellar Expert](https://stellar.expert/explorer/testnet/tx/${reference}).`
  );
}

/** An endpoint's heading and the table of its checks, each with its mark, then its payment proof. */
function endpointSection(endpoint: EndpointReport, network: string, md: (value: string) => string): string[] {
  const out = [
    "",
    `### ${OUTCOME_MARK[endpoint.outcome]} ${md(endpoint.name)} · ${endpoint.protocol} · ${endpoint.outcome}`,
    "",
    "|   | Check | Result |",
    "| --- | --- | --- |",
    ...endpoint.results.map((result) => `| ${STATUS_MARK[result.status]} | ${md(result.id)} ${md(result.name)} | ${result.status} |`),
  ];
  const proof = paymentProof(endpoint, network);
  if (proof !== undefined) out.push("", proof);
  return out;
}

/** Every check's detail, folded away at the end, so a long report cuts here and not in the verdict. */
function detailsBlock(report: RunReport, md: (value: string) => string): string[] {
  const out = ["", "<details><summary>Details of each check</summary>", ""];
  for (const endpoint of report.endpoints.slice(0, MAX_ENDPOINT_SECTIONS)) {
    out.push(`**${md(endpoint.name)}**`, "");
    let lastSkip: string | undefined;
    for (const result of endpoint.results) {
      // A skip with the reason of the skip just above it says so instead of repeating it.
      const repeated = result.status === "SKIP" && lastSkip === result.detail;
      lastSkip = result.status === "SKIP" ? result.detail : undefined;
      const detail = repeated ? "the same reason as above." : md(result.detail);
      out.push(`- ${STATUS_MARK[result.status]} ${md(result.id)} ${md(result.name)}: ${detail}`);
    }
    out.push("");
  }
  out.push("</details>");
  return out;
}

function renderBody(input: CiReportInput): string {
  const { report } = input;
  const md = (value: string): string => sanitizeForMarkdown(value, { redact: input.secrets ?? [] });
  const { baseline, note, word } = verdictOf(input);

  const sdk = report.sdk;
  const out: string[] = [
    `**Wasit: ${VERDICT_MARK[word]} ${word}.** ${describeTotals(report.totals)} on ${md(report.environment)}, ${md(report.network)}. ` +
      `${wasitText(report.wasit)}, x402 v2, ` +
      `@x402/core ${version(sdk["@x402/core"])}, @x402/stellar ${version(sdk["@x402/stellar"])}, ` +
      `@stellar/mpp ${version(sdk["@stellar/mpp"])}, mppx ${version(sdk.mppx)}, ` +
      `@stellar/stellar-sdk ${version(sdk["@stellar/stellar-sdk"])}.`,
    "",
    "| Endpoint | Protocol | Outcome | Checks |",
    "| --- | --- | --- | --- |",
    ...report.endpoints.map(
      (endpoint) =>
        `| ${md(endpoint.name)} | ${endpoint.protocol} | ${OUTCOME_MARK[endpoint.outcome]} ${endpoint.outcome} | ${checksCell(endpoint)} |`,
    ),
  ];

  for (const endpoint of report.endpoints.slice(0, MAX_ENDPOINT_SECTIONS)) out.push(...endpointSection(endpoint, report.network, md));
  if (report.endpoints.length > MAX_ENDPOINT_SECTIONS) {
    const rest = report.endpoints.length - MAX_ENDPOINT_SECTIONS;
    out.push(
      "",
      `${rest} more endpoint${rest === 1 ? " is" : "s are"} not shown check by check here; ` +
        "the JSON report of wasit run has every check (in the Action, the log of the step Run Wasit).",
    );
  }

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

  out.push(...detailsBlock(report, md));
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
  return `${text.slice(0, cut > 0 ? cut : MAX_COMMENT_CHARACTERS - 200)}\n\n(The rest is cut: the JSON report of wasit run has all of it; in the Action, the log of the step Run Wasit.)`;
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
    "**Wasit: ⚠️ no verdict.** The run ended before it wrote a report, so nothing was graded. " +
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

/** What a GitHub check run shows: its title, its summary and how it ended. */
export interface CheckRunOutput {
  /** At most 255 characters: the verdict and the counts, nothing a service chose. */
  readonly title: string;
  /** The job summary's text: the same sanitised report. */
  readonly summary: string;
  readonly conclusion: "success" | "failure" | "neutral";
}

/** The check run's limits, as GitHub sets them. */
const MAX_CHECK_TITLE = 255;
const MAX_CHECK_SUMMARY = 65_535;

/** "10 passed, 1 failed, 1 could not run, 1 skipped", over every endpoint. */
function statusCounts(report: RunReport): string {
  const all = report.endpoints.flatMap((endpoint) => endpoint.results);
  const count = (status: CheckStatus): number => all.filter((result) => result.status === status).length;
  const parts = [`${count("PASS")} passed`];
  if (count("FAIL") > 0) parts.push(`${count("FAIL")} failed`);
  if (count("ERROR") > 0) parts.push(`${count("ERROR")} could not run`);
  if (count("SKIP") > 0) parts.push(`${count("SKIP")} skipped`);
  return parts.join(", ");
}

/**
 * The check run "Wasit conformance" at the end of a run: success for a run that
 * exits 0, failure for 1, neutral for no verdict. The title holds only the
 * verdict word and counts; the summary is the job summary.
 */
export function renderCheckRun(input: CiReportInput): CheckRunOutput {
  const { code, word } = verdictOf(input);
  return {
    title: `${VERDICT_MARK[word]} ${word} · ${statusCounts(input.report)}`.slice(0, MAX_CHECK_TITLE),
    summary: renderSummary(input).slice(0, MAX_CHECK_SUMMARY),
    conclusion: code === 0 ? "success" : code === 1 ? "failure" : "neutral",
  };
}

/** The check run for a run that left no report: neutral, with the fixed text of the no-report comment. */
export function renderNoReportCheckRun(versions: ToolVersions): CheckRunOutput {
  return {
    title: "⚠️ no verdict · the run ended before it wrote a report",
    summary: renderNoReportSummary(versions).slice(0, MAX_CHECK_SUMMARY),
    conclusion: "neutral",
  };
}

export interface RunningCommentInput {
  /** When the run started, as an ISO time; anything else is left out. */
  readonly startedAt: string;
  /** The run's page; left out unless it has the shape GitHub gives it. */
  readonly runUrl?: string;
  /** The environment the run tests, when the workflow names one. */
  readonly environment?: string;
  /** Values no output may carry. */
  readonly secrets?: readonly string[];
}

/**
 * The pull request comment while Wasit runs (Najmi, 2026-11-20): the marker,
 * then a fixed line with the start time and a link to the run. The result
 * replaces it when the run ends. The only value from outside is the
 * environment's name, which goes through the sanitiser; the link is used only
 * when it has the shape of a GitHub run page.
 */
export function renderRunningComment(input: RunningCommentInput): string {
  const md = (value: string): string => sanitizeForMarkdown(value, { redact: input.secrets ?? [] });
  const when = utcMinute(input.startedAt);
  const environment = input.environment !== undefined && input.environment.trim() !== "" ? ` on ${md(input.environment)}` : "";
  const started = when === undefined ? "" : ` · started ${when}`;
  const link = input.runUrl !== undefined && RUN_URL.test(input.runUrl) ? ` · [follow the run](${input.runUrl})` : "";
  return `${COMMENT_MARKER}\n⏳ **Wasit is running**${environment}${started}${link}\n\nThe result replaces this comment when the run ends.\n`;
}
