/**
 * The one sanitiser. Everything Wasit prints, writes into a report, or puts in
 * a pull request comment or job summary passes through here when it can carry
 * text a service chose.
 *
 * A service answers with whatever it likes, and a pull request can change what
 * that is. Two sinks are dangerous:
 *
 * - a terminal or a CI job log: control characters move the cursor or hide
 *   text, and a line that starts with `::` is a workflow command to the
 *   GitHub runner (set an output, add a mask, stop all commands);
 * - a Markdown comment: HTML, links, mentions and table syntax change what the
 *   reader sees and who gets notified.
 *
 * `sanitizeText` is the plain level for the first, `sanitizeForMarkdown` adds
 * the second. Neither is a security boundary on its own against a renderer
 * Wasit does not control; they make the common attacks inert and are tested
 * against the CommonMark rules, not against GitHub's renderer.
 */

/** The longest a service-supplied value may be in a comment or summary. */
export const MARKDOWN_VALUE_MAX = 300;

/** What replaces a secret, or a value that looks like one. */
const REDACTED = "[redacted]";

/** A redact entry shorter than this would blank ordinary words, and is not a secret. */
const MIN_REDACT_LENGTH = 4;

/**
 * C0 controls except tab (U+0009) and newline (U+000A), DEL, C1 controls, and
 * the bidirectional overrides that make text read in another order than it is
 * stored. A carriage return is stripped too: .NET readers, the GitHub runner
 * among them, split lines on it, so it could start a line of its own.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** The shape of a Stellar secret key. Public keys, contract ids and hashes do not match. */
const STELLAR_SECRET = /S[A-Z2-7]{55}/g;

/**
 * A line the GitHub runner reads as a command: `::name::`, or the older
 * `##[name]`. The runner trims leading whitespace first, and .NET counts more
 * characters as whitespace than a space and a tab, so any whitespace but the
 * line break is allowed before it.
 */
const LINE_START_COMMAND = /^([^\S\n]*)(::|##\[)/gm;

export interface SanitizeOptions {
  /**
   * Values that must never appear in the output, such as the value of a
   * `WASIT_HEADER_*` variable or a payer key. Matched as literals, after
   * control characters are stripped, so a control character cannot hide one.
   */
  readonly redact?: readonly string[];
}

export interface MarkdownOptions extends SanitizeOptions {
  /** Longest value, in characters, ellipsis included. Default {@link MARKDOWN_VALUE_MAX}. */
  readonly maxLength?: number;
}

/**
 * Plain level, for the terminal, the job log and report text.
 *
 * Strips control characters (keeping newline and tab), masks secrets, and
 * breaks a `::` or `##[` at the start of a line by putting a space inside it.
 * Idempotent. Newlines stay: this level does not reflow text.
 */
export function sanitizeText(input: string, options: SanitizeOptions = {}): string {
  let text = String(input).replace(CONTROL_CHARACTERS, "");

  const secrets = [...(options.redact ?? [])]
    .filter((secret) => secret.length >= MIN_REDACT_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.split(secret).join(REDACTED);

  return text
    .replace(STELLAR_SECRET, REDACTED)
    .replace(LINE_START_COMMAND, (_match, space: string, command: string) =>
      space + (command === "::" ? ": :" : "# #["),
    );
}

/** A link a Markdown renderer would make clickable: a scheme with an authority, `www.`, mailto and xmpp. */
const LINK = /\b[a-z][a-z0-9+.-]*:\/\/\S*|\b(?:www\.|mailto:|xmpp:)\S*/gi;

/** `#123` and `owner/repo#123`: GitHub turns both into links, the second one on another repository. */
const ISSUE_REFERENCE = /(?:[\w.-]+\/[\w.-]+)?#\d+/g;

/** An `@` that GitHub would read as the start of a mention. */
const MENTION = /@(?=[A-Za-z0-9_])/g;

const LINK_REMOVED = "[link removed]";

/** Cuts to `max` characters, counting code points, with an ellipsis in the last place. */
function truncate(text: string, max: number): string {
  const characters = Array.from(text);
  if (characters.length <= max) return text;
  return `${characters.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/**
 * Backslash-escapes what could still format text inside a cell or a line, and
 * HTML-escapes the rest. Newlines are already gone, so only the start of the
 * string can open a heading, a list or a block quote.
 */
function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\`*_~[\]()|]/g, "\\$&")
    .replace(/^([-+=#])/, "\\$1")
    .replace(/^(\d+)\./, "$1\\.")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Markdown level, for a value placed in a pull request comment or job summary.
 *
 * Returns one line: the plain level first, then whitespace (newlines too)
 * collapsed so the value cannot open a heading, list or table row; links,
 * issue references and mentions removed; the value cut to `maxLength`
 * characters (300 by default); then Markdown and HTML escaped. The cut comes
 * before the escaping, so an escape or an entity is never split. Not
 * idempotent: apply it once, to text that has only had the plain level.
 */
export function sanitizeForMarkdown(input: string, options: MarkdownOptions = {}): string {
  const max = Math.max(1, Math.floor(options.maxLength ?? MARKDOWN_VALUE_MAX));
  const plain = sanitizeText(input, options).replace(/\s+/g, " ").trim();
  const stripped = plain
    .replace(LINK, LINK_REMOVED)
    .replace(ISSUE_REFERENCE, LINK_REMOVED)
    .replace(MENTION, "[at]");
  return escapeMarkdown(truncate(stripped, max));
}
