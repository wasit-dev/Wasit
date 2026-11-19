/**
 * The coloured, live text output of a check run (Najmi, 2026-11-19), in
 * Wasit's own look: a header, the checks in two blocks (challenge, payment),
 * one line per check with its mark (✓ pass, ✗ fail, ○ skip, ! error) and its
 * duration flush right, a spinner line saying what the check in flight is doing,
 * and the verdict, the counts and the run's duration at the end.
 *
 * It only arranges what the plain output says: the same checks, details, fixes
 * and notes, in the same order. It is used only when colour is on
 * (`colorEnabled`); `live` adds the spinner line, rewritten in place, on a real
 * terminal. That line is cut to the terminal's width so it never wraps: a
 * wrapped line cannot be rewritten in place. Every text passes through `clean`
 * (the sanitiser, with the secrets redacted) before it is styled.
 */

import { checkStatus, fixFor, summarize, type CheckResult, type EndpointOutcome } from "@wasit-dev/core";

import {
  MARKS,
  SPINNER_FRAMES,
  SPINNER_MS,
  duration,
  lineWidth,
  spread,
  styler,
  truncate,
  visibleLength,
  wrap,
  type BadgeRole,
  type ColorDepth,
  type Role,
  type Styler,
  type StyleStream,
} from "./style.js";

export interface LiveStream extends StyleStream {
  write(chunk: string): unknown;
}

export interface LiveOptions {
  readonly stream: LiveStream;
  /** Rewrite the spinner line in place. Off: lines are only appended. */
  readonly live: boolean;
  /** The sanitiser, with the run's secrets redacted. */
  readonly clean: (text: string) => string;
  /** The terminal's colour depth (`colorDepth`): 24-bit gives the exact brand colours. Default 16. */
  readonly depth?: ColorDepth;
  /** Shorthand for `depth: 24`. */
  readonly truecolor?: boolean;
  readonly now?: () => number;
  /** How often the spinner line is redrawn. */
  readonly tickMs?: number;
}

/** What a check does while it runs, for its spinner line. */
const DOING: Readonly<Record<string, string>> = {
  "X402-01..05": "reading the challenge, no payment",
  "X402-06": "paying once, then reading the transfer on chain",
  "X402-07": "sending a payment with a corrupted signature",
  "X402-08": "sending the same payment again",
  "X402-09": "sending a validly signed payment for half the price",
  "X402-10": "waiting for an authorization to expire, then sending it",
  "X402-11": "sending a payment with the request the service must refuse",
};

/** The indent of a check's detail lines, under its ID. */
const DETAIL = "     ";
/** The indent of the lines after the first of a fix. */
const FIX = "          ";

const STATUS_ROLE: Record<string, Role> = { PASS: "dim", FAIL: "danger", SKIP: "warning", ERROR: "error" };

/**
 * The lines of one check: its line (mark, ID, name, duration, badge), then its
 * detail, its fix and its docs. `withDetail` false leaves the detail out: a
 * skip whose reason the skip just above it already gave.
 */
export function resultLines(
  result: CheckResult,
  style: Styler,
  width: number,
  clean: (text: string) => string,
  ms?: number,
  withDetail = true,
): string[] {
  const status = checkStatus(result);
  const marks = MARKS[status];
  const flag = result.destructive ? style.paint(" [destructive]", "warning") : "";
  const left = `   ${style.paint(marks.mark, "bold", marks.markRole)} ${style.paint(clean(result.id), "bold")}  ${clean(result.name)}${flag}`;
  const time = ms === undefined ? "" : style.paint(duration(ms), "muted");
  const right = [time, style.badge(marks.badge, marks.badgeRole)].filter((part) => part !== "").join("  ");
  const lines = [spread(left, right, width)];
  if (withDetail) {
    for (const line of wrap(clean(result.detail), width, DETAIL)) lines.push(style.paint(line, STATUS_ROLE[status] ?? "dim"));
  }
  const guidance = fixFor(result);
  if (guidance !== undefined) {
    const fix = wrap(clean(guidance.fix), width, FIX);
    fix[0] = `${DETAIL}${style.paint("fix", "bold")}  ${fix[0]?.trimStart() ?? ""}`;
    lines.push(...fix);
    if (guidance.docs !== undefined) lines.push(`${DETAIL}${style.paint(`docs ${clean(guidance.docs)}`, "muted")}`);
  }
  return lines;
}

