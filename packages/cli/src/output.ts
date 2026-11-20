import {
  checkStatus,
  deniedEnvValues,
  exitCodeForEndpoint,
  fixFor,
  redactValue,
  sanitizeText,
  summarize,
  toGradedRun,
  toStructuredRun,
  endpointOutcome,
  paymentGroupUnsupported,
  type CheckResult,
  type ProtocolId,
} from "@wasit-dev/core";

/**
 * Prints an advisory/status line meant for a human watching the terminal,
 * never part of the run's actual result. Routed to stderr when --json is
 * set, so stdout stays parseable JSON and a script piping it (jq, etc.)
 * never has to skip past prose first.
 */
export function note(json: boolean, message: string): void {
  if (json) {
    console.error(message);
  } else {
    console.log(message);
  }
}

export interface ReportOptions {
  /**
   * The protocol of the one endpoint these results belong to. Given, the exit
   * code follows the rule for a graded endpoint (spec A8 #3, D-021): a service
   * that was never graded exits 2. Left out, the exit code is the counts' (the
   * MPP commands keep today's).
   */
  readonly protocol?: ProtocolId;
  /** Where lines go. Default `console.log`. */
  readonly emit?: (line: string) => void;
  /** Values no output may carry. Default: the keys and header values in the environment. */
  readonly secrets?: readonly string[];
}

/**
 * Prints results and returns the process exit code.
 *
 * A skipped check carries `pass: false` so it can never be counted as
 * conformance, but it is not a failure and must not fail the run. An errored
 * check produced no verdict at all and is reported separately again.
 *
 * Everything printed passes through the sanitiser: a detail can quote what a
 * service answered, and a terminal or a CI log reads control characters and a
 * leading `::` as commands (spec A8 #6).
 *
 * `--json` reuses `toStructuredRun()` from core, the same reshape the MCP
 * server calls for its own structured output, rather than defining a
 * second JSON shape here that could drift from it.
 */
export function report(results: CheckResult[], json: boolean, options: ReportOptions = {}): number {
  const emit = options.emit ?? ((line: string) => console.log(line));
  const secrets = options.secrets ?? deniedEnvValues(process.env);
  const clean = (text: string): string => sanitizeText(text, { redact: secrets });
  const counts = summarize(results);
  const exitCode = options.protocol === undefined ? counts.exitCode : exitCodeForEndpoint(results, options.protocol);

  if (json) {
    const run = options.protocol === undefined ? toStructuredRun(results) : toGradedRun(results, options.protocol);
    emit(JSON.stringify(redactValue(run, secrets), null, 2));
    return exitCode;
  }

  for (const result of results) {
    const flag = result.destructive ? "  [destructive]" : "";
    emit(clean(`${checkStatus(result)}  ${result.id}  ${result.name}${flag}`));
    emit(clean(`      ${result.detail}`));
    const guidance = fixFor(result);
    if (guidance !== undefined) {
      emit(clean(`      Fix: ${guidance.fix}`));
      if (guidance.docs !== undefined) emit(clean(`      Docs: ${guidance.docs}`));
    }
    emit("");
  }

  const line = [`${counts.passed} passed`];
  if (counts.failed > 0) line.push(`${counts.failed} failed`);
  if (counts.errored > 0) line.push(`${counts.errored} could not run`);
  if (counts.skipped > 0) line.push(`${counts.skipped} skipped`);
  emit(`${line.join(", ")}.`);

  if (counts.errored > 0 && counts.failed === 0) {
    emit(
      "\nNo verdict: some checks never reached the target or the run is " +
        "misconfigured. This is not a statement about the target's conformance.",
    );
  } else if (options.protocol !== undefined && exitCode === 2 && paymentGroupUnsupported(results, options.protocol)) {
    emit(
      "\nNo verdict: the payment checks were asked for and Wasit cannot pay on this network " +
        "(unsupported; the skipped checks say why), so nothing was signed. This is not a failure " +
        "of the service, and not a pass.",
    );
  } else if (
    options.protocol !== undefined &&
    exitCode === 2 &&
    endpointOutcome(results, options.protocol) === "unsupported"
  ) {
    emit(
      "\nNo verdict: Wasit could not grade this service (unsupported; the skipped checks say why). " +
        "This is not a failure of the service, and not a pass.",
    );
  }

  return exitCode;
}
