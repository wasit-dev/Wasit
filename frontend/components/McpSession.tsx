"use client";

import { useEffect, useRef, useState } from "react";
import "./McpSession.css";

// What the agent "thinks" on its way to the tool call. Each is something
// the MCP server really offers: the wasit://checks resource, the
// wasit_x402_test tool and its readOnly flag, which runs X402-01–05 only.
const STEPS = ["Reading wasit://checks", "Picking wasit_x402_test, read-only", "Running X402-01 – 05"];

// Phase timeline, in ms from the start of a loop.
const STEP_AT = [300, 1100, 1900]; // each step appears
const DONE_AT = 2700; // thinking ends, every step ticked
const TOOL_AT = 2900; // the tool call card
const RESULT_AT = 3700; // the answer
const LOOP_MS = 9000;

/**
 * An agent session calling Wasit over MCP: a question, a "Thinking…"
 * line that counts up while its steps tick off one by one (inspired by
 * reactbits.dev's Thought Line, written here from scratch), the tool call
 * it lands on, and the answer — then it plays again.
 *
 * It starts when scrolled into view. The server render, a page without
 * scripts and reduced motion all show the finished session, never an
 * empty panel.
 */
export function McpSession() {
  const rootRef = useRef<HTMLDivElement>(null);
  // null = finished (the static state); a number = ms into the loop.
  const [t, setT] = useState<number | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let start = 0;
    let frame = 0;
    let visible = false;
    let shown = -1;
    const tick = (now: number) => {
      if (!start) start = now;
      // Re-render only when the tenth-of-a-second readout would change.
      const tenth = Math.floor(((now - start) % LOOP_MS) / 100) * 100;
      if (tenth !== shown) setT((shown = tenth));
      frame = visible ? requestAnimationFrame(tick) : 0;
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !frame) {
        start = 0;
        frame = requestAnimationFrame(tick);
      }
    });
    observer.observe(root);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  const at = t ?? Infinity;
  const thinking = at < DONE_AT;
  const seconds = (Math.min(at, DONE_AT) / 1000).toFixed(1);

  return (
    <div ref={rootRef} className="mcp-session">
      <div className="terminal-bar">
        <span className="terminal-controls" aria-hidden="true">
          <span className="terminal-dot terminal-dot-red" />
          <span className="terminal-dot terminal-dot-yellow" />
          <span className="terminal-dot terminal-dot-green" />
        </span>
        <span className="terminal-title">claude code · wasit mcp</span>
        <span>example</span>
      </div>

      <div className="mcp-body">
        <p className="mcp-prompt">
          <span aria-hidden="true">&gt;</span> Is https://api.example.com/paid x402-compliant? Don&rsquo;t spend
          anything.
        </p>

        <div className={`thought${thinking ? " thought--live" : ""}`}>
          <p className="thought-head">
            <span className="thought-glyph" aria-hidden="true">
              ✦
            </span>
            <span className="thought-label">{thinking ? "Thinking…" : "Thought for"}</span>
            <span className="thought-time">{seconds}s</span>
          </p>
          <ul className="thought-steps">
            {STEPS.map((step, i) =>
              at >= STEP_AT[i]! ? (
                <li key={step} className={at >= (STEP_AT[i + 1] ?? DONE_AT) ? "is-done" : "is-live"}>
                  <span className="thought-tick" aria-hidden="true" />
                  {step}
                </li>
              ) : null,
            )}
          </ul>
        </div>

        {at >= TOOL_AT && (
          <div className="mcp-call">
            <div className="mcp-call-head">
              <span>tool</span>
              <b>wasit_x402_test</b>
            </div>
            <pre>
              {`target    "https://api.example.com/paid"\nreadOnly  true`}
            </pre>
          </div>
        )}

        {at >= RESULT_AT && (
          <p className="mcp-answer">
            <span className="mcp-ok">✓ 5 passed.</span> The 402 challenge is well formed and names a valid
            network. X402-06–10 did not run: they settle a real payment, and you asked for none.
          </p>
        )}
      </div>
    </div>
  );
}
