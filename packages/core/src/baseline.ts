/**
 * The baseline: the run report of the default branch, and the history carried
 * with it (spec A5).
 *
 * A baseline comes out of an artifact, so it is data, never trusted: it is read
 * through the same validator as the report of the current run, every string in
 * it goes through the sanitiser, the totals and group counts are recomputed
 * instead of believed, and anything that does not validate is ignored with a
 * reason. A forged or damaged baseline can only change what a comment says
 * changed, and it cannot make a check pass (A-A05 picks the run it came from).
 *
 * The history is one letter per run and check, oldest first, the last 20 runs:
 * P pass, F fail, E error, S skip.
 */

import type { ProtocolId } from "./catalogue.js";
import { PROTOCOL_IDS } from "./catalogue.js";
import { SKIP_KINDS, type CheckStatus, type SkipKind, type StructuredCheckResult } from "./check.js";
import type { NetworkClass } from "./guard/networks.js";
import {
  groupCounts,
  reportTotals,
  type EndpointOutcome,
  type EndpointReport,
  type RunReport,
} from "./report.js";
import { sanitizeText } from "./sanitize.js";
import { isShortCommit } from "./versions.js";

/** How many runs of the default branch the history keeps. */
export const HISTORY_LIMIT = 20;

/** The largest baseline file read. A report of 50 endpoints with their results is far below this. */
export const MAX_BASELINE_BYTES = 2 * 1024 * 1024;

const MAX_ENDPOINTS = 100;
const MAX_RESULTS = 100;
const MAX_NOTES = 50;
const MAX_DETAIL = 4000;

/** A report that is not one Wasit wrote. The message names a path, never a value from the file. */
export class ReportFormatError extends Error {
  public constructor(path: string, message: string) {
    super(`Not a Wasit run report: ${path === "" ? "the file" : path} ${message}`);
    this.name = "ReportFormatError";
  }
}

const OUTCOMES: readonly EndpointOutcome[] = ["conformant", "non-conformant", "no-verdict", "unsupported"];
const STATUSES: readonly CheckStatus[] = ["PASS", "FAIL", "ERROR", "SKIP"];
const NETWORK_CLASS_VALUES: readonly NetworkClass[] = ["test", "mainnet-optin", "unknown"];
const ERROR_KINDS: readonly string[] = ["unreachable", "configuration", "harness", "setup"];
const CHECK_ID = /^[A-Za-z0-9_-]{1,40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(parent: string, key: string | number): string {
  return typeof key === "number" ? `${parent}[${key}]` : parent === "" ? key : `${parent}.${key}`;
}

/** A string, sanitised and cut to `max`. */
function text(value: unknown, path: string, max: number): string {
  if (typeof value !== "string") throw new ReportFormatError(path, "must be a string");
  return sanitizeText(value).slice(0, max);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ReportFormatError(path, "is not one of the values a report uses");
  }
  return value as T;
}

function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new ReportFormatError(path, "must be a list");
  if (value.length > max) throw new ReportFormatError(path, `has more than ${max} entries`);
  return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ReportFormatError(path, "must be an object");
  return value;
}

function readResult(raw: unknown, path: string): StructuredCheckResult {
  const entry = record(raw, path);
  const id = text(entry["id"], at(path, "id"), 40);
  if (!CHECK_ID.test(id)) throw new ReportFormatError(at(path, "id"), "is not a check id");
  const status = oneOf(entry["status"], STATUSES, at(path, "status"));
  if (typeof entry["destructive"] !== "boolean") throw new ReportFormatError(at(path, "destructive"), "must be true or false");
  return {
    id,
    name: text(entry["name"], at(path, "name"), 200),
    status,
    detail: text(entry["detail"], at(path, "detail"), MAX_DETAIL),
    destructive: entry["destructive"],
    ...(entry["errorKind"] === undefined ? {} : { errorKind: oneOf(entry["errorKind"], ERROR_KINDS, at(path, "errorKind")) }),
    ...(entry["skipKind"] === undefined ? {} : { skipKind: oneOf<SkipKind>(entry["skipKind"], SKIP_KINDS, at(path, "skipKind")) }),
    ...(entry["expected"] === undefined ? {} : { expected: text(entry["expected"], at(path, "expected"), 500) }),
    ...(entry["actual"] === undefined ? {} : { actual: text(entry["actual"], at(path, "actual"), 500) }),
    // Wasit writes a reference only on a PASS that read its settlement back (`toStructuredRun`); a file that
    // carries one on another status is not taken at its word.
    ...(entry["reference"] === undefined || status !== "PASS" ? {} : { reference: text(entry["reference"], at(path, "reference"), 120) }),
    ...(entry["fix"] === undefined ? {} : { fix: text(entry["fix"], at(path, "fix"), 2000) }),
    ...(entry["docs"] === undefined ? {} : { docs: text(entry["docs"], at(path, "docs"), 300) }),
  };
}

