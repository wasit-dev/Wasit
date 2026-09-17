/**
 * The result shape shared by every conformance check, across protocols.
 */

import { type CheckError, classifyCheckError } from "./errors.js";

export interface CheckResult {
  /** Stable catalogue identifier, e.g. "MPP-11". Must match docs/CHECKS.md. */
  id: string;
  name: string;
  /** False when the check ran and the target did not conform. */
  pass: boolean;
  detail: string;
  /**
   * True when the check did not run. A skipped check is neither a pass nor a
   * failure: `pass` is false so it can never be counted as conformance, and
   * reporters must render it separately rather than as a defect.
   */
  skipped?: boolean;
  /** Why the check was skipped. Required whenever `skipped` is true. */
  skipReason?: string;
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

/** Builds the result for a check that was not run, for a non-destructive reason. */
export function skipped(id: string, name: string, reason: string): CheckResult {
  return {
    id,
    name,
    pass: false,
    skipped: true,
    skipReason: reason,
    detail: `Skipped: ${reason}`,
  };
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
    results: results.map((result) => ({
      id: result.id,
      name: result.name,
      status: checkStatus(result),
      detail: result.detail,
      destructive: result.destructive === true,
      ...(result.error ? { errorKind: result.error.kind } : {}),
    })),
  };
}
