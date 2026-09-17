/**
 * Error taxonomy for conformance checks.
 *
 * The distinction that matters to an operator is whether a check produced a
 * verdict about the target at all. A malformed response IS a verdict: the
 * service answered, and what it answered did not conform. An unreachable host,
 * a bad RPC endpoint, or a misconfigured run produce no verdict, and reporting
 * those as conformance failures tells an operator their service is broken when
 * it may be perfectly correct.
 *
 * Errors are classified where they are thrown, not where they are caught.
 * Third-party throw sites (the mppx challenge parser, the Stellar SDK) have no
 * documented error types, so sniffing at the catch site would be guesswork;
 * the call site knows what it was doing and wraps accordingly.
 */

/** Why a check could not produce a verdict about the target. */
export type CheckErrorKind =
  | "unreachable"
  | "configuration"
  | "harness"
  | "setup";

/** A check that did not run. Never a statement about the target's conformance. */
export interface CheckError {
  readonly kind: CheckErrorKind;
  readonly message: string;
  /** Transport-level code, when one was recoverable, e.g. "ECONNREFUSED". */
  readonly code?: string;
}

/** A check that ran: the target answered, and the answer was wrong. */
export interface MalformedResponseFinding {
  readonly kind: "malformed-response";
  readonly message: string;
}

export type ClassifiedError = CheckError | MalformedResponseFinding;

/**
 * The target was reached and replied, but the reply violates the spec.
 * This is a conformance finding, not an operational error.
 */
export class MalformedResponseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MalformedResponseError";
  }
}

/** The run itself is misconfigured. Nothing can be concluded about the target. */
export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * A precondition the check needed could not be established, so the check never
 * reached the rule it exists to test.
 *
 * Kept apart from a conformance failure deliberately. MPP channel checks must
 * first get one correctly advancing commitment accepted before they can probe
 * anything, and two very different worlds refuse that submission identically: a
 * target that wrongly rejects valid vouchers, and a channel whose cumulative
 * moved between the challenge being issued and the credential being submitted,
 * because something else is paying through it. Reporting the second as a defect
 * tells an operator their service is broken on the evidence of a busy channel.
 */
export class CheckSetupError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CheckSetupError";
  }
}

/** No HTTP conversation took place: the connection never succeeded. */
export class TargetUnreachableError extends Error {
  public readonly target: string;
  public readonly code: string | undefined;
  /** The original throw, kept for diagnostics without relying on Error.cause. */
  public readonly reason: unknown;

  public constructor(target: string, reason: unknown) {
    const code = connectionErrorCode(reason);
    const detail = reason instanceof Error ? reason.message : String(reason);
    super(`Could not connect to ${target}${code ? ` (${code})` : ""}: ${detail}`);
    this.name = "TargetUnreachableError";
    this.target = target;
    this.code = code;
    this.reason = reason;
  }
}

/**
 * Walks the cause chain for a transport error code.
 *
 * Node's fetch reports every transport failure as `TypeError: fetch failed`
 * and hangs the real error off `.cause`, which is where `ECONNREFUSED`,
 * `ENOTFOUND` and the TLS codes actually live.
 */
function connectionErrorCode(reason: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = reason;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string") return record.code;
    current = record.cause;
  }
  return undefined;
}

/**
 * Rejects anything that is not an absolute HTTP(S) URL.
 *
 * Exported because the suite validates the target once up front: a bad URL is
 * wrong for every check, and reporting it per check buries the one real cause
 * under N identical copies.
 */
export function assertHttpUrl(target: string): void {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new ConfigurationError(
      `"${target}" is not a valid absolute URL. Include the scheme, ` +
        `e.g. http://localhost:3003/data.`,
    );
  }

  // A bare host:port parses cleanly — "localhost:3003/data" becomes scheme
  // "localhost:" with path "3003/data" — so a valid-URL check alone lets it
  // through to fetch, where it resurfaces as a transport failure and gets
  // misreported as the target being unreachable.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError(
      `"${target}" is not an HTTP(S) URL — it parses with scheme ` +
        `"${url.protocol}". If you meant a local service, write the scheme ` +
        `explicitly, e.g. http://${target}.`,
    );
  }
}

/**
 * Performs a request against the target, distinguishing "never connected"
 * from every other failure. Use this instead of bare `fetch` for anything
 * addressed at the service under test.
 */
/**
 * The global symbol mppx tags its fetch wrappers with, so a wrapper can be
 * recognised across module instances and bundles.
 * See mppx/dist/client/internal/Fetch.js.
 */
const MPPX_FETCH_WRAPPER = Symbol.for("mppx.fetch.wrapper");

/**
 * Resolves the underlying fetch, stepping past any mppx payment wrapper
 * installed on `globalThis`.
 *
 * `Mppx.create` replaces `globalThis.fetch` with a wrapper bound to one
 * payment method unless `polyfill: false` is passed. A charge-mode client
 * created earlier in the process therefore makes every later 402 carrying a
 * different intent fail with "No method found for challenges", even though the
 * target is conformant. Checks must observe the target, never a payment client
 * some other check left behind, so this unwraps rather than trusting the global.
 */
function baseFetch(): typeof fetch {
  let current = globalThis.fetch as typeof fetch & {
    [MPPX_FETCH_WRAPPER]?: typeof fetch;
  };
  const seen = new Set<unknown>();
  while (current[MPPX_FETCH_WRAPPER] && !seen.has(current)) {
    seen.add(current);
    current = current[MPPX_FETCH_WRAPPER] as typeof current;
  }
  return current;
}

export async function fetchTarget(
  target: string,
  init?: Parameters<typeof fetch>[1],
): Promise<Awaited<ReturnType<typeof fetch>>> {
  assertHttpUrl(target);

  try {
    return await baseFetch()(target, init);
  } catch (error) {
    throw new TargetUnreachableError(target, error);
  }
}

/** Maps a thrown value onto the taxonomy. */
export function classifyCheckError(error: unknown): ClassifiedError {
  if (error instanceof MalformedResponseError) {
    return { kind: "malformed-response", message: error.message };
  }
  if (error instanceof TargetUnreachableError) {
    return {
      kind: "unreachable",
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    };
  }
  if (error instanceof ConfigurationError) {
    return { kind: "configuration", message: error.message };
  }
  if (error instanceof CheckSetupError) {
    return { kind: "setup", message: error.message };
  }
  return {
    kind: "harness",
    message: error instanceof Error ? error.message : String(error),
  };
}
