/**
 * Colours and line layout for a person watching the terminal (Najmi,
 * 2026-11-19): Wasit's own look, in the palette the site and the dashboard use
 * (`dashboard/theme.ts`), a spinner while a check runs, and the run's duration.
 *
 * Colour is a layer over the plain text, never a second wording: every line is
 * sanitised first (`sanitizeText`), then styled, so nothing a service sent can
 * carry an escape sequence of its own. Output that a program reads stays plain:
 * `--json`, a pipe, CI and `NO_COLOR` all get the exact text Wasit printed
 * before colours existed.
 */

import { THEME } from "./dashboard/theme.js";

/** The parts of a stream this module reads. */
export interface StyleStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
}

type Env = Readonly<Record<string, string | undefined>>;

function set(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/**
 * True when lines may carry colour: `NO_COLOR` set turns it off, `FORCE_COLOR`
 * set (and not "0") turns it on, a dumb terminal and CI are plain, otherwise a
 * TTY is coloured and anything else is not.
 */
export function colorEnabled(stream: StyleStream, env: Env): boolean {
  if (set(env["NO_COLOR"])) return false;
  if (set(env["FORCE_COLOR"]) && env["FORCE_COLOR"] !== "0") return true;
  if (env["TERM"] === "dumb") return false;
  if (set(env["CI"]) || set(env["GITHUB_ACTIONS"])) return false;
  return stream.isTTY === true;
}

/**
 * True when a line may be rewritten in place (the running line and its
 * spinner): colour on, and a real terminal. A forced colour into a pipe gets
 * colour but no cursor movement.
 */
export function liveEnabled(stream: StyleStream, env: Env): boolean {
  return colorEnabled(stream, env) && stream.isTTY === true && !set(env["CI"]) && !set(env["GITHUB_ACTIONS"]);
}

/** True when the terminal says it shows 24-bit colour; the brand colours are then exact. */
export function truecolorEnabled(env: Env): boolean {
  const value = (env["COLORTERM"] ?? "").toLowerCase();
  return value === "truecolor" || value === "24bit";
}

/** How many colours the terminal says it shows: 24-bit, 256, or the 16 of every terminal. */
export type ColorDepth = 16 | 256 | 24;

export function colorDepth(env: Env): ColorDepth {
  if (truecolorEnabled(env)) return 24;
  if ((env["TERM"] ?? "").includes("256")) return 256;
  return 16;
}

/** The roles a line's parts are painted in. */
export type Role = "accent" | "muted" | "success" | "warning" | "danger" | "error" | "bold" | "dim";

/** Each role: its brand colour, and the 16-colour code a plain terminal gets instead. */
const ROLES: Record<Exclude<Role, "bold" | "dim">, { readonly hex: string; readonly basic: number }> = {
  accent: { hex: THEME.accent, basic: 35 },
  muted: { hex: THEME.muted, basic: 90 },
  success: { hex: THEME.success, basic: 32 },
  warning: { hex: THEME.warning, basic: 33 },
  danger: { hex: THEME.danger, basic: 31 },
  error: { hex: "#d946ef", basic: 95 },
};

function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
}

/** Applies roles to text, or returns it unchanged when colour is off. */
export interface Styler {
  readonly enabled: boolean;
  paint(text: string, ...roles: Role[]): string;
  /** ` LABEL ` on a background in the role's colour; the bare label when colour is off. */
  badge(label: string, role: BadgeRole): string;
}

/** The roles a badge's background can take. */
export type BadgeRole = "success" | "danger" | "warning" | "error";

/** Black ink on the light backgrounds (green, yellow), white on the dark ones (red, magenta). */
const BADGE_DARK_INK: Record<BadgeRole, boolean> = { success: true, warning: true, danger: false, error: false };
/** The 256-colour backgrounds nearest the brand colours. */
const BADGE_256: Record<BadgeRole, number> = { success: 41, warning: 214, danger: 203, error: 171 };
const BADGE_16: Record<BadgeRole, number> = { success: 42, warning: 43, danger: 41, error: 45 };

/**
 * The SGR parameters of a badge. The ink is given exactly (24-bit or 256-colour
 * black and white), never as a bold colour of the 16: a terminal that draws bold
 * text in bright colours (VS Code and iTerm2 by default) turns bold black into
 * grey, which melts into a green or yellow background. On a 16-colour terminal
 * black ink is not bold, for the same reason.
 */
