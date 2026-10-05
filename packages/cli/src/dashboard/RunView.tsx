import { useEffect, useMemo, useRef, useState } from "react";
import { writeFile } from "node:fs/promises";
import { Box, Text, useApp, useInput } from "ink";
import {
  CHECK_CATALOGUE,
  checkStatus,
  summarize,
  toStructuredRun,
  type CheckResult,
  type ProtocolId,
  X402_PAYMENT_CHECK_IDS,
} from "@wasit-dev/core";
import type { DashboardAction } from "./App.js";
import { runAction } from "./runners.js";
import { THEME } from "./theme.js";
import { formatDuration } from "./format.js";
import { useSpinnerFrame } from "./useSpinnerFrame.js";
import { useElapsedMs } from "./useElapsedMs.js";

interface RunViewProps {
  readonly protocol: ProtocolId;
  readonly action: DashboardAction;
  readonly target: string;
  readonly onBack: () => void;
}

type EntryStatus = "pending" | "PASS" | "FAIL" | "ERROR" | "SKIP";

interface Entry {
  readonly id: string;
  readonly name: string;
  readonly status: EntryStatus;
}

function iconFor(status: EntryStatus, spinnerFrame: string): string {
  switch (status) {
    case "PASS":
      return "✓";
    case "FAIL":
      return "✗";
    case "ERROR":
      return "⨯";
    case "SKIP":
      return "⚠";
    default:
      return spinnerFrame;
  }
}

function colorFor(status: EntryStatus): string {
  switch (status) {
    case "PASS":
      return THEME.success;
    case "FAIL":
      return THEME.danger;
    case "ERROR":
      // Not a conformance failure — the check produced no verdict at all
      // (network/config), so it gets the brand color rather than red.
      return THEME.accent;
    case "SKIP":
      return THEME.warning;
    default:
      return THEME.muted;
  }
}

// The payment checks need a payer key and are never touched by the
// read-only x402 action — listing them as "pending" would leave their rows
// spinning forever after the run has already finished. Core owns the list,
// so a new payment check cannot be missed here.
const READ_ONLY_EXCLUDED_IDS = new Set(X402_PAYMENT_CHECK_IDS);

