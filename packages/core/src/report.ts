/**
 * The run report: what `wasit run` produces for the CLI's `--json`, the Action
 * and the pull request comment, one shape (spec A2).
 *
 * The central rule is the endpoint outcome. An endpoint counts as graded only
 * when it is `conformant` or `non-conformant` (spec A8 #3, D-021). A service
 * Wasit cannot grade is `unsupported`; one that gave no verdict is
 * `no-verdict`. Neither is a FAIL, and neither is a pass: the totals say how
 * many endpoints were graded, so a run where nothing was cannot be read as
 * green.
 */

import { catalogueEntry, type ProtocolId } from "./catalogue.js";
import {
  checkStatus,
  skipped,
  summarize,
  toStructuredRun,
  type CheckResult,
  type CheckStatus,
  type SkipKind,
  type StructuredCheckResult,
  type StructuredRun,
} from "./check.js";
import { networkClass, type NetworkClass } from "./guard/networks.js";
import { sanitizeText } from "./sanitize.js";
import type { ToolVersions } from "./versions.js";

export type EndpointOutcome = "conformant" | "non-conformant" | "no-verdict" | "unsupported";

/** The groups of checks a report counts: the read-only challenge checks, the payment checks, and the two MPP modes. */
export type CheckGroup = "challenge" | "payment" | "mppCharge" | "mppChannel";

export interface GroupCounts {
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  readonly skipped: number;
}

/** The group whose result decides whether an endpoint can be graded at all. */
const GATING_GROUP: Readonly<Record<ProtocolId, CheckGroup>> = {
  x402: "challenge",
  "mpp-charge": "mppCharge",
  "mpp-channel": "mppChannel",
};

/**
 * The group of a check id. X402-01..05 read the challenge, X402-06..10 pay;
 * the MPP checks follow their mode. An id with no catalogue entry (PREFLIGHT)
 * belongs to the group of the endpoint it was raised for.
 */
export function checkGroup(id: string, protocol: ProtocolId): CheckGroup {
  const entry = catalogueEntry(id);
  if (entry === undefined) return GATING_GROUP[protocol];
  if (entry.protocol === "x402") return Number(id.slice("X402-".length)) <= 5 ? "challenge" : "payment";
  return GATING_GROUP[entry.protocol];
}

/**
 * True when an x402 payment check (X402-06..10) was skipped as `unsupported`:
 * the run asked to pay and Wasit cannot pay on that network. A read-only or
 * no-payer skip is not this, and neither is a result of another protocol. An MPP
 * endpoint has no group besides its gating one, so for it this is always false.
 * Works on the results of a fresh run and on the structured results of a report.
 */
export function paymentGroupUnsupported(
  results: ReadonlyArray<{ readonly id: string; readonly skipKind?: SkipKind }>,
  protocol: ProtocolId,
): boolean {
  return protocol === "x402" && results.some((result) => result.skipKind === "unsupported" && checkGroup(result.id, protocol) === "payment");
}

/**
 * The outcome of one endpoint from its results.
 *
 * - any FAIL: `non-conformant`. A real finding outranks a missing one.
 * - else an `unsupported` skip in the endpoint's gating group (the challenge
 *   checks for x402): `unsupported`. X402-01 may have passed on an x402 v1
 *   service; one passing check does not grade a paywall Wasit cannot read. An
 *   `unsupported` payment group alone does not make the endpoint unsupported:
 *   the challenge was graded.
 * - else an `unsupported` skip in the payment group (payment checks were asked
 *   for and none could be graded on this network): `no-verdict`, so it is not
 *   green (Najmi, 2026-11-15).
 * - else any ERROR: `no-verdict`.
 * - else at least one PASS: `conformant`.
 * - else (nothing ran, or everything was skipped): `no-verdict`.
 */
export function endpointOutcome(results: readonly CheckResult[], protocol: ProtocolId): EndpointOutcome {
  const gating = GATING_GROUP[protocol];
  let passed = 0;
  let errored = 0;
  let unsupported = false;
  for (const result of results) {
    const status = checkStatus(result);
    if (status === "FAIL") return "non-conformant";
    if (status === "PASS") passed += 1;
    else if (status === "ERROR") errored += 1;
    else if (result.skipKind === "unsupported" && checkGroup(result.id, protocol) === gating) unsupported = true;
  }
  if (unsupported) return "unsupported";
  // Payment checks were asked for and none could be graded here (a typo in the network, a chain
  // with no adapter): the challenge was graded, but the run did not do what it was asked.
  // Najmi, 2026-11-15: not green, exit 2, like 0.7.0.
  if (paymentGroupUnsupported(results, protocol)) return "no-verdict";
  if (errored > 0) return "no-verdict";
  return passed > 0 ? "conformant" : "no-verdict";
}

/** The key a protocol's payment group needs, for the words of a skip reason. */
const KEY_LABEL: Readonly<Record<ProtocolId, string>> = {
  x402: "a payer key",
  "mpp-charge": "a payer key",
  "mpp-channel": "a commitment key",
};

