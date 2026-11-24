/**
 * The result shape shared by every conformance check, across protocols.
 */

import { catalogueEntry, docsUrlFor } from "./catalogue.js";
import { type CheckError, classifyCheckError } from "./errors.js";
import { sanitizeText } from "./sanitize.js";

/**
 * Why a check did not run, for a reader who has to tell "Wasit cannot grade
 * this" from "you asked for less" from "an earlier check failed". The four
 * statuses stay as they are; this refines SKIP and nothing else.
 *
 * - `unsupported`: Wasit cannot grade it (an x402 v1 challenge, a network it
 *   does not pay on). Not a FAIL, and not a pass either.
 * - `resource-consumed`: the first payment used up a single-use resource.
 * - `needs-payer`: the check pays and no payer key was given.
 * - `read-only`: the run was asked not to pay.
 * - `not-applicable`: the target gives the check nothing to test.
 * - `dependency`: an earlier check failed or gave no verdict, so there is
 *   nothing for this one to inspect.
 */
export type SkipKind =
  | "unsupported"
  | "resource-consumed"
  | "needs-payer"
  | "read-only"
  | "not-applicable"
  | "dependency";

export const SKIP_KINDS: readonly SkipKind[] = [
  "unsupported",
  "resource-consumed",
  "needs-payer",
  "read-only",
  "not-applicable",
  "dependency",
];

export interface CheckResult {
  /** Stable catalogue identifier, e.g. "MPP-11". Must match docs/CHECKS.md. */
  id: string;
  name: string;
  /** False when the check ran and the target did not conform. */
  pass: boolean;
  detail: string;
  /**
   * What to change, for the specific cause this failure found. Optional:
   * a failure without one falls back to its catalogue entry's `fix` (see
   * {@link fixFor}). Meaningful only on a FAIL.
   */
  hint?: string;
  /**
   * What the check expected, and what the service sent instead, in a few words
   * each ("status 402", "status 200"). Set by the check that knows them, on a
   * FAIL, so a report can show the reason, the expected and the actual value,
   * and the fix. `detail` and `hint` say the same in prose and are unchanged.
   * Both quote the service, so both pass through the sanitiser on the way out,
   * and are cut to a short length there, after the secrets are removed.
   */
  expected?: string;
  actual?: string;
  /**
   * The settlement a check read back from the chain and found to be this
   * payment (X402-06's transaction: a Stellar or EVM transaction hash, a Solana
   * signature; MPP-01's Stellar transaction hash). Set only on a PASS whose settlement was verified on chain; a
   * report may link it to an explorer after checking its shape.
   */
  reference?: string;
  /**
   * True when the check did not run. A skipped check is neither a pass nor a
   * failure: `pass` is false so it can never be counted as conformance, and
   * reporters must render it separately rather than as a defect.
   */
  skipped?: boolean;
  /** Why the check was skipped. Required whenever `skipped` is true. */
  skipReason?: string;
  /** What kind of reason it is, when the code that skipped it knows. Meaningful only on a SKIP. */
  skipKind?: SkipKind;
  /**
   * True when running this check permanently alters the target's state.
   * Destructive checks are skipped unless the operator explicitly opts in,
   * and may only be run against a target the operator owns or is authorised
   * to test. See docs/CHECKS.md and SECURITY.md.
   */
  destructive?: boolean;
  /**
   * Set when the check produced no verdict about the target — it could not
   * connect, or the run is misconfigured, or the harness itself failed.
   * `pass` is false so an errored check can never be counted as conformance,
   * but reporters must not present it as a defect in the target.
   */
  error?: CheckError;
}

/** How a single result should be rendered and counted. */
export type CheckStatus = "PASS" | "FAIL" | "ERROR" | "SKIP";

/**
 * Classifies one result.
 *
 * Order matters: a skipped check never ran, and an errored check produced no
 * verdict, so both are decided before `pass` is consulted at all.
 */
export function checkStatus(result: CheckResult): CheckStatus {
  if (result.skipped) return "SKIP";
  if (result.error !== undefined) return "ERROR";
  return result.pass ? "PASS" : "FAIL";
}

export interface RunSummary {
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  readonly skipped: number;
  /** 0 = everything conformed, 1 = conformance failure, 2 = no verdict. */
  readonly exitCode: 0 | 1 | 2;
}

/**
 * Reduces a run to its counts and outcome.
 *
 * Lives in core rather than in a front end so the CLI's exit code and the MCP
 * server's reported outcome can never disagree about the same results.
 */
export function summarize(results: CheckResult[]): RunSummary {
  let passed = 0;
  let failed = 0;
  let errored = 0;
  let skipped = 0;

  for (const result of results) {
    switch (checkStatus(result)) {
      case "PASS":
        passed += 1;
        break;
      case "FAIL":
        failed += 1;
        break;
      case "ERROR":
        errored += 1;
        break;
      case "SKIP":
        skipped += 1;
        break;
    }
  }

  // A real finding outranks a missing one, so a run with both exits 1.
  const exitCode = failed > 0 ? 1 : errored > 0 ? 2 : 0;
  return { passed, failed, errored, skipped, exitCode };
}

/** Builds the result for a destructive check that was not opted into. */
export function skippedDestructive(
  id: string,
  name: string,
  reason: string,
): CheckResult {
  return {
    id,
    name,
    pass: false,
    skipped: true,
    destructive: true,
    skipReason: reason,
    detail: `Skipped (destructive): ${reason}`,
  };
}

/**
 * Builds the result for a check that threw.
 *
 * A malformed response becomes an ordinary failure — the target answered and
 * the answer was wrong. Everything else becomes an errored result, which is
 * reported and exit-coded separately from conformance failures.
 */