/** "10 passed", "1 failed", "1 could not run", "1 skipped": each count in its colour. */
export function countsParts(results: readonly CheckResult[], style: Styler): string[] {
  const counts = summarize([...results]);
  const parts = [style.paint(`${counts.passed} passed`, "bold", "success")];
  if (counts.failed > 0) parts.push(style.paint(`${counts.failed} failed`, "bold", "danger"));
  if (counts.errored > 0) parts.push(style.paint(`${counts.errored} could not run`, "bold", "error"));
  if (counts.skipped > 0) parts.push(style.paint(`${counts.skipped} skipped`, "bold", "warning"));
  return parts;
}

/** "10 passed · 1 failed · 1 could not run · 1 skipped". */
export function countsLine(results: readonly CheckResult[], style: Styler): string {
  return countsParts(results, style).join(style.paint(" · ", "muted"));
}

/** Parts joined by " · " into lines of at most `width` columns, each after `indent`. */
function packParts(parts: readonly string[], width: number, indent: string, style: Styler): string[] {
  const separator = style.paint(" · ", "muted");
  const lines: string[] = [];
  let current = "";
  for (const part of parts) {
    const next = current === "" ? `${indent}${part}` : `${current}${separator}${part}`;
    if (current !== "" && visibleLength(next) > width) {
      lines.push(current);
      current = `${indent}${part}`;
    } else {
      current = next;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

const VERDICT: Record<EndpointOutcome, { readonly text: string; readonly role: BadgeRole }> = {
  conformant: { text: "CONFORMANT", role: "success" },
  "non-conformant": { text: "NOT CONFORMANT", role: "danger" },
  "no-verdict": { text: "NO VERDICT", role: "error" },
  unsupported: { text: "UNSUPPORTED", role: "warning" },
};

export class LiveReport {
  readonly #stream: LiveStream;
  readonly #live: boolean;
  readonly #clean: (text: string) => string;
  readonly #now: () => number;
  readonly #tickMs: number;
  readonly #style: Styler;
  readonly #startedAt: number;
  #running: { readonly id: string; readonly name: string; readonly startedAt: number } | undefined;
  #drawn = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  /** The reason of the skip printed just before, so the next skip with the same reason does not repeat it. */
  #lastSkip: string | undefined;

  public constructor(options: LiveOptions) {
    this.#stream = options.stream;
    this.#live = options.live;
    this.#clean = options.clean;
    this.#now = options.now ?? Date.now;
    this.#tickMs = options.tickMs ?? SPINNER_MS;
    this.#style = styler(true, options.depth ?? (options.truecolor === true ? 24 : 16));
    this.#startedAt = this.#now();
  }

  get #width(): number {
    return lineWidth(this.#stream);
  }

  #line(text = ""): void {
    this.#stream.write(`${text}\n`);
  }

  /** Clears the spinner line from the screen, if one is drawn. */
  #clearRunning(): void {
    if (this.#drawn) this.#stream.write("\r\u001b[2K");
    this.#drawn = false;
  }

  /** The spinner line: the frame, the ID, what the check is doing, the time so far; never wider than the terminal. */
  #drawRunning(): void {
    const running = this.#running;
    if (!this.#live || running === undefined) return;
    const elapsed = this.#now() - running.startedAt;
    const frame = SPINNER_FRAMES[Math.floor(elapsed / SPINNER_MS) % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
    const id = this.#clean(running.id);
    const time = duration(elapsed);
    const max = this.#width;
    const fixed = 3 + 2 + [...id].length + 2 + 2 + [...time].length;
    const doing = truncate(this.#clean(DOING[running.id] ?? running.name), Math.max(1, max - fixed));
    const left = `   ${this.#style.paint(frame, "accent")} ${this.#style.paint(id, "bold")}  ${this.#style.paint(doing, "muted")}`;
    let line = spread(left, this.#style.paint(time, "muted"), max);
    if (visibleLength(line) > max) line = left;
    this.#stream.write(`\r\u001b[2K${line}`);
    this.#drawn = true;
  }

  #stopTimer(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** ` ◆ wasit <version> · x402 conformance`, then `label  value` rows. */
  public header(version: string, subject: string, rows: ReadonlyArray<readonly [string, string]> = []): void {
    const s = this.#style;
    this.#line(` ${s.paint("◆", "accent")} ${s.paint("wasit", "bold")} ${s.paint(`${this.#clean(version)} · ${this.#clean(subject)}`, "muted")}`);
    const pad = Math.max(0, ...rows.map(([label]) => label.length));
    for (const [label, value] of rows) this.#line(`   ${s.paint(label.padEnd(pad), "muted")}  ${this.#clean(value)}`);
    this.#line();
  }

  /** A block heading: ` payment · stellar:testnet · testnet funds move`. */
  public phase(name: string, parts: ReadonlyArray<readonly [string, Role?]> = []): void {
    this.#clearRunning();
    const s = this.#style;
    const rest = parts.map(([text, role]) => `${s.paint("·", "muted")} ${s.paint(this.#clean(text), role ?? "muted")}`).join(" ");
    this.#line(` ${s.paint(this.#clean(name), "bold", "accent")}${rest === "" ? "" : ` ${rest}`}`);
    this.#drawRunning();
  }

  /** A note under a block: why checks were left out, or that money moves. */
  public note(text: string): void {
    this.#clearRunning();
    for (const line of wrap(this.#clean(text), this.#width, "   ")) this.#line(this.#style.paint(line, "warning"));
    this.#drawRunning();
  }

  /** A check (or a group of checks) starts: its spinner line, on a real terminal. */
  public running(id: string, name: string): void {
    this.#clearRunning();
    this.#stopTimer();
    this.#running = { id, name, startedAt: this.#now() };
    this.#drawRunning();
    if (this.#live) {
      this.#timer = setInterval(() => this.#drawRunning(), this.#tickMs);
      this.#timer.unref?.();
    }
  }

  /** A progress line from the check in flight, dimmed, above its spinner line. */
  public progress(text: string): void {
    this.#clearRunning();
    for (const line of wrap(`↳ ${this.#clean(text)}`, this.#width, DETAIL)) this.#line(this.#style.paint(line, "dim"));
    this.#drawRunning();
  }

  /**
   * A check's result replaces its spinner line and carries the time since it
   * started. Results computed together with an earlier one (the challenge
   * checks, or the checks skipped after a failed payment) carry none, and a
   * skipped check never does.
   */
  public result(result: CheckResult): void {
    let ms: number | undefined;
    if (this.#running !== undefined) {
      ms = this.#now() - this.#running.startedAt;
      this.#clearRunning();
      this.#stopTimer();
      this.#running = undefined;
    }
    const skip = checkStatus(result) === "SKIP";
    if (skip) ms = undefined;
    const repeated = skip && this.#lastSkip === result.detail;
    this.#lastSkip = skip ? result.detail : undefined;
    for (const line of resultLines(result, this.#style, this.#width, this.#clean, ms, !repeated)) this.#line(line);
  }

  /** A blank line between blocks. */
  public gap(): void {
    this.#clearRunning();
    this.#line();
    this.#drawRunning();
  }

  /** The verdict, the counts, the run's duration, and the plain output's closing notes. */
  public finish(results: readonly CheckResult[], outcome: EndpointOutcome | undefined, notes: readonly string[]): void {
    this.#clearRunning();
    this.#stopTimer();
    this.#running = undefined;
    const s = this.#style;
    const verdict = outcome === undefined ? "" : `${s.badge(VERDICT[outcome].text, VERDICT[outcome].role)}  `;
    this.#line();
    const parts = [...countsParts(results, s), s.paint(duration(this.#now() - this.#startedAt), "bold")];
    const oneLine = ` ${verdict}${parts.join(s.paint(" · ", "muted"))}`;
    if (visibleLength(oneLine) <= this.#width) {
      this.#line(oneLine);
    } else {
      if (verdict !== "") this.#line(` ${verdict.trimEnd()}`);
      for (const line of packParts(parts, this.#width, " ", s)) this.#line(line);
    }
    for (const note of notes) {
      this.#line();
      const lines = wrap(this.#clean(note), this.#width, "         ");
      lines[0] = `   ${s.paint("note", "bold", "warning")}  ${lines[0]?.trimStart() ?? ""}`;
      for (const line of lines) this.#line(line);
    }
  }
}
