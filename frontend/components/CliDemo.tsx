"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import "./CliDemo.css"

type CheckStatus = "PASS" | "FAIL" | "SKIP"

type ResultLine = {
  status: CheckStatus
  id: string
  name: string
  detail: string
  negative?: boolean
}

type Line =
  | { kind: "status"; result: ResultLine }
  | { kind: "detail"; text: string }
  | { kind: "blank" }
  | { kind: "summary"; text: string }

type Protocol = "x402" | "mpp"

interface Script {
  command: string
  results: ResultLine[]
  ariaLabel: string
}

// Command and check IDs/detail text for both scripts are pulled straight
// from the real implementation (packages/core/src/x402/simulator.ts and
// packages/core/src/mpp/*.ts, plus the CLI's own reporter,
// packages/cli/src/index.ts `report()`), not invented marketing copy —
// each is what `wasit test` / `wasit mpp-channel` actually prints against
// a target that conforms. Illustrative numbers (channel balance, ledger)
// stand in for values that are only known at run time, the same way
// "https://api.example.com/paid-endpoint" stands in for a real target URL.

const X402_SCRIPT: Script = {
  command: "wasit test --target https://api.example.com/paid-endpoint",
  ariaLabel:
    "Example wasit test run against a paid endpoint: all seven x402 checks pass, including a check that a payment with a corrupted signature is refused with HTTP 402.",
  results: [
    {
      status: "PASS",
      id: "X402-01",
      name: "402 Response Status",
      detail: "Server responded with 402 as required.",
    },
    {
      status: "PASS",
      id: "X402-02",
      name: "Payment Header Present",
      detail: "Payment header found.",
    },
    {
      status: "PASS",
      id: "X402-03",
      name: "Header Payload Decodable",
      detail: "Header decoded to valid JSON.",
    },
    {
      status: "PASS",
      id: "X402-04",
      name: "Required Fields Present",
      detail: "All required v2 fields present.",
    },
    {
      status: "PASS",
      id: "X402-05",
      name: "Network Identifier Valid",
      detail: 'Network identifier "stellar:testnet" is valid.',
    },
    {
      status: "PASS",
      id: "X402-06",
      name: "Signature Resubmit Accepted",
      detail: "Valid payment accepted (HTTP 200).",
    },
    {
      status: "PASS",
      id: "X402-07",
      name: "Invalid Signature Rejected",
      detail: "Corrupted payment correctly rejected (HTTP 402).",
      negative: true,
    },
  ],
}

const MPP_SCRIPT: Script = {
  command: "wasit mpp-channel --target https://api.example.com/paid-endpoint",
  ariaLabel:
    "Example wasit mpp-channel run against a paid endpoint: MPP-10, MPP-11, MPP-12 and MPP-14 pass, including two checks that a captured or replayed commitment is correctly rejected, and MPP-13 is shown skipped because it is destructive and off by default.",
  results: [
    {
      status: "PASS",
      id: "MPP-10",
      name: "Channel Deploy",
      detail: "Channel deployed and queryable — balance=42000000, currentLedger=583210.",
    },
    {
      status: "PASS",
      id: "MPP-11",
      name: "Cumulative Commitment Ordering",
      detail:
        "Both ordering rules enforced: a commitment equal to the cumulative and one that under-covers the price were each rejected (HTTP 402).",
    },
    {
      status: "PASS",
      id: "MPP-12",
      name: "Challenge Replay Rejection",
      detail: "Byte-identical credential correctly rejected on replay (HTTP 402).",
      negative: true,
    },
    {
      status: "PASS",
      id: "MPP-14",
      name: "Commitment Replay Rejection",
      detail:
        "Captured commitment correctly rejected when re-presented against a fresh challenge (HTTP 402).",
      negative: true,
    },
    {
      status: "SKIP",
      id: "MPP-13",
      name: "Close Settlement",
      detail:
        "Skipped (destructive): closing settles the channel on-chain and permanently ends it. Re-run with --allow-destructive, against a channel you own.",
    },
  ],
}

const SCRIPTS: Record<Protocol, Script> = { x402: X402_SCRIPT, mpp: MPP_SCRIPT }

function summaryText(results: ResultLine[]): string {
  const passed = results.filter((r) => r.status === "PASS").length
  const skipped = results.filter((r) => r.status === "SKIP").length
  const failed = results.filter((r) => r.status === "FAIL").length
  const parts: string[] = []
  if (passed > 0) parts.push(`${passed} passed`)
  if (failed > 0) parts.push(`${failed} failed`)
  if (skipped > 0) parts.push(`${skipped} skipped`)
  return `${parts.join(", ")}.`
}

function buildLines(results: ResultLine[]): Line[] {
  return results
    .flatMap((result): Line[] => [
      { kind: "status", result },
      { kind: "detail", text: result.detail },
      { kind: "blank" },
    ])
    .concat([{ kind: "summary", text: summaryText(results) }])
}

const TYPE_MS = 28 // per character, command line
const LINE_MS = 130 // per revealed output line
const HOLD_MS = 2600 // pause once the run finishes, before clearing
const RESET_PAUSE_MS = 500 // pause on an empty prompt before retyping