export function errored(id: string, name: string, error: unknown): CheckResult {
  const classified = classifyCheckError(error);

  if (classified.kind === "malformed-response") {
    return {
      id,
      name,
      pass: false,
      detail: `Connected, but the response did not conform: ${classified.message}`,
    };
  }

  return {
    id,
    name,
    pass: false,
    error: classified,
    detail: `Check could not run (${classified.kind}): ${classified.message}`,
  };
}

/**
 * Builds the result for a check that was not run, for a non-destructive reason.
 * `kind` says what sort of reason it is; leave it out when the code does not know.
 */
export function skipped(id: string, name: string, reason: string, kind?: SkipKind): CheckResult {
  return {
    id,
    name,
    pass: false,
    skipped: true,
    skipReason: reason,
    ...(kind === undefined ? {} : { skipKind: kind }),
    detail: `Skipped: ${reason}`,
  };
}

/**
 * A value a service sent, quoted for the `actual` of a FAIL: a string in JSON
 * quotes (control characters written out, not carried), anything else as JSON.
 *
 * Not cut here unless `max` is given. A cut made before the secrets of the run
 * are removed can leave the start of a secret in the output, so the cut is made
 * by the sinks that remove them (`redactValue`, the comment renderer).
 */
export function quoteValue(value: unknown, max?: number): string {
  const quoted = typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value));
  if (max === undefined) return quoted;
  const characters = Array.from(quoted);
  return characters.length <= max ? quoted : `${characters.slice(0, Math.max(1, max - 1)).join("")}…`;
}

/** What to do about a failure, and where it is documented. */
export interface FailureGuidance {
  readonly fix: string;
  readonly docs?: string;
}

/**
 * The guidance a front end shows under a FAIL: the result's own hint when it
 * has one, else the check's catalogue fix. Undefined for anything that is not
 * a FAIL, so a pass, a skip or a no-verdict never reads as a defect to fix.
 */
export function fixFor(result: CheckResult): FailureGuidance | undefined {
  if (checkStatus(result) !== "FAIL") return undefined;
  const fix = result.hint ?? catalogueEntry(result.id)?.fix;
  if (fix === undefined) return undefined;
  const docs = docsUrlFor(result.id);
  return docs === undefined ? { fix } : { fix, docs };
}

/** One check's result, reshaped for a machine-readable front end (CLI --json, MCP). */
export interface StructuredCheckResult {
  readonly id: string;
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly destructive: boolean;
  /**
   * Present only when `status` is "ERROR":
   * unreachable | configuration | harness | setup.
   */
  readonly errorKind?: string;
  /** Present only when `status` is "SKIP" and the reason has a kind: see {@link SkipKind}. */
  readonly skipKind?: SkipKind;
  /** Present only when `status` is "FAIL" and the check recorded it: what it expected. */
  readonly expected?: string;
  /** Present only when `status` is "FAIL" and the check recorded it: what the service sent. */
  readonly actual?: string;
  /** Present only when `status` is "PASS" and the check verified a settlement on chain: its reference. */
  readonly reference?: string;
  /** Present only when `status` is "FAIL": what to change (see {@link fixFor}). */
  readonly fix?: string;
  /** Present only when `status` is "FAIL": the check's docs page. */
  readonly docs?: string;
}

/** A full run, reshaped for a machine-readable front end (CLI --json, MCP). */
export interface StructuredRun {
  /**
   * Named rather than left as a numeric exit code: an exit code means
   * nothing outside a shell, and "no-verdict" must never be read as
   * "compliant" by whatever consumes this — a script or an agent alike.
   */
  readonly outcome: "conformant" | "non-conformant" | "no-verdict";
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  readonly skipped: number;
  readonly results: readonly StructuredCheckResult[];
}

/**
 * Reshapes a run into the one JSON shape every machine-readable front end
 * uses — the CLI's `--json` output and the MCP server's `structuredContent`
 * both call this rather than each rolling their own mapping, so the two
 * can never drift into reporting the same run two different ways.
 */
export function toStructuredRun(results: CheckResult[]): StructuredRun {
  const counts = summarize(results);
  const outcome =
    counts.exitCode === 0
      ? "conformant"
      : counts.exitCode === 1
        ? "non-conformant"
        : "no-verdict";

  return {
    outcome,
    passed: counts.passed,
    failed: counts.failed,
    errored: counts.errored,
    skipped: counts.skipped,
    results: results.map((result) => {
      const guidance = fixFor(result);
      const status = checkStatus(result);
      return {
        id: result.id,
        // Text a service chose can reach these three fields; the report is a
        // sink for the one sanitiser (spec A8 #6).
        name: sanitizeText(result.name),
        status,
        detail: sanitizeText(result.detail),
        destructive: result.destructive === true,
        ...(result.error ? { errorKind: result.error.kind } : {}),
        ...(status === "SKIP" && result.skipKind !== undefined ? { skipKind: result.skipKind } : {}),
        ...(status === "FAIL" && result.expected !== undefined ? { expected: sanitizeText(result.expected) } : {}),
        ...(status === "FAIL" && result.actual !== undefined ? { actual: sanitizeText(result.actual) } : {}),
        ...(status === "PASS" && result.reference !== undefined ? { reference: sanitizeText(result.reference) } : {}),
        ...(guidance === undefined
          ? {}
          : {
              fix: sanitizeText(guidance.fix),
              ...(guidance.docs === undefined ? {} : { docs: guidance.docs }),
            }),
      };
    }),
  };
}