function readEndpoint(raw: unknown, path: string): EndpointReport {
  const entry = record(raw, path);
  const protocol = oneOf<ProtocolId>(entry["protocol"], PROTOCOL_IDS, at(path, "protocol"));
  const results = list(entry["results"], at(path, "results"), MAX_RESULTS).map((item, index) =>
    readResult(item, at(at(path, "results"), index)),
  );
  const name = text(entry["name"], at(path, "name"), 200);
  if (name === "") throw new ReportFormatError(at(path, "name"), "must not be empty");
  return {
    name,
    protocol,
    method: text(entry["method"], at(path, "method"), 16),
    path: text(entry["path"], at(path, "path"), 2048),
    outcome: oneOf(entry["outcome"], OUTCOMES, at(path, "outcome")),
    ...(entry["reason"] === undefined ? {} : { reason: text(entry["reason"], at(path, "reason"), 1000) }),
    // Recomputed from the results: a count in the file is not believed.
    groups: groupCounts(results, protocol),
    results,
  };
}

/**
 * Validates a run report read from a file or an artifact and returns a clean
 * copy: only the keys a report has, every string sanitised and cut, the totals
 * and group counts recomputed.
 *
 * @throws {ReportFormatError} For anything else, naming the path and no value.
 */
export function parseRunReport(value: unknown): RunReport {
  const root = record(value, "");
  if (root["schema"] !== 1) throw new ReportFormatError("schema", "must be 1");

  const wasit = record(root["wasit"], "wasit");
  const sdk = record(root["sdk"], "sdk");
  const build = wasit["build"];
  if (build !== undefined && !isShortCommit(build)) {
    throw new ReportFormatError("wasit.build", "must be seven lower-case hex characters");
  }
  if (sdk["x402Version"] !== 2) throw new ReportFormatError("sdk.x402Version", "must be 2");

  const endpoints = list(root["endpoints"], "endpoints", MAX_ENDPOINTS).map((item, index) =>
    readEndpoint(item, `endpoints[${index}]`),
  );
  const seen = new Set<string>();
  for (const endpoint of endpoints) {
    if (seen.has(endpoint.name)) throw new ReportFormatError("endpoints", "has two endpoints with the same name");
    seen.add(endpoint.name);
  }

  const notes = root["notes"] === undefined ? [] : list(root["notes"], "notes", MAX_NOTES);

  return {
    schema: 1,
    wasit: {
      cli: text(wasit["cli"], "wasit.cli", 40),
      core: text(wasit["core"], "wasit.core", 40),
      ...(build === undefined ? {} : { build }),
    },
    sdk: {
      x402Version: 2,
      "@x402/core": text(sdk["@x402/core"], "sdk.@x402/core", 40),
      "@x402/stellar": text(sdk["@x402/stellar"], "sdk.@x402/stellar", 40),
      "@stellar/mpp": text(sdk["@stellar/mpp"], "sdk.@stellar/mpp", 40),
      mppx: text(sdk["mppx"], "sdk.mppx", 40),
      "@stellar/stellar-sdk": text(sdk["@stellar/stellar-sdk"], "sdk.@stellar/stellar-sdk", 40),
    },
    environment: text(root["environment"], "environment", 200),
    network: text(root["network"], "network", 200),
    networkClass: oneOf(root["networkClass"], NETWORK_CLASS_VALUES, "networkClass"),
    startedAt: text(root["startedAt"], "startedAt", 40),
    endpoints,
    totals: reportTotals(endpoints),
    notes: notes.map((note, index) => text(note, `notes[${index}]`, 1000)),
  };
}

// ---------------------------------------------------------------------------
// History

/** Endpoint name, then check id, to the letters of the last runs. */
export type History = Readonly<Record<string, Readonly<Record<string, string>>>>;

const LETTER: Readonly<Record<CheckStatus, string>> = { PASS: "P", FAIL: "F", ERROR: "E", SKIP: "S" };
/** When one report lists a check id twice, the worse status is the one kept. */
const SEVERITY = "SPEF";