function badgeParams(role: BadgeRole, depth: ColorDepth): string {
  const dark = BADGE_DARK_INK[role];
  if (depth === 24) return `1;${dark ? "38;2;0;0;0" : "38;2;255;255;255"};48;2;${rgb(ROLES[role].hex)}`;
  if (depth === 256) return `1;${dark ? "38;5;16" : "38;5;231"};48;5;${BADGE_256[role]}`;
  return dark ? `30;${BADGE_16[role]}` : `1;97;${BADGE_16[role]}`;
}

/**
 * A styler. `depth` is the terminal's colour depth (`colorDepth`); `true` is
 * read as 24-bit, `false` or nothing as the 16 colours of every terminal.
 */
export function styler(enabled: boolean, depth: ColorDepth | boolean = 16): Styler {
  const bits: ColorDepth = depth === true ? 24 : depth === false ? 16 : depth;
  const truecolor = bits === 24;
  return {
    enabled,
    badge(label, role) {
      if (!enabled) return label;
      return `\u001b[${badgeParams(role, bits)}m ${label} \u001b[22;39;49m`;
    },
    paint(text, ...roles) {
      if (!enabled || roles.length === 0 || text === "") return text;
      let open = "";
      let close = "";
      for (const role of roles) {
        if (role === "bold" || role === "dim") {
          open += role === "bold" ? "\u001b[1m" : "\u001b[2m";
          close = `\u001b[22m${close}`;
          continue;
        }
        const { hex, basic } = ROLES[role];
        open += truecolor ? `\u001b[38;2;${rgb(hex)}m` : `\u001b[${basic}m`;
        close = `\u001b[39m${close}`;
      }
      return `${open}${text}${close}`;
    },
  };
}

/** The SGR sequences this module writes, and only those, for measuring a line. */
const SGR = /\u001b\[[0-9;]*m/g;

/** The width a line takes on screen: its length without the colour codes. */
export function visibleLength(text: string): number {
  return [...text.replace(SGR, "")].length;
}

/**
 * A check's status as a mark and a badge that agree (Najmi, 2026-11-20):
 * ✓ PASS, ✗ FAIL, ○ SKIP, ! ERROR (the check could not run). Text marks, not
 * emoji: an emoji takes two columns in many terminals and breaks the columns.
 */
export const MARKS = {
  PASS: { mark: "✓", markRole: "success", badge: "PASS", badgeRole: "success" },
  FAIL: { mark: "✗", markRole: "danger", badge: "FAIL", badgeRole: "danger" },
  SKIP: { mark: "○", markRole: "warning", badge: "SKIP", badgeRole: "warning" },
  ERROR: { mark: "!", markRole: "error", badge: "ERROR", badgeRole: "error" },
} as const satisfies Record<string, { mark: string; markRole: Role; badge: string; badgeRole: BadgeRole }>;

/** The spinner's frames, as the dashboard draws them, one every 80 ms. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const SPINNER_MS = 80;

/** "12ms" under a second, "6.82s" from a second on. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * `left` and `right` on one line, `right` flush with the width. A line that
 * does not fit keeps two spaces between them and runs over.
 */
export function spread(left: string, right: string, width: number): string {
  if (right === "") return left;
  const gap = Math.max(2, width - visibleLength(left) - visibleLength(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

/** Cuts plain text to `max` characters, ending in "…". */
export function truncate(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  if (max <= 1) return "…".slice(0, Math.max(0, max));
  return `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * Plain text wrapped to `width` columns, every line after `indent`. A word
 * longer than a line (a URL, a hash) is kept whole and runs over.
 */
export function wrap(text: string, width: number, indent: string): string[] {
  const room = Math.max(20, width - [...indent].length);
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter((part) => part !== "")) {
    if (current === "") current = word;
    else if ([...current].length + 1 + [...word].length <= room) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines.map((line) => `${indent}${line}`);
}

/**
 * The width lines are laid out to: one column less than the terminal's (a line
 * as wide as the screen makes some terminals start a new line), at most 100,
 * 80 when unknown.
 */
export function lineWidth(stream: StyleStream): number {
  const columns = stream.columns;
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) return 80;
  return Math.max(20, Math.min(100, Math.floor(columns) - 1));
}
