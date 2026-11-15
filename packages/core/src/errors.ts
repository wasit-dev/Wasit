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

import { sanitizeText } from "./sanitize.js";

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

/**
 * The target answered with a redirect that Wasit will not follow, or will not
 * follow again. Nothing is learned about the target's conformance, only that the
 * route does not stay inside the origin the run was pointed at.
 */
export class RedirectRefusedError extends ConfigurationError {
  public constructor(message: string) {
    super(message);
    this.name = "RedirectRefusedError";
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

/** How `fetchTarget` treats a redirect. */
export interface FetchTargetOptions {
  /**
   * `"never"` (the default): one request, and a redirect answer is refused
   * with a {@link RedirectRefusedError}; nothing is sent to its Location. Every
   * request that carries a payment uses it (D-022c): `fetch` would keep a
   * header such as `PAYMENT-SIGNATURE` on the way, and deliver the signed
   * payment to a second URL that can settle it while the check grades the
   * first. Being the default, a call that forgets to choose cannot leak one.
   * `"same-origin"` is the rule for the read-only tier: a redirect inside the
   * origin of `target` is followed once, anything else is refused and nothing
   * is sent to the other origin.
   */
  readonly redirects?: "never" | "same-origin";
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Request-body headers that must not outlive a redirect that drops the body. */
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"];

/** The origin of a URL for a message: http(s) origins only, never a path, query or credentials. */
function describeOrigin(url: URL): string {
  return url.protocol === "http:" || url.protocol === "https:" ? url.origin : `a ${url.protocol} URL`;
}

/**
 * Where a response sends the request next, or undefined when it is not a
 * redirect. A 3xx without a `Location` (or a 300 or 304) is not a redirect to
 * follow: it is returned as the answer, and the check reports its status.
 */
function redirectLocation(response: Response, from: URL): URL | undefined {
  const location = response.headers.get("location");
  if (!REDIRECT_STATUSES.has(response.status) || location === null) return undefined;

  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    throw new RedirectRefusedError(
      `The route answers ${response.status} with a Location that is not a valid URL, so ` +
        `Wasit did not follow it.`,
    );
  }
  if (next.username !== "" || next.password !== "") {
    throw new RedirectRefusedError(
      `The route redirects to a URL that carries credentials, so Wasit did not follow it.`,
    );
  }
  return next;
}

/** Whether fetch would turn the request into a GET on this redirect: a POST on 301 to 303, any non-HEAD on 303. */
function redirectBecomesGet(init: RequestInit | undefined, status: number): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  return (
    (status === 303 && method !== "GET" && method !== "HEAD") ||
    ((status === 301 || status === 302) && method === "POST")
  );
}

/** The request a redirect leads to: a POST on 301 to 303, and any non-HEAD on 303, becomes a GET without a body. */
function redirectedInit(init: RequestInit | undefined, status: number): RequestInit {
  if (!redirectBecomesGet(init, status)) return init ?? {};

  const { body: _body, headers, ...rest } = init ?? {};
  const kept = new Headers(headers);
  for (const name of BODY_HEADERS) kept.delete(name);
  return { ...rest, method: "GET", headers: kept };
}

/** One request, never following a redirect, with the same "never connected" wrapping as `fetchTarget`. */
async function fetchOnce(target: string, init: RequestInit | undefined): Promise<Response> {
  try {
    return await baseFetch()(target, { ...init, redirect: "manual" });
  } catch (error) {
    throw new TargetUnreachableError(target, error);
  }
}

/** Frees the connection of a response whose body nobody will read. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection is closed either way.
  }
}

/**
 * The same-origin rule: follow one redirect inside the origin, refuse any other.
 *
 * A second redirect is refused even when it stays inside the origin: a chain
 * is not something a paywall needs, and a loop must end.
 */
async function followSameOrigin(
  target: string,
  init: RequestInit | undefined,
  keepRequest: boolean,
): Promise<{ readonly response: Response; readonly url: string }> {
  const from = new URL(target);
  const first = await fetchOnce(target, init);
  const next = redirectLocation(first, from);
  if (next === undefined) return { response: first, url: target };
  await discard(first);

  if (next.origin !== from.origin || (next.protocol !== "http:" && next.protocol !== "https:")) {
    throw new RedirectRefusedError(
      `The route redirects to ${sanitizeText(describeOrigin(next))}, which is not the origin ` +
        `${sanitizeText(from.origin)} this run was pointed at. Wasit did not follow it. ` +
        `Point the run at the URL the redirect leads to, if that is the service you operate.`,
    );
  }
  if (keepRequest && redirectBecomesGet(init, first.status)) {
    throw new RedirectRefusedError(
      `The route answers ${first.status} with a redirect that turns this ` +
        `${(init?.method ?? "GET").toUpperCase()} into a GET. Wasit pays only where the request ` +
        `arrives unchanged, so it did not follow it and nothing was paid. Point the run at the ` +
        `URL the route answers on.`,
    );
  }

  const second = await fetchOnce(next.href, redirectedInit(init, first.status));
  const again = redirectLocation(second, next);
  if (again === undefined) return { response: second, url: next.href };
  await discard(second);
  throw new RedirectRefusedError(
    again.origin === from.origin
      ? `The route answers with more than one redirect (${first.status}, then ${second.status}). ` +
          `Wasit follows one redirect inside the origin and did not follow the second.`
      : `The route redirects to ${sanitizeText(describeOrigin(again))} after one redirect inside ` +
          `${sanitizeText(from.origin)}. Wasit did not follow it.`,
  );
}

/** Refuses `response` when it is a redirect, after freeing its connection; returns it otherwise. */
async function refuseRedirect(response: Response, from: URL): Promise<Response> {
  const next = redirectLocation(response, from);
  if (next === undefined) return response;
  await discard(response);
  throw new RedirectRefusedError(
    `The route answers ${response.status} with a redirect to ` +
      `${sanitizeText(describeOrigin(next))}. Wasit does not follow a redirect on a request that ` +
      `pays, so nothing was sent there and the payment was not sent again. Point the run at the ` +
      `URL the route answers on.`,
  );
}

/**
 * The unpaid request a payment check reads its fresh challenge from, and the
 * URL the payment is then sent to (D-022c).
 *
 * One redirect inside the origin is followed, as the read-only tier does, but
 * only when it keeps the request: a POST that a 301, 302 or 303 turns into a
 * GET would have the payment signed for one request and sent with another. The
 * payment goes to `url`, with redirects refused ({@link fetchTarget}'s default).
 */
export async function fetchPaymentChallenge(
  target: string,
  init: RequestInit | undefined,
): Promise<{ readonly response: Response; readonly url: string }> {
  assertHttpUrl(target);
  return followSameOrigin(target, init, true);
}

/**
 * A `fetch` that never follows a redirect, for a payment client that makes
 * its own requests (mppx): every request it makes refuses a redirect answer.
 * MPP pays at the URL it read the challenge from, so a route that redirects
 * gets no verdict rather than a payment delivered to a second URL.
 */
export const fetchWithoutRedirects: typeof fetch = async (input, init) => {
  const target = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
  assertHttpUrl(target);
  let response: Response;
  try {
    response = await baseFetch()(input, { ...init, redirect: "manual" });
  } catch (error) {
    throw new TargetUnreachableError(target, error);
  }
  return refuseRedirect(response, new URL(target));
};

export async function fetchTarget(
  target: string,
  init?: Parameters<typeof fetch>[1],
  options?: FetchTargetOptions,
): Promise<Awaited<ReturnType<typeof fetch>>> {
  assertHttpUrl(target);

  if (options?.redirects === "same-origin") return (await followSameOrigin(target, init, false)).response;

  return refuseRedirect(await fetchOnce(target, init), new URL(target));
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