export function RunView({ protocol, action, target, onBack }: RunViewProps) {
  const { exit } = useApp();

  const initialEntries = useMemo<Entry[]>(() => {
    const catalogueEntries = CHECK_CATALOGUE.filter((entry) => entry.protocol === protocol);
    const relevant =
      action.kind === "x402-read"
        ? catalogueEntries.filter((entry) => !READ_ONLY_EXCLUDED_IDS.has(entry.id))
        : catalogueEntries;
    return relevant.map((entry) => ({
      id: entry.id,
      name: entry.name,
      status: "pending" as const,
    }));
  }, [protocol, action.kind]);

  const [entries, setEntries] = useState<Entry[]>(initialEntries);
  const [extra, setExtra] = useState<Entry[]>([]);
  const [done, setDone] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [summaryLine, setSummaryLine] = useState<string | undefined>(undefined);
  const [finalResults, setFinalResults] = useState<CheckResult[] | undefined>(undefined);
  const [savedTo, setSavedTo] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  // Timestamps live in refs, not state: they don't need their own re-render,
  // the spinner hook below already re-renders often enough while the run is
  // live, and the state updates at completion re-render once more.
  const startedAtRef = useRef(Date.now());
  const finishedAtRef = useRef<number | undefined>(undefined);

  // Also what makes the live elapsed timer below tick — it re-renders on
  // the same interval. Stops once the run is done: nothing left to animate.
  const spinnerFrame = useSpinnerFrame(!done);

  // Ticks the elapsed counter in state rather than reading the clock while
  // rendering, and freezes at the run's real total once done flips.
  const elapsedMs = useElapsedMs(!done, startedAtRef.current);

  // Kicks off the run exactly once. Ignored intentionally: initialEntries is
  // derived from `protocol`, which does not change once a run has started.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false;

    const onResult = (result: CheckResult): void => {
      if (cancelled) return;
      const status = checkStatus(result);
      const isKnown = initialEntries.some((entry) => entry.id === result.id);

      if (isKnown) {
        setEntries((current) =>
          current.map((entry) => (entry.id === result.id ? { ...entry, status } : entry)),
        );
      } else {
        // Results outside the catalogue (e.g. PREFLIGHT) still need to be shown.
        setExtra((current) => [...current, { id: result.id, name: result.name, status }]);
      }
    };

    runAction(action, target, onResult)
      .then((results) => {
        if (cancelled) return;
        finishedAtRef.current = Date.now();
        const totalMs = finishedAtRef.current - startedAtRef.current;
        const summary = summarize(results);
        const parts = [`${summary.passed} passed`];
        if (summary.failed > 0) parts.push(`${summary.failed} failed`);
        if (summary.errored > 0) parts.push(`${summary.errored} could not run`);
        if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
        const avgMs = results.length > 0 ? totalMs / results.length : 0;
        setSummaryLine(
          `${parts.join(", ")}. ${formatDuration(totalMs)} total · ${formatDuration(avgMs)} avg/check.`,
        );
        setFinalResults(results);
        setDone(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        finishedAtRef.current = Date.now();
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setDone(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const saveResults = (): void => {
    if (finalResults === undefined) return;
    const filename = `wasit-${protocol}-${Date.now()}.json`;
    writeFile(filename, JSON.stringify(toStructuredRun(finalResults), null, 2), "utf8")
      .then(() => setSavedTo(filename))
      .catch((error: unknown) => {
        setSaveError(error instanceof Error ? error.message : String(error));
      });
  };

  useInput((input, key) => {
    if (input === "q") {
      exit();
      return;
    }
    if (!done) return;
    if (input === "s") {
      saveResults();
      return;
    }
    if (key.return) onBack();
    if (key.escape) exit();
  });

  // A config error (missing key, bad target) means no check ever ran — the
  // pending checklist below would just be dead weight, so this gets its own
  // focused screen instead of a red line bolted under it.
  if (errorMessage !== undefined) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={THEME.danger} paddingX={2} paddingY={1}>
        <Text bold color={THEME.danger}>
          Could not run this check
        </Text>
        <Box marginTop={1}>
          <Text>{errorMessage}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to go back · q to quit</Text>
        </Box>
      </Box>
    );
  }

  const firstPendingIndex = entries.findIndex((entry) => entry.status === "pending");

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={THEME.accent} paddingX={2} paddingY={1}>
      <Text bold color={THEME.accent}>
        {target}
      </Text>
      {!done && (
        <Text dimColor>Running · {formatDuration(elapsedMs)}</Text>
      )}

      <Box flexDirection="column" marginTop={1}>
        {extra.map((entry) => (
          <Text key={entry.id} color={colorFor(entry.status)}>
            {iconFor(entry.status, spinnerFrame)} {entry.id}  {entry.name}
          </Text>
        ))}
        {entries.map((entry, index) => {
          const isRunningNow = entry.status === "pending" && index === firstPendingIndex;
          const icon =
            entry.status === "pending" && !isRunningNow
              ? "·"
              : iconFor(entry.status, spinnerFrame);
          return (
            <Text
              key={entry.id}
              color={isRunningNow ? THEME.accent : colorFor(entry.status)}
              dimColor={entry.status === "pending" && !isRunningNow}
            >
              {icon} {entry.id}  {entry.name}
            </Text>
          );
        })}
      </Box>

      {done && summaryLine !== undefined && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>{summaryLine}</Text>
          {savedTo !== undefined && <Text color={THEME.success}>Saved to {savedTo}</Text>}
          {saveError !== undefined && (
            <Text color={THEME.danger}>Could not save results: {saveError}</Text>
          )}
          <Text dimColor>Enter to go back · s to save JSON · q to quit</Text>
        </Box>
      )}
    </Box>
  );
}