/** The checks of a protocol that pay or sign. MPP-13 closes a channel for good and is never listed. */
const PAYMENT_CHECK_IDS: Readonly<Record<ProtocolId, readonly string[]>> = {
  x402: ["X402-06", "X402-07", "X402-08", "X402-09", "X402-10"],
  "mpp-charge": ["MPP-01"],
  "mpp-channel": ["MPP-10", "MPP-11", "MPP-12", "MPP-14"],
};

/**
 * The checks of an endpoint that pay or sign, as SKIPs the report can count and
 * name (spec A2: the report says which checks need a payer).
 *
 * `read-only`: the run was asked not to pay. `needs-payer`: the run could have
 * paid and had no key. The names come from the catalogue, so a rename there is
 * the only place to change.
 */
export function skippedPaymentChecks(protocol: ProtocolId, kind: "read-only" | "needs-payer"): CheckResult[] {
  const key = KEY_LABEL[protocol];
  const reason =
    kind === "read-only"
      ? `the read-only tier makes no payment and signs nothing; this check needs ${key} and the payment tier`
      : `this check pays or signs and no ${key.replace(/^a /, "")} was given`;
  return PAYMENT_CHECK_IDS[protocol].map((id) => skipped(id, catalogueEntry(id)?.name ?? id, reason, kind));
}

/**
 * The exit code of one endpoint's checks (spec A8 #3, D-021): 1 on any FAIL; 2
 * when the endpoint was not graded (`unsupported` or `no-verdict`) or a check
 * could not run; else 0. Used where there is one endpoint, `wasit test` and the
 * MCP x402 tool; a run of several endpoints uses {@link runExitCode}.
 */
export function exitCodeForEndpoint(results: readonly CheckResult[], protocol: ProtocolId): 0 | 1 | 2 {
  const base = summarize([...results]).exitCode;
  if (base !== 0) return base;
  const outcome = endpointOutcome(results, protocol);
  return outcome === "unsupported" || outcome === "no-verdict" ? 2 : 0;
}

/**
 * `toStructuredRun` with the outcome the exit rule gives: a service that was
 * never graded is `no-verdict`, never `conformant`, for the MCP agent as for the
 * shell. The counts are the same.
 */
export function toGradedRun(results: readonly CheckResult[], protocol: ProtocolId): StructuredRun {
  const run = toStructuredRun([...results]);
  const code = exitCodeForEndpoint(results, protocol);
  const outcome = code === 0 ? "conformant" : code === 1 ? "non-conformant" : "no-verdict";
  return { ...run, outcome };
}

export interface EndpointReport {
  readonly name: string;
  readonly protocol: ProtocolId;
  readonly method: string;
  readonly path: string;
  readonly outcome: EndpointOutcome;
  /** Why the endpoint is `unsupported` or has `no-verdict`; absent otherwise. */
  readonly reason?: string;
  /** Counts for each group that has at least one result; a group with no checks is absent. */
  readonly groups: Readonly<Partial<Record<CheckGroup, GroupCounts>>>;
  readonly results: readonly StructuredCheckResult[];
}

export interface EndpointInput {
  readonly name: string;
  readonly protocol: ProtocolId;
  readonly method: string;
  readonly path: string;
  readonly results: readonly CheckResult[];
}

function reasonFor(results: readonly CheckResult[], protocol: ProtocolId, outcome: EndpointOutcome): string | undefined {
  if (outcome === "unsupported") {
    const skip = results.find(
      (result) => result.skipKind === "unsupported" && checkGroup(result.id, protocol) === GATING_GROUP[protocol],
    );
    return skip?.skipReason === undefined ? undefined : sanitizeText(skip.skipReason);
  }
  if (outcome === "no-verdict") {
    const error = results.find((result) => checkStatus(result) === "ERROR");
    if (error !== undefined) return sanitizeText(error.error?.message ?? "a check could not run");
    const unsupportedPayment = results.find(
      (result) => result.skipKind === "unsupported" && paymentGroupUnsupported([result], protocol),
    );
    if (unsupportedPayment?.skipReason !== undefined) return sanitizeText(unsupportedPayment.skipReason);
    // Skipped only because the run was asked not to pay: say so, not "nothing ran".
    const readOnly = results.find((result) => result.skipKind === "read-only");
    if (readOnly?.skipReason !== undefined) return sanitizeText(readOnly.skipReason);
    return "no check passed: every check was skipped or none ran";
  }
  return undefined;
}

/**
 * Counts per group from any list of results that have an id and a status: the
 * CheckResults of a fresh run, or the structured results of a report read back.
 */
export function groupCounts(
  results: ReadonlyArray<{ readonly id: string; readonly status: CheckStatus }>,
  protocol: ProtocolId,
): Partial<Record<CheckGroup, GroupCounts>> {
  const counts = new Map<CheckGroup, { passed: number; failed: number; errored: number; skipped: number }>();
  for (const result of results) {
    const group = checkGroup(result.id, protocol);
    const entry = counts.get(group) ?? { passed: 0, failed: 0, errored: 0, skipped: 0 };
    if (result.status === "PASS") entry.passed += 1;
    else if (result.status === "FAIL") entry.failed += 1;
    else if (result.status === "ERROR") entry.errored += 1;
    else entry.skipped += 1;
    counts.set(group, entry);
  }
  return Object.fromEntries(counts);
}

