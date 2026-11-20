/**
 * X402-11, "Rejected Request Not Settled" (spec B7 as D-032 changed it).
 *
 * Wasit sends a valid payment, for the advertised terms exactly, with a request
 * the builder's config declares invalid (`endpoints[].reject`), then reads the
 * chain: the nonce of that payment's authorization must still be unused once
 * its expiration ledger has passed. The verdict comes from one read that asks
 * for that nonce and for X402-06's, which was used and must be found: a read
 * that cannot find X402-06's cannot show that ours is absent. The payer's
 * balance and the transfer events are second readings; when they disagree with
 * the nonce, there is no verdict.
 *
 * The wait (Najmi, 2026-11-16): a payment whose advertised lifetime
 * (`maxTimeoutSeconds`) is at most 300 s is waited out, with a hard stop 360 s
 * after it was sent; a longer one is not signed at all (it is read again on the
 * challenge the payment is signed from), and an authorization the client signs
 * to outlive it is not sent. A lifetime below 30 s is not signed either, and an
 * authorization with fewer than 3 ledgers left is not sent (2026-11-17).
 *
 * This file holds the parts that need no network: the rules, the reject
 * request's shape, the watch loop over a chain's reads, and the verdict. The
 * check itself, which pays, is in `simulator.ts` with the other payment checks.
 */

import { errored, skipped, type CheckResult } from "../check.js";
import { CheckSetupError } from "../errors.js";
import { sanitizeText } from "../sanitize.js";
import type { AuthorizationWatch, SignedAuthorization } from "./chains/types.js";

export const REJECTED_REQUEST_ID = "X402-11";
export const REJECTED_REQUEST_NAME = "Rejected Request Not Settled";

/** The longest advertised lifetime X402-11 waits out on a test network. */
export const REJECTED_REQUEST_MAX_LIFETIME_SECONDS = 300;

/**
 * The shortest advertised lifetime X402-11 signs for (Najmi, 2026-11-17,
 * screening S-1): a payment valid for a few seconds can expire before a service
 * that settles it has it on chain, and its unused authorization would then show
 * nothing about the service.
 */
export const REJECTED_REQUEST_MIN_LIFETIME_SECONDS = 30;

/** The fewest units of validity a signed authorization must have left when X402-11 sends it. */
export const REJECTED_REQUEST_MIN_UNITS_LEFT = 3;

/**
 * How long after the payment is sent the watch stops, whatever the lifetime:
 * a 300 s lifetime is 60 ledgers of 5 s, and the verdict needs the ledger
 * after it, so about 305 s; the rest is slack for a slow ledger or RPC.
 */
export const REJECTED_REQUEST_HARD_STOP_MS = 360_000;

let hardStopForTesting: number | undefined;

/**
 * Tests only: a shorter hard stop, so "still valid when the watch stopped" can
 * be shown without a six-minute test. It can only lower the stop. Not exported
 * from the package index; no flag, setting or tool argument reaches it.
 */
export function setRejectedRequestHardStopForTesting(ms: number | undefined): void {
  hardStopForTesting = ms;
}

export function rejectedRequestHardStopMs(): number {
  return hardStopForTesting === undefined
    ? REJECTED_REQUEST_HARD_STOP_MS
    : Math.min(hardStopForTesting, REJECTED_REQUEST_HARD_STOP_MS);
}

/** The request the service must refuse, as the config gives it (`ResolvedReject`). */
export interface RejectCase {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Serialised, as `ResolvedReject` holds it. */
  readonly body?: string;
  readonly note?: string;
}

interface Shape {
  readonly method?: string;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

const BODYLESS = new Set(["GET", "HEAD"]);

/**
 * The endpoint's own request with the reject case over it: its method when it
 * names one, its headers over the endpoint's (by name, ignoring case), and its
 * body instead of the endpoint's. A method that carries no body drops the
 * endpoint's body; the config already refuses a reject body on such a method.
 */
export function rejectRequestShape(shape: Shape, reject: RejectCase): Shape {
  const method = (reject.method ?? shape.method ?? "GET").toUpperCase();
  const replaced = new Set(Object.keys(reject.headers ?? {}).map((name) => name.toLowerCase()));
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(shape.headers ?? {})) {
    if (!replaced.has(name.toLowerCase())) headers[name] = value;
  }
  Object.assign(headers, reject.headers ?? {});
  const body = reject.body !== undefined ? reject.body : BODYLESS.has(method) ? undefined : shape.body;
  return {
    method,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  };
}

/** What the watch found, from the chain's reads only. */
export type WatchOutcome =
  /** The chain records the authorization as used, in `ledger`. */
  | { readonly kind: "used"; readonly ledger: number; readonly latest: number }
  /** A read at `latest`, past the expiration ledger, found it unused, and found the control. */
  | { readonly kind: "unused"; readonly latest: number }
  /** The hard stop came first: at `latest` it was unused and could still be used. */
  | { readonly kind: "still-valid"; readonly latest: number }
  /** The chain could not be read to the end, or its answer could not be trusted: `why`. */
  | { readonly kind: "unread"; readonly why: string };

