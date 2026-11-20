import {
  describeRun,
  describeTotals,
  type EndpointReport,
  type ResolvedRun,
  type RunReport,
  type RunVerdict,
} from "@wasit-dev/core";

/** Consecutive skipped checks with the same reason are one block: five payment checks, one reason. */
function blocks(endpoint: EndpointReport): Array<{ ids: string[]; first: EndpointReport["results"][number] }> {
  const out: Array<{ ids: string[]; first: EndpointReport["results"][number] }> = [];
  for (const result of endpoint.results) {
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      result.status === "SKIP" &&
      last.first.status === "SKIP" &&
      last.first.detail === result.detail &&
      last.first.skipKind === result.skipKind
    ) {
      last.ids.push(result.id);
    } else {
      out.push({ ids: [result.id], first: result });
    }
  }
  return out;
}

/**
 * The text `wasit run` prints without `--json`: the run, then each endpoint with
 * its checks, then the summary line and the exit reason. Lines only; the caller
 * passes them through the sanitiser (they hold text a service sent).
 */
export function formatRun(resolved: ResolvedRun, report: RunReport, verdict: RunVerdict): string[] {
  // The first note is the tier: what the run paid, or why it did not.
  const tier = report.notes[0];
  const lines: string[] = [describeRun(resolved), ...(tier === undefined ? [] : [tier]), ""];

  for (const endpoint of report.endpoints) {
    lines.push(`${endpoint.name}  ${endpoint.protocol}  ${endpoint.method} ${endpoint.path}: ${endpoint.outcome}`);
    if (endpoint.reason !== undefined) lines.push(`  Not graded: ${endpoint.reason}`);
    for (const { ids, first } of blocks(endpoint)) {
      lines.push(`  ${first.status}  ${ids.join(", ")}${ids.length === 1 ? `  ${first.name}` : ""}`);
      lines.push(`        ${first.detail}`);
      if (first.expected !== undefined) lines.push(`        Expected: ${first.expected}`);
      if (first.actual !== undefined) lines.push(`        Actual: ${first.actual}`);
      if (first.fix !== undefined) lines.push(`        Fix: ${first.fix}`);
      if (first.docs !== undefined) lines.push(`        Docs: ${first.docs}`);
    }
    lines.push("");
  }

  lines.push(`Summary: ${describeTotals(report.totals)}.`);
  for (const note of report.notes.slice(1)) lines.push(`Note: ${note}`);
  lines.push(`Result: ${verdict.reason} (exit ${verdict.code}).`);
  if (verdict.code === 2) {
    lines.push("No verdict is neither a pass nor a failure of the service: see the endpoints that were not graded.");
  }
  return lines;
}