function readHistory(value: unknown): History {
  const root = record(value, "history");
  const entries = Object.entries(root);
  if (entries.length > MAX_ENDPOINTS) throw new ReportFormatError("history", `has more than ${MAX_ENDPOINTS} endpoints`);
  return Object.fromEntries(
    entries.map(([endpoint, checks]) => {
      const path = at("history", sanitizeText(endpoint).slice(0, 80));
      const inner = Object.entries(record(checks, path));
      if (inner.length > MAX_RESULTS) throw new ReportFormatError(path, `has more than ${MAX_RESULTS} checks`);
      return [
        sanitizeText(endpoint).slice(0, 200),
        Object.fromEntries(
          inner.map(([id, letters]) => {
            if (typeof letters !== "string" || !new RegExp(`^[PFES]{1,${HISTORY_LIMIT}}$`).test(letters)) {
              throw new ReportFormatError(at(path, sanitizeText(id).slice(0, 40)), "is not a run history");
            }
            return [sanitizeText(id).slice(0, 40), letters];
          }),
        ),
      ];
    }),
  );
}

/**
 * The history after `report`: the previous history with this run's letter added
 * to every check in the report, the last {@link HISTORY_LIMIT} kept. An endpoint
 * or a check that is not in the report is dropped; a new one starts here.
 */
export function updateHistory(previous: History | undefined, report: RunReport): History {
  return Object.fromEntries(
    report.endpoints.map((endpoint) => {
      const worst = new Map<string, string>();
      for (const result of endpoint.results) {
        const letter = LETTER[result.status];
        const kept = worst.get(result.id);
        if (kept === undefined || SEVERITY.indexOf(letter) > SEVERITY.indexOf(kept)) worst.set(result.id, letter);
      }
      const before = previous !== undefined && Object.hasOwn(previous, endpoint.name) ? previous[endpoint.name]! : {};
      return [
        endpoint.name,
        Object.fromEntries(
          [...worst].map(([id, letter]) => {
            const earlier = Object.hasOwn(before, id) ? before[id]! : "";
            return [id, `${earlier}${letter}`.slice(-HISTORY_LIMIT)];
          }),
        ),
      ];
    }),
  );
}

export interface RecentFailure {
  readonly endpoint: string;
  readonly check: string;
  /** Runs in which the check failed. */
  readonly failed: number;
  /** Runs the history holds for it. */
  readonly runs: number;
}

/** The checks that failed in at least one run of the history, most failures first. */
export function recentFailures(history: History): RecentFailure[] {
  const failures: RecentFailure[] = [];
  for (const [endpoint, checks] of Object.entries(history)) {
    for (const [check, letters] of Object.entries(checks)) {
      const failed = [...letters].filter((letter) => letter === "F").length;
      if (failed > 0) failures.push({ endpoint, check, failed, runs: letters.length });
    }
  }
  return failures.sort((a, b) => b.failed - a.failed);
}

// ---------------------------------------------------------------------------
// Reading and writing a baseline file

export interface Baseline {
  readonly report: RunReport;
  readonly history: History;
}

export type BaselineResult =
  | { readonly ok: true; readonly baseline: Baseline }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads a baseline file. Never throws: a file that is too large, is not JSON, is
 * not a report, or carries a history that does not validate is ignored, and the
 * reason says which. A file with a report and no history starts the history from
 * that report.
 */
export function readBaseline(fileText: string): BaselineResult {
  if (Buffer.byteLength(fileText, "utf-8") > MAX_BASELINE_BYTES) {
    return { ok: false, reason: `the baseline is larger than ${MAX_BASELINE_BYTES / 1024} KiB` };
  }
  let value: unknown;
  try {
    value = JSON.parse(fileText);
  } catch {
    return { ok: false, reason: "the baseline is not valid JSON" };
  }
  try {
    const report = parseRunReport(value);
    const raw = (value as Record<string, unknown>)["history"];
    return { ok: true, baseline: { report, history: raw === undefined ? updateHistory(undefined, report) : readHistory(raw) } };
  } catch (error) {
    if (error instanceof ReportFormatError) return { ok: false, reason: error.message };
    throw error;
  }
}

/** The text of a baseline file: the report with its history. */
export function serializeBaseline(report: RunReport, history: History): string {
  return `${JSON.stringify({ ...report, history }, null, 2)}\n`;
}

/**
 * Why a valid baseline cannot be compared with this run, if it cannot. A
 * baseline from another environment is another service: comparing them would
 * show regressions that are not.
 */
export function baselineProblem(report: RunReport, baseline: RunReport): string | undefined {
  if (baseline.environment !== report.environment) {
    return `the baseline is from environment ${baseline.environment} and this run is ${report.environment}, so the two are not compared`;
  }
  return undefined;
}

