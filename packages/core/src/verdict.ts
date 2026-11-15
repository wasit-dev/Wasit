/**
 * The exit code of a run of several endpoints (spec A2 with A8 #3, D-021).
 *
 * - 1: an endpoint is non-conformant, or an endpoint that was graded on the
 *   default branch is not graded now (the baseline says so). A service that
 *   drops below the standard of its chain must not be green.
 * - 2: no verdict. Nothing could be graded, a check could not run, or payment
 *   checks were asked for and none could be graded on an endpoint's network. A
 *   service that was never graded is here: not green, and not labelled FAIL.
 * - 0: at least one endpoint was graded, none failed, no check errored.
 *
 * The reason carries the counts ("0 graded, 1 unsupported"), so a green run
 * cannot be read as a pass of something that was not graded.
 */

import { findRegressions, type Regression } from "./baseline.js";
import { describeTotals, paymentGroupUnsupported, type RunReport } from "./report.js";

export interface RunVerdict {
  readonly code: 0 | 1 | 2;
  /** One line, for the terminal, the job summary and the report notes. */
  readonly reason: string;
  /** Endpoints that were graded on the baseline and are not now. Empty without a baseline. */
  readonly regressions: readonly Regression[];
}

export function runExitCode(report: RunReport, baseline?: RunReport): RunVerdict {
  const regressions = baseline === undefined ? [] : findRegressions(report, baseline);
  const counts = describeTotals(report.totals);
  const errored = report.endpoints.reduce(
    (total, endpoint) => total + endpoint.results.filter((result) => result.status === "ERROR").length,
    0,
  );

  if (report.totals.nonConformant > 0) {
    const n = report.totals.nonConformant;
    return { code: 1, reason: `${n} endpoint${n === 1 ? " is" : "s are"} non-conformant (${counts})`, regressions };
  }
  if (regressions.length > 0) {
    const list = regressions.map((item) => `${item.endpoint} (${item.was} on main, now ${item.now})`).join(", ");
    return { code: 1, reason: `regression against main: ${list} (${counts})`, regressions };
  }
  if (report.totals.graded === 0) {
    return { code: 2, reason: `nothing could be graded: ${counts}`, regressions };
  }
  if (errored > 0) {
    return { code: 2, reason: `${errored} check${errored === 1 ? "" : "s"} could not run (${counts})`, regressions };
  }
  // Payment checks were asked for and none could be graded on an endpoint's network (Najmi, 2026-11-15).
  const unsupportedPayment = report.endpoints.filter((endpoint) => paymentGroupUnsupported(endpoint.results, endpoint.protocol)).length;
  if (unsupportedPayment > 0) {
    return {
      code: 2,
      reason:
        `payment checks were asked for and could not be graded on ${unsupportedPayment} ` +
        `endpoint${unsupportedPayment === 1 ? "" : "s"} (${counts})`,
      regressions,
    };
  }
  return { code: 0, reason: counts, regressions };
}
