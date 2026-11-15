/**
 * What the scripts that talk to GitHub share. They run after the install step,
 * so they may use the built core: the sanitiser and the comment marker are the
 * CLI's own, not copies.
 */

import { sanitizeText } from "../../packages/core/dist/sanitize.js";

/** `owner/name`, as GitHub spells a repository. Nothing else is put into an API route. */
export const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** A whole number above zero, given as a number or as digits. */
export function positiveInteger(value) {
  const number = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/**
 * One line of text that came from GitHub or from gh, safe to print in a job log:
 * control characters out, a leading `::` broken, cut to `max`.
 */
export function oneLine(text, max = 200) {
  const line = sanitizeText(String(text)).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Runs `gh api <route>` and returns the parsed JSON, or throws an Error whose message is safe to print. */
export async function api(gh, route) {
  const result = await gh(["api", route]);
  if (result.code !== 0) throw new Error(`gh api ${oneLine(route, 80)} failed: ${oneLine(result.stderr || result.stdout)}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`gh api ${oneLine(route, 80)} did not answer with JSON`);
  }
}