/**
 * The baseline a run may be compared with, and the reason when there is none.
 *
 * `read` is what {@link readBaseline} gave for the file, or undefined when no
 * baseline was looked for. The result carries a baseline only if it validated
 * and is from the same environment; otherwise it carries the reason, which the
 * comment shows and the run notes.
 */
export function selectBaseline(
  report: RunReport,
  read: BaselineResult | undefined,
): { readonly baseline?: Baseline; readonly note?: string } {
  if (read === undefined) return {};
  if (!read.ok) return { note: read.reason };
  const problem = baselineProblem(report, read.baseline.report);
  return problem === undefined ? { baseline: read.baseline } : { note: problem };
}

// ---------------------------------------------------------------------------
// Diff

export type ChangeKind =
  | "new-failure"
  | "fixed"
  | "regression"
  | "graded"
  | "new-endpoint"
  | "removed-endpoint"
  | "status-changed";

export interface Change {
  readonly kind: ChangeKind;
  readonly endpoint: string;
  readonly check?: string;
  readonly from?: string;
  readonly to?: string;
}

const GRADED: readonly EndpointOutcome[] = ["conformant", "non-conformant"];

function statuses(endpoint: EndpointReport): Map<string, CheckStatus> {
  const map = new Map<string, CheckStatus>();
  for (const result of endpoint.results) {
    // A FAIL is never hidden by a second entry for the same id.
    if (map.get(result.id) !== "FAIL") map.set(result.id, result.status);
  }
  return map;
}

/** The checks of an endpoint that its run skipped because of the tier: read-only, or no payer key. */
function notRunByTier(endpoint: EndpointReport): Set<string> {
  return new Set(
    endpoint.results
      .filter((result) => result.status === "SKIP" && (result.skipKind === "read-only" || result.skipKind === "needs-payer"))
      .map((result) => result.id),
  );
}

/**
 * What changed against the baseline, by endpoint name: new and removed
 * endpoints, an endpoint that is no longer graded (a regression) or is now, and
 * per check a new FAIL, a FAIL that passes, and any other status that differs.
 * A check that is in only one of the two reports is not a change.
 */
export function diffReports(report: RunReport, baseline: RunReport): Change[] {
  const changes: Change[] = [];
  const before = new Map(baseline.endpoints.map((endpoint) => [endpoint.name, endpoint]));
  const now = new Set(report.endpoints.map((endpoint) => endpoint.name));

  for (const endpoint of report.endpoints) {
    const earlier = before.get(endpoint.name);
    if (earlier === undefined) {
      changes.push({ kind: "new-endpoint", endpoint: endpoint.name });
      continue;
    }
    const wasGraded = GRADED.includes(earlier.outcome);
    const isGraded = GRADED.includes(endpoint.outcome);
    if (wasGraded && !isGraded) {
      changes.push({ kind: "regression", endpoint: endpoint.name, from: earlier.outcome, to: endpoint.outcome });
    } else if (!wasGraded && isGraded) {
      changes.push({ kind: "graded", endpoint: endpoint.name, from: earlier.outcome, to: endpoint.outcome });
    }

    const was = statuses(earlier);
    const notRunBefore = notRunByTier(earlier);
    const notRunNow = notRunByTier(endpoint);
    for (const [check, status] of statuses(endpoint)) {
      const from = was.get(check);
      if (from === undefined || from === status) continue;
      // A check one of the two runs did not run because of its tier (a pull request
      // runs the read-only checks, main may pay, D-022a) says nothing about the service.
      if (notRunBefore.has(check) || notRunNow.has(check)) continue;
      const kind: ChangeKind = status === "FAIL" ? "new-failure" : from === "FAIL" && status === "PASS" ? "fixed" : "status-changed";
      changes.push({ kind, endpoint: endpoint.name, check, from, to: status });
    }
  }

  for (const endpoint of baseline.endpoints) {
    if (!now.has(endpoint.name)) changes.push({ kind: "removed-endpoint", endpoint: endpoint.name });
  }
  return changes;
}

/** A service that was graded on the default branch and is not graded now (spec A8 #3, D-021). */
export interface Regression {
  readonly endpoint: string;
  readonly was: "conformant" | "non-conformant";
  readonly now: "unsupported" | "no-verdict";
}

export function findRegressions(report: RunReport, baseline: RunReport): Regression[] {
  return diffReports(report, baseline)
    .filter((change) => change.kind === "regression")
    .map((change) => ({
      endpoint: change.endpoint,
      was: change.from as Regression["was"],
      now: change.to as Regression["now"],
    }));
}