function message(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
}

class ReadTimedOut extends Error {}

/** `promise`, or `ReadTimedOut` once `ms` have passed (at once when `ms` is 0 or less). */
function withinMs<T>(promise: Promise<T>, ms: number): Promise<T> {
  // A read that answers after the stop is ignored, and its failure too.
  promise.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ReadTimedOut()), Math.max(0, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface WatchInput {
  readonly watch: AuthorizationWatch;
  readonly network: string;
  readonly rpcUrl: string;
  readonly ours: SignedAuthorization;
  /** X402-06's authorization, which was used: every read must find it. */
  readonly control: SignedAuthorization;
  /** When the payment was sent (ms since the epoch): the hard stop counts from it. */
  readonly sentAt: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Reads the chain once a ledger until the authorization is used, or a read
 * past its expiration ledger finds it unused, or the hard stop comes. Every
 * read asks for the control too; one that does not return it ends the watch
 * with no reading. Never throws: a failed read is an `unread` outcome.
 */
export async function watchAuthorization(input: WatchInput): Promise<WatchOutcome> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const stop = input.sentAt + rejectedRequestHardStopMs();
  for (;;) {
    let read;
    try {
      // A read that has not answered by the hard stop ends the watch there: the
      // stop holds while a read is in flight, not only between reads.
      read = await withinMs(input.watch.read(input.network, input.rpcUrl, [input.ours, input.control]), stop - now());
    } catch (error) {
      if (error instanceof ReadTimedOut) {
        return {
          kind: "unread",
          why: `the chain did not answer a read before the watch's hard stop, ${Math.round(rejectedRequestHardStopMs() / 1000)} s after the payment was sent`,
        };
      }
      return { kind: "unread", why: `the chain read failed: ${message(error)}` };
    }
    if (read.used[1] === undefined) {
      return {
        kind: "unread",
        why: "the chain's answer left out X402-06's authorization, which was used, so it cannot show that this one was not",
      };
    }
    const usedAt = read.used[0];
    if (usedAt !== undefined) return { kind: "used", ledger: usedAt, latest: read.latest };
    if (read.latest > input.ours.expiresAt) return { kind: "unused", latest: read.latest };
    const left = stop - now();
    if (left <= 0) return { kind: "still-valid", latest: read.latest };
    await sleep(Math.max(1, Math.min(input.watch.unitMs, left)));
  }
}

export interface RejectedRequestEvidence {
  /** What the service answered the paid invalid request with. */
  readonly status: number;
  readonly reason?: string;
  /** Base units, as signed: the advertised amount. */
  readonly amount: bigint;
  /** The expiration ledger, decoded from the signed authorization. */
  readonly expiresAt: number;
  /** "ledger". */
  readonly unit: string;
  readonly watch: WatchOutcome;
  /** The payer's balance before signing and after the watch. Missing: not read. */
  readonly balance?: { readonly before: bigint; readonly after: bigint };
  /** Transfers of exactly `amount` from the payer to `payTo` recorded after the payment was sent. Missing: not read. */
  readonly transfers?: readonly { readonly reference: string; readonly ledger: number }[];
}

function refusal(status: number, reason: string | undefined): string {
  return reason === undefined ? `HTTP ${status}` : `HTTP ${status}: ${reason}`;
}

/** Why the second readings do not support "taken", or undefined when they do. */
function notTaken(evidence: RejectedRequestEvidence): string | undefined {
  const { balance, transfers, amount } = evidence;
  if (balance === undefined || transfers === undefined) return "the payer's balance or the transfer events were not read";
  const fell = balance.before - balance.after;
  if (transfers.length === 0) return `no transfer of ${amount} base units from the payer to payTo was recorded`;
  if (fell < amount) return `the payer's balance fell by ${fell} base units, less than the ${amount} paid`;
  return undefined;
}

/** Why the second readings do not support "not taken", or undefined when they do. */
function notUntaken(evidence: RejectedRequestEvidence): string | undefined {
  const { balance, transfers, amount } = evidence;
  if (balance === undefined || transfers === undefined) return "the payer's balance or the transfer events were not read";
  const fell = balance.before - balance.after;
  if (transfers.length > 0) {
    return `a transfer of ${amount} base units from the payer to payTo was recorded (${transfers.map((item) => item.reference).join(", ")})`;
  }
  if (fell >= amount) return `the payer's balance fell by ${fell} base units, at least the ${amount} paid`;
  return undefined;
}

const SERVED_HINT =
  "Refuse an invalid request before its payment is settled. The official x402 Express middleware does not settle " +
  "when the handler answers 400 or above; a route that serves every request it is paid for sells what it should refuse.";

const TAKEN_HINT =
  "A refused request must not cost the payer: settle a payment only after the request has been accepted. The " +
  "official x402 Express middleware does not settle when the handler answers 400 or above; code that settles " +
  "before validating the request, or settles on its own, takes the payment for a request it then refuses.";

/**
 * X402-11's verdict from what the service answered and what the chain shows.
 *
 * - served (2xx): FAIL, whatever the chain shows; the chain only adds whether it settled.
 * - refused, used, the second readings agree: FAIL, the payment was taken.
 * - refused, unused past the expiry, the second readings agree: PASS.
 * - refused and still valid at the hard stop: SKIP, "not settled by ledger N; still valid until ledger M".
 * - anything else (a reading that disagrees or is missing, a read that failed): no verdict, never PASS.
 */
export function rejectedRequestVerdict(evidence: RejectedRequestEvidence): CheckResult {
  const id = REJECTED_REQUEST_ID;
  const name = REJECTED_REQUEST_NAME;
  const { watch, unit, expiresAt, amount, status } = evidence;
  const served = status >= 200 && status < 300;

  if (served) {
    let note: string;
    if (watch.kind === "used") {
      const why = notTaken(evidence);
      note =
        why === undefined
          ? ` The payment was taken: ${evidence.transfers!.map((item) => `${item.reference} (${unit} ${item.ledger})`).join(", ")}.`
          : ` The chain records its authorization as used (${unit} ${watch.ledger}), but ${why}, so whether it was taken is not stated.`;
    } else if (watch.kind === "unused") {
      const why = notUntaken(evidence);
      note =
        why === undefined
          ? ` The payment did not settle: its authorization expired at ${unit} ${expiresAt} unused.`
          : ` Whether the payment settled is not stated: the chain records its authorization as unused, but ${why}.`;
    } else if (watch.kind === "still-valid") {
      note = ` Whether the payment settled is not known: it was still valid at ${unit} ${watch.latest}, until ${unit} ${expiresAt}, when Wasit stopped waiting.`;
    } else {
      note = ` Whether the payment settled was not read: ${watch.why}.`;
    }
    return {
      id,
      name,
      pass: false,
      detail: `A request the config declares invalid was served (HTTP ${status}) with a valid payment for ${amount} base units.${note}`,
      hint: SERVED_HINT,
      expected: "the invalid request refused",
      actual: `HTTP ${status}`,
    };
  }

  const refused = `The request the config declares invalid was refused (${refusal(status, evidence.reason)})`;
  const noVerdict = (text: string): CheckResult => errored(id, name, new CheckSetupError(text));

  switch (watch.kind) {
    case "used": {
      const why = notTaken(evidence);
      if (why !== undefined) {
        return noVerdict(
          `${refused}. The chain records this payment's authorization as used (${unit} ${watch.ledger}), but ${why}, ` +
            `so the readings disagree and there is no verdict.`,
        );
      }
      const where = evidence.transfers!.map((item) => `${item.reference} (${unit} ${item.ledger})`).join(", ");
      return {
        id,
        name,
        pass: false,
        detail:
          `${refused} and the payment was taken: ${amount} base units moved from the payer to payTo in ${where}; ` +
          `the chain records its authorization as used.`,
        hint: TAKEN_HINT,
        expected: "a refused request leaves its payment unsettled",
        actual: `the payment settled (${unit} ${watch.ledger})`,
      };
    }
    case "unused": {
      const why = notUntaken(evidence);
      if (why !== undefined) {
        return noVerdict(
          `${refused}. The chain records this payment's authorization as unused past its expiry (${unit} ${expiresAt}), ` +
            `but ${why}, so the readings disagree and there is no verdict.`,
        );
      }
      return {
        id,
        name,
        pass: true,
        detail:
          `${refused}, and the payment was not taken: its authorization expired at ${unit} ${expiresAt} unused ` +
          `(read at ${unit} ${watch.latest}, in the same read that found X402-06's used authorization); no transfer ` +
          `of it to payTo was recorded, and the payer's balance did not fall by it.`,
      };
    }
    case "still-valid":
      return skipped(
        id,
        name,
        `the request was refused (${refusal(status, evidence.reason)}), and its payment was not settled by ${unit} ` +
          `${watch.latest}; still valid until ${unit} ${expiresAt} when Wasit stopped waiting (at most ` +
          `${REJECTED_REQUEST_HARD_STOP_MS / 1000} s on a test network), so whether it settles is not known.`,
      );
    case "unread":
      return noVerdict(
        `${refused}, but the chain was not read to the end of the payment's validity (${watch.why}), so whether it ` +
          `settled is not known.`,
      );
  }
}
