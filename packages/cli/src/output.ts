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

import { countsLine, resultLines } from "./live.js";
import { lineWidth, type Styler } from "./style.js";

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
  /** Colours for a person at a terminal (`colorEnabled`). Absent or off: the plain text, unchanged. */
  readonly style?: Styler;
  /** The width coloured lines are laid out to. Default 80. */
  readonly width?: number;
}

/** The exit code of a run, by the same rule `report` uses. */
export function exitCodeFor(results: CheckResult[], protocol?: ProtocolId): number {
  return protocol === undefined ? summarize(results).exitCode : exitCodeForEndpoint(results, protocol);
}

/** The notes that close a run's text output, when it has no verdict. */
export function verdictNotes(results: CheckResult[], protocol?: ProtocolId): string[] {
  const counts = summarize(results);
  const exitCode = exitCodeFor(results, protocol);
  if (counts.errored > 0 && counts.failed === 0) {
    return [
      "No verdict: some checks never reached the target or the run is " +
        "misconfigured. This is not a statement about the target's conformance.",
    ];
  }
  if (protocol !== undefined && exitCode === 2 && paymentGroupUnsupported(results, protocol)) {
    return [
      "No verdict: the payment checks were asked for and Wasit cannot pay on this network " +
        "(unsupported; the skipped checks say why), so nothing was signed. This is not a failure " +
        "of the service, and not a pass.",
    ];
  }
  if (protocol !== undefined && exitCode === 2 && endpointOutcome(results, protocol) === "unsupported") {
    return [
      "No verdict: Wasit could not grade this service (unsupported; the skipped checks say why). " +
        "This is not a failure of the service, and not a pass.",
    ];
  }
  return [];
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
  const exitCode = exitCodeFor(results, options.protocol);

  if (json) {
    const run = options.protocol === undefined ? toStructuredRun(results) : toGradedRun(results, options.protocol);
    emit(JSON.stringify(redactValue(run, secrets), null, 2));
    return exitCode;
  }

  // Coloured, for a person at a terminal: the same checks, details, fixes and
  // notes, laid out like a test runner.
  const style = options.style;
  if (style !== undefined && style.enabled) {
    const width = options.width ?? lineWidth({});
    let lastSkip: string | undefined;
    for (const result of results) {
      const skip = checkStatus(result) === "SKIP";
      const repeated = skip && lastSkip === result.detail;
      lastSkip = skip ? result.detail : undefined;
      for (const line of resultLines(result, style, width, clean, undefined, !repeated)) emit(line);
    }
    emit("");
    emit(` ${countsLine(results, style)}`);
    for (const message of verdictNotes(results, options.protocol)) emit(`\n   ${style.paint("note", "bold", "warning")}  ${clean(message)}`);
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

  for (const message of verdictNotes(results, options.protocol)) emit(`\n${message}`);

  return exitCode;
}