/**
 * Ambient, looping recreation of a real `wasit` run, typed and streamed
 * line by line instead of dropped in as static text. The hero's .cmdbox
 * above this (unchanged) already shows the copy-pasteable install
 * command; this continues from it to show what actually comes back.
 *
 * A small tab pair lets a visitor switch which protocol's run is
 * playing (x402 or MPP channel mode) — Wasit tests both, and this demo
 * used to be x402-only. Switching tabs restarts the animation from the
 * newly selected script; it is not auto-cycled, so a visitor who never
 * touches it just keeps seeing the same protocol loop, same as before.
 *
 * Initial render (server and pre-hydration client) shows the finished,
 * complete x402 output with no motion at all — deterministic, so there
 * is no hydration mismatch, and it doubles as the correct fallback for a
 * prefers-reduced-motion reader or a crawler: the mount effect below
 * only clears and starts the type/stream loop when the browser does NOT
 * report a reduced-motion preference. A reduced-motion reader who
 * switches tabs still sees the newly selected script's complete,
 * finished output — just with no animation getting there.
 */
export function CliDemo() {
  const [protocol, setProtocol] = useState<Protocol>("x402")
  const script = SCRIPTS[protocol]
  const lines = useMemo(() => buildLines(script.results), [script])

  const [typed, setTyped] = useState(script.command)
  const [revealed, setRevealed] = useState(lines.length)
  const outputRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches

    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const schedule = (fn: () => void, ms: number) => {
      timer = setTimeout(() => {
        if (!cancelled) fn()
      }, ms)
    }

    if (prefersReducedMotion) {
      // No animation loop to start, but a tab switch must still land on
      // that script's finished state rather than the previous tab's.
      // Deferred through `schedule` rather than called directly here,
      // for the same reason as `resetRun` below: the effect body itself
      // never calls setState synchronously.
      schedule(() => {
        setTyped(script.command)
        setRevealed(lines.length)
      }, 0)
      return () => {
        cancelled = true
        clearTimeout(timer)
      }
    }

    function typeCommand(index: number) {
      setTyped(script.command.slice(0, index))
      if (index < script.command.length) {
        schedule(() => typeCommand(index + 1), TYPE_MS)
      } else {
        schedule(() => revealLine(0), 320)
      }
    }

    function revealLine(index: number) {
      setRevealed(index + 1)
      if (index + 1 < lines.length) {
        const justRevealedBlank = lines[index].kind === "blank"
        schedule(() => revealLine(index + 1), justRevealedBlank ? 70 : LINE_MS)
      } else {
        schedule(resetRun, HOLD_MS)
      }
    }

    function resetRun() {
      setTyped("")
      setRevealed(0)
      schedule(() => typeCommand(0), RESET_PAUSE_MS)
    }

    // The reset (clearing typed/revealed back to empty) is deferred into
    // this scheduled callback rather than called synchronously here, so
    // the effect body itself never calls setState directly — same
    // exception pattern as docs-toc.tsx/mermaid-diagram.tsx/use-mobile.ts
    // (see eslint.config.mjs history): a setState from inside an
    // already-async callback is not what react-hooks/set-state-in-effect
    // is guarding against.
    schedule(resetRun, 0)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // Restarts the whole type/stream loop from scratch whenever the
    // selected protocol changes — `script`/`lines` are derived from
    // `protocol` in the same render that triggers this effect, so
    // depending on `protocol` alone is enough and avoids re-running on
    // every unrelated render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protocol])

  useEffect(() => {
    const node = outputRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [revealed])

  const visibleLines = useMemo(() => lines.slice(0, revealed), [lines, revealed])
  const showCursor = typed.length < script.command.length

  return (
    <div className="cli-demo">
      <div className="cli-demo-tabs" role="group" aria-label="Protocol to preview">
        {(Object.keys(SCRIPTS) as Protocol[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={protocol === key}
            className={`cli-demo-tab${protocol === key ? " cli-demo-tab--active" : ""}`}
            onClick={() => setProtocol(key)}
          >
            {key === "x402" ? "x402" : "MPP"}
          </button>
        ))}
      </div>
      <div className="cli-demo-terminal" role="img" aria-label={script.ariaLabel}>
        <div className="cli-demo-prompt mono" aria-hidden="true">
          <span className="cli-demo-prompt-glyph">$</span> {typed}
          {showCursor && <span className="cli-demo-cursor" />}
        </div>
        <div className="cli-demo-output mono" ref={outputRef} aria-hidden="true">
          {visibleLines.map((line, i) => {
            if (line.kind === "blank") {
              return <div key={i} className="cli-demo-blank" />
            }
            if (line.kind === "summary") {
              return (
                <div key={i} className="cli-demo-summary">
                  {line.text}
                </div>
              )
            }
            if (line.kind === "detail") {
              return (
                <div key={i} className="cli-demo-detail">
                  {line.text}
                </div>
              )
            }
            const { result } = line
            return (
              <div key={i} className="cli-demo-status">
                <span
                  className={`cli-demo-badge cli-demo-badge--${result.status.toLowerCase()}`}
                >
                  {result.status}
                </span>
                <span className="cli-demo-id">{result.id}</span>
                <span className="cli-demo-name">{result.name}</span>
                {result.negative && <span className="cli-demo-negative">reject test</span>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