/** Builds the report of one endpoint. Every text in it has passed through the sanitiser. */
export function buildEndpointReport(input: EndpointInput): EndpointReport {
  const outcome = endpointOutcome(input.results, input.protocol);
  const reason = reasonFor(input.results, input.protocol, outcome);

  return {
    name: sanitizeText(input.name),
    protocol: input.protocol,
    method: sanitizeText(input.method),
    path: sanitizeText(input.path),
    outcome,
    ...(reason === undefined ? {} : { reason }),
    groups: groupCounts(
      input.results.map((result) => ({ id: result.id, status: checkStatus(result) })),
      input.protocol,
    ),
    results: toStructuredRun([...input.results]).results,
  };
}

export interface RunTotals {
  readonly endpoints: number;
  /** Endpoints that are `conformant` or `non-conformant`: the ones that were tested. */
  readonly graded: number;
  readonly conformant: number;
  readonly nonConformant: number;
  readonly noVerdict: number;
  readonly unsupported: number;
}

export function reportTotals(endpoints: readonly EndpointReport[]): RunTotals {
  const count = (outcome: EndpointOutcome): number => endpoints.filter((endpoint) => endpoint.outcome === outcome).length;
  const conformant = count("conformant");
  const nonConformant = count("non-conformant");
  return {
    endpoints: endpoints.length,
    graded: conformant + nonConformant,
    conformant,
    nonConformant,
    noVerdict: count("no-verdict"),
    unsupported: count("unsupported"),
  };
}

/**
 * The summary line: "0 graded, 1 unsupported". Says how many endpoints were
 * graded first, so a run in which nothing was cannot be read as a pass.
 */
export function describeTotals(totals: RunTotals): string {
  return [
    `${totals.graded} graded${totals.nonConformant > 0 ? ` (${totals.nonConformant} non-conformant)` : ""}`,
    ...(totals.unsupported > 0 ? [`${totals.unsupported} unsupported`] : []),
    ...(totals.noVerdict > 0 ? [`${totals.noVerdict} no verdict`] : []),
  ].join(", ");
}

export interface RunReport {
  readonly schema: 1;
  readonly wasit: ToolVersions["wasit"];
  readonly sdk: ToolVersions["sdk"];
  readonly environment: string;
  readonly network: string;
  readonly networkClass: NetworkClass;
  /** ISO 8601, supplied by the caller. */
  readonly startedAt: string;
  readonly endpoints: readonly EndpointReport[];
  readonly totals: RunTotals;
  readonly notes: readonly string[];
}

export interface RunReportInput {
  readonly environment: string;
  readonly network: string;
  readonly startedAt: string;
  readonly versions: ToolVersions;
  readonly endpoints: readonly EndpointReport[];
  readonly notes?: readonly string[];
}

/** Builds the run report. Pure: the clock and the installed versions are inputs. */
export function buildRunReport(input: RunReportInput): RunReport {
  return {
    schema: 1,
    wasit: input.versions.wasit,
    sdk: input.versions.sdk,
    environment: sanitizeText(input.environment),
    network: sanitizeText(input.network),
    networkClass: networkClass(input.network),
    startedAt: input.startedAt,
    endpoints: input.endpoints,
    totals: reportTotals(input.endpoints),
    notes: (input.notes ?? []).map((note) => sanitizeText(note)),
  };
}

/** The keys whose value is a short quote of what the service sent. */
const SHORT_VALUE_KEYS: ReadonlySet<string> = new Set(["expected", "actual"]);

/** The longest `expected` or `actual` in an output. */
const SHORT_VALUE_MAX = 200;

function clipValue(text: string): string {
  const characters = Array.from(text);
  return characters.length <= SHORT_VALUE_MAX ? text : `${characters.slice(0, SHORT_VALUE_MAX - 1).join("")}…`;
}

/**
 * Applies `change` to every string in a JSON-shaped value; numbers, booleans and
 * null stay. The string under an `expected` or `actual` key is changed first and
 * cut to {@link SHORT_VALUE_MAX} after: a cut made before the secrets are removed
 * could leave the start of one in the output.
 */
function mapStrings<T>(value: T, change: (text: string) => string): T {
  if (typeof value === "string") return change(value) as T;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        typeof item === "string" && SHORT_VALUE_KEYS.has(key) ? clipValue(change(item)) : mapStrings(item, change),
      ]),
    ) as T;
  }
  return value;
}

/**
 * A copy of a JSON-shaped value with `secrets` removed from every string in it
 * (and control characters, `::` lines and Stellar keys dealt with, as
 * everywhere), and every `expected` and `actual` cut to a short length. The
 * report is built from text a service sent, and a service can echo a header it
 * was sent; this is the last pass before it is printed or written.
 */
export function redactValue<T>(value: T, secrets: readonly string[]): T {
  return mapStrings(value, (text) => sanitizeText(text, { redact: secrets }));
}

/** {@link redactValue} for a run report. */
export function redactReport(report: RunReport, secrets: readonly string[]): RunReport {
  return redactValue(report, secrets);
}
