import { errored, quoteValue, skipped, type CheckResult } from "../check.js";
import {
  CheckSetupError,
  ConfigurationError,
  MalformedResponseError,
  assertHttpUrl,
  fetchPaymentChallenge,
  fetchTarget,
} from "../errors.js";
import {
  PER_PAYMENT_CAP_USD,
  PaymentGuardRefusedError,
  RunBudget,
  assertPinned,
  sameAddress,
  type PinTerms,
} from "../guard/budget.js";
import { assertPaymentNetworkAllowed } from "../guard/networks.js";
import { assertRpcServesNetwork } from "../guard/rpc-identity.js";
import type { EndpointPlan } from "./plan.js";
import {
  REJECTED_REQUEST_ID,
  REJECTED_REQUEST_MAX_LIFETIME_SECONDS,
  REJECTED_REQUEST_MIN_LIFETIME_SECONDS,
  REJECTED_REQUEST_MIN_UNITS_LEFT,
  REJECTED_REQUEST_NAME,
  rejectRequestShape,
  rejectedRequestHardStopMs,
  rejectedRequestVerdict,
  watchAuthorization,
  type RejectCase,
  type WatchOutcome,
} from "./rejected-request.js";
import { sanitizeText } from "../sanitize.js";
import { checkNetworkIdentifier, checkRequiredFields } from "./requirements.js";

export type { CheckResult };

/**
 * How to address the target's paid endpoint.
 *
 * A paid x402 endpoint is not necessarily a GET. An endpoint that computes
 * something for the caller naturally takes a POST with a body, and real
 * services expose only that. Issuing the wrong verb draws a 404 and produces a
 * report claiming the service never answers 402 — a false finding about a
 * conformant service, which is the worst thing a conformance tester can emit.
 */
export interface RequestShape {
  /** HTTP method. Defaults to GET. */
  readonly method?: string;
  /** Raw request body, sent verbatim. Not permitted with GET or HEAD. */
  readonly body?: string;
  /** Headers the endpoint needs before it will issue a challenge at all. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface X402SimulatorOptions extends RequestShape {
  target: string;
  /**
   * Called once per check as soon as its result is known, in addition to it
   * being included in the returned array — lets a caller render progress
   * live instead of waiting for the whole suite to finish. Optional and has
   * no effect on what is returned.
   */
  readonly onResult?: (result: CheckResult) => void;
}

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const KNOWN_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

/**
 * Validates a request shape and turns it into fetch init.
 *
 * A bad method, or a body on a verb that cannot carry one, is a configuration
 * error rather than a finding: nothing has been learned about the target.
 */
function buildInit(shape: RequestShape): RequestInit {
  const method = (shape.method ?? "GET").toUpperCase();

  if (!KNOWN_METHODS.has(method)) {
    throw new ConfigurationError(
      `"${shape.method}" is not an HTTP method. Expected one of ` +
        `${[...KNOWN_METHODS].join(", ")}.`,
    );
  }

  if (shape.body !== undefined && BODYLESS_METHODS.has(method)) {
    throw new ConfigurationError(
      `A request body cannot be sent with ${method}. Name the method the ` +
        `endpoint actually uses, e.g. --method POST.`,
    );
  }

  const headers: Record<string, string> = { ...(shape.headers ?? {}) };

  // An endpoint that takes a body almost always parses it as JSON and rejects
  // anything arriving without a content type. Defaulted rather than required,
  // and overridable by naming the header explicitly.
  if (
    shape.body !== undefined &&
    !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")
  ) {
    headers["Content-Type"] = "application/json";
  }

  return {
    method,
    ...(shape.body !== undefined ? { body: shape.body } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

/**
 * Adds the x402 payment header to the caller's own request shape.
 *
 * The payment header wins on collision: a caller-supplied header of the same
 * name would silently invalidate the payment being tested.
 */
function withPaymentHeaders(
  shape: RequestShape,
  paymentHeaders: Record<string, string>,
): RequestInit {
  const init = buildInit(shape);
  return {
    ...init,
    headers: { ...((init.headers as Record<string, string>) ?? {}), ...paymentHeaders },
  };
}

/**
 * The read-only checks, in catalogue order.
 *
 * Order is load-bearing: each check inspects something the previous one
 * produced, so when one fails the rest have nothing to inspect. They are
 * skipped rather than failed — a check that never ran is not a defect in the
 * target, and reporting one broken challenge as five separate findings tells
 * an operator their service is five times more broken than it is.
 */
const READ_CHECKS: ReadonlyArray<readonly [string, string]> = [
  ["X402-01", "402 Response Status"],
  ["X402-02", "Payment Header Present"],
  ["X402-03", "Header Payload Decodable"],
  ["X402-04", "Required Fields Present"],
  ["X402-05", "Network Identifier Valid"],
];

/** What a wrong status on an unpaid request usually means, and what to do. */
function statusHint(status: number): string {
  if (status >= 200 && status < 300) {
    return (
      `The route served HTTP ${status} without payment: put the x402 payment ` +
      `middleware in front of it, so unpaid requests get 402 and a challenge.`
    );
  }
  if (status === 401 || status === 403) {
    return (
      `Answer an unpaid request with 402, not ${status}: authentication errors ` +
      `and payment challenges are different signals, and x402 clients act only on 402.`
    );
  }
  if (status === 404 || status === 405) {
    return (
      `A ${status} usually means the wrong path or method. Check the URL, and ` +
      `pass the method the endpoint uses (--method POST, MCP \`method\`).`
    );
  }
  return "Answer an unpaid request with 402 Payment Required and the challenge in a PAYMENT-REQUIRED header.";
}

/** Skips every check after `id`, naming the one cause they all depend on. */
function skipAfter(id: string, reason: string): CheckResult[] {
  const index = READ_CHECKS.findIndex(([candidate]) => candidate === id);
  return READ_CHECKS.slice(index + 1).map(([checkId, name]) =>
    skipped(checkId, name, reason, "dependency"),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads an x402 v1 challenge from a 402 response body, if that is what it is.
 *
 * Returns the parsed body only when it declares `x402Version: 1` and carries an
 * `accepts` array, the v1 HTTP transport's `PaymentRequirementsResponse`. Any
 * other body, including a v2 payload misplaced into the body, is not treated
 * as a challenge.
 */
export function readV1BodyChallenge(body: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  return record?.["x402Version"] === 1 && Array.isArray(record["accepts"]) ? record : undefined;
}

/** What a header that did not decode to JSON held, quoted. The service chose it; the sinks cut it. */
function decodedStart(headerValue: string): string {
  const decoded = Buffer.from(headerValue, "base64").toString("utf-8");
  return decoded === "" ? "an empty value" : `a value that starts with ${quoteValue(decoded)}`;
}

/** A body that cannot be read is simply not a v1 challenge. */
async function readText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Why an x402 v1 challenge is not graded: the reason on X402-02..05 and on the
 * endpoint. Kept under 300 characters, the longest a value goes into a pull
 * request comment, so the way to get graded is not cut off.
 */
const V1_UNSUPPORTED_REASON =
  "the service sent an x402 v1 challenge in its response body. Wasit grades x402 v2, and the " +
  "`exact` scheme on Stellar exists for v2 only, so this endpoint is unsupported, not failed. " +
  "To have it graded, move to x402 v2: send the challenge base64-encoded in a PAYMENT-REQUIRED " +
  "response header.";

/** What a check found on a challenge Wasit does not grade, to be shown as a note. */
function noteOf(result: CheckResult): string {
  return result.skipped === true ? (result.skipReason ?? result.detail) : result.detail;
}

/**
 * Runs X402-01 through X402-05 against a target.
 *
 * Stops at the first failure whose consequence is that nothing downstream can
 * be evaluated, so one broken challenge produces one finding.
 */
export async function runX402ReadChecks(
  options: X402SimulatorOptions,
): Promise<CheckResult[]> {
  const { target } = options;

  // Reports each result to the caller's live-progress hook, if any, then
  // returns them unchanged — every return in this function goes through here.
  const emit = (results: CheckResult[]): CheckResult[] => {
    for (const result of results) options.onResult?.(result);
    return results;
  };

  // A bad URL or an unusable request shape is wrong for every check, so it is
  // reported once rather than five times over.
  let init: RequestInit;
  try {
    assertHttpUrl(target);
    init = buildInit(options);
  } catch (error) {
    return emit([errored("PREFLIGHT", "Run Preflight", error)]);
  }

  let response: Response;
  try {
    // The unpaid request of the read-only tier: a redirect to another origin
    // is reported and gives no verdict, never followed (spec A8 #5).
    response = await fetchTarget(target, init, { redirects: "same-origin" });
  } catch (error) {
    return emit([
      errored("X402-01", "402 Response Status", error),
      ...skipAfter(
        "X402-01",
        "the target was never reached, so it issued no challenge to inspect.",
      ),
    ]);
  }

  const statusPass = response.status === 402;
  const r1: CheckResult = {
    id: "X402-01",
    name: "402 Response Status",
    pass: statusPass,
    detail: statusPass
      ? "Server responded with 402 as required."
      : `Expected status 402, got ${response.status}.`,
    ...(statusPass
      ? {}
      : { hint: statusHint(response.status), expected: "status 402", actual: `status ${response.status}` }),
  };

  if (!statusPass) {
    return emit([
      r1,
      ...skipAfter(
        "X402-01",
        `the target answered ${response.status} rather than 402, so it issued ` +
          `no payment challenge to inspect.`,
      ),
    ]);
  }

  // Both names are checked because Stellar's own documentation is not yet
  // internally consistent — see docs/CHECKS.md.
  const headerValue =
    response.headers.get("PAYMENT-REQUIRED") ?? response.headers.get("X-Payment");

  // x402 v1 signals payment in the response body rather than a header, and the
  // `exact` scheme on Stellar is defined for v2 only. Wasit grades v2, so a v1
  // service is unsupported, not failed (spec A3): X402-02..05 are skipped with
  // that reason. The v1 terms are still read and reported as notes, so an
  // operator sees which of them diverge without being handed a verdict.
  const v1Payload =
    headerValue === null ? readV1BodyChallenge(await readText(response)) : undefined;
  if (headerValue === null && v1Payload !== undefined) {
    const notes = new Map<string, string>([
      ["X402-04", noteOf(checkRequiredFields(v1Payload))],
      ["X402-05", noteOf(checkNetworkIdentifier(v1Payload))],
    ]);
    return emit([
      r1,
      ...READ_CHECKS.slice(1).map(([id, name]) => {
        const skip = skipped(id, name, V1_UNSUPPORTED_REASON, "unsupported");
        const note = notes.get(id);
        return note === undefined ? skip : { ...skip, detail: `${skip.detail} Note, not a verdict: ${note}` };
      }),
    ]);
  }

  const r2: CheckResult = {
    id: "X402-02",
    name: "Payment Header Present",
    pass: headerValue !== null,
    detail:
      headerValue !== null
        ? "Payment header found."
        : "Neither PAYMENT-REQUIRED nor X-Payment header was present.",
    ...(headerValue !== null
      ? {}
      : {
          hint:
            "Send the challenge as base64-encoded JSON in a PAYMENT-REQUIRED " +
            "response header, as the x402 v2 HTTP transport defines.",
          expected: "a PAYMENT-REQUIRED header",
          actual: "no PAYMENT-REQUIRED or X-Payment header",
        }),
  };

  if (headerValue === null) {
    return emit([
      r1,
      r2,
      ...skipAfter(
        "X402-02",
        "the 402 response carried no payment header, so there is no payload " +
          "to decode or inspect.",
      ),
    ]);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(headerValue, "base64").toString("utf-8"));
  } catch (error) {
    return emit([
      r1,
      r2,
      {
        id: "X402-03",
        name: "Header Payload Decodable",
        pass: false,
        detail: `Failed to decode/parse: ${(error as Error).message}`,
        hint:
          "Base64-encode the JSON PaymentRequired object for the header; raw " +
          "JSON or a truncated value does not decode.",
        expected: "a base64 value that decodes to JSON",
        actual: decodedStart(headerValue),
      },
      ...skipAfter(
        "X402-03",
        "the payment header did not decode to JSON, so no payload was " +
          "available to inspect.",
      ),
    ]);
  }

  const r3: CheckResult = {
    id: "X402-03",
    name: "Header Payload Decodable",
    pass: true,
    detail: "Header decoded to valid JSON.",
  };

  return emit(
    [r3, r2, r1].reverse().concat([
      checkRequiredFields(payload),
      checkNetworkIdentifier(payload),
    ]),
  );
}

import { x402Client, x402HTTPClient } from "@x402/fetch";
import type { PaymentRequirements } from "@x402/core/types";

import { paymentChainFor, paymentNetworks, type PaymentChain } from "./chains/index.js";
import type { AlteredSigning } from "./chains/types.js";
import { stellarChain } from "./chains/stellar.js";

export { corruptAuthSignature } from "./chains/stellar.js";

export interface X402PaymentCheckOptions extends RequestShape {
  readonly target: string;
  readonly network: string;
  readonly payerSecretKey: string;
  /** Overrides the default RPC endpoint used to verify settlement. */
  readonly rpcUrl?: string;
  /** See {@link X402SimulatorOptions.onResult} — same contract. */
  readonly onResult?: (result: CheckResult) => void;
  /**
   * The run's budget, shared by every endpoint of one run. Without one, these
   * checks get their own: $5, of which they sign at most 3.5 times a $1 price.
   */
  readonly budget?: RunBudget;
  /** Every `exact` option on the run's network must pay this `payTo` in this asset. */
  readonly pin?: PinTerms;
  /** This endpoint's entry of the run's plan (L1): no signature beyond it. */
  readonly plan?: EndpointPlan;
  /** The request the service must refuse (`endpoints[].reject`), for X402-11. Absent: X402-11 is skipped. */
  readonly reject?: RejectCase;
  /**
   * Called with one line when a check starts a long wait on the chain (X402-11
   * waits up to six minutes), so a log does not look stuck. The line holds no
   * text from the service.
   */
  readonly onProgress?: (line: string) => void;
}

/** One check has nothing to test against this target; it is skipped with the reason. */
class CheckNotApplicable extends Error {
  public constructor(reason: string) {
    super(reason);
    this.name = "CheckNotApplicable";
  }
}

/** The payment flow was never started, so neither payment check has a verdict. */
class PaymentNotAttemptedError extends Error {
  public constructor(reason: string) {
    super(reason);
    this.name = "PaymentNotAttemptedError";
  }
}

/**
 * No payment adapter pays on this network, so the payment checks cannot be
 * graded here. A `ConfigurationError`, so a caller that does not know the class
 * still reads it as no verdict; preflight turns it into a skip of kind
 * `unsupported` (spec A3). It is not the guard's refusal: `stellar:pubnet` has
 * an adapter and is refused by `assertPaymentNetworkAllowed`, as an error.
 */
export class UnsupportedPaymentNetworkError extends ConfigurationError {
  public readonly network: string;

  public constructor(network: string) {
    super(
      `Wasit's payment checks pay on ${paymentNetworks().join(", ")}; ` +
        `${sanitizeText(JSON.stringify(String(network)))} is not one of them, so no payment ` +
        `was attempted. X402-01..05 still apply to a challenge on any chain.`,
    );
    this.name = "UnsupportedPaymentNetworkError";
    this.network = String(network);
  }
}

/**
 * The adapter for the run's network. Throws `UnsupportedPaymentNetworkError`
 * for a network the payment checks cannot pay on; preflight calls this before
 * anything is sent.
 */
function chainFor(network: string): PaymentChain {
  const chain = paymentChainFor(network);
  if (chain === undefined) throw new UnsupportedPaymentNetworkError(network);
  return chain;
}

async function buildX402Client(
  chain: PaymentChain,
  network: string,
  payerSecretKey: string,
  rpcUrl: string,
  pin: PinTerms | undefined,
) {
  const client = new x402Client();
  // L3 (spec B3): the SDK's own spend controls, set here rather than left to
  // its default, as a second implementation of the $1 cap. An adapter that
  // allows more assets replaces them and states the cap again (`evm.ts`).
  client.setSpendControls({ maxAmountPerPayment: `$${PER_PAYMENT_CAP_USD}` });
  await chain.registerPayer(client, network, payerSecretKey, rpcUrl);
  client
    // A challenge may offer several networks, including both Stellar ones.
    // The client's default pick is the first it supports, which would sign
    // for one network with a signer built for another; pay only on the
    // network this run was asked to use. With a pin, L3 also keeps only the
    // pinned payee and asset, whatever else picked the option.
    .registerPolicy((_version, requirements) =>
      requirements.filter(
        (requirement) =>
          requirement.network === network &&
          (pin === undefined ||
            (sameAddress(network, requirement.payTo, pin.payTo) && sameAddress(network, requirement.asset, pin.asset))),
      ),
    );
  return { client, httpClient: new x402HTTPClient(client) };
}

/** The networks a challenge offers, for a report. */
function describeOffered(accepts: ReadonlyArray<{ readonly network: string }>): string {
  const networks = [...new Set(accepts.map((requirement) => requirement.network))];
  return networks.length === 0 ? "none" : networks.join(", ");
}

/** What the SDK client's spend controls say when they refuse a payment. */
const SPEND_CONTROLS_REFUSAL = "All payment requirements were rejected by spendControls";

/**
 * Builds a payment, turning a refusal by the SDK client's spend controls into
 * no verdict that says why.
 *
 * The official client pays only its default assets (plus the ones an adapter
 * allows, such as Circle's USDC on Ethereum Sepolia) and at most $1 a
 * payment, so that a paywall cannot charge a payer more than it meant to.
 * Wasit keeps those limits: it pays automatically, and on `stellar:pubnet`
 * with real money. A target above them is not at fault, and nothing was
 * sent, so this is `ERROR (setup)`, not a harness error. Matched on the SDK's
 * message (`@x402/core` 2.28 `client/index.mjs`); a message it does not
 * recognise passes through as before.
 */
async function withinSpendControls<T>(
  network: string,
  selected: PaymentRequirements,
  build: () => Promise<T>,
): Promise<T> {
  try {
    return await build();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.startsWith(SPEND_CONTROLS_REFUSAL)) throw error;
    if (message.includes("only default assets")) {
      throw new CheckSetupError(
        `The target asks to be paid in ${selected.asset} on ${network}, which is not ` +
          `an asset the official x402 client pays in by default, nor one Wasit allows, ` +
          `so nothing was sent.`,
      );
    }
    throw new CheckSetupError(
      `The target asks for ${selected.amount} base units of ${selected.asset}, more ` +
        `than the $1 a payment the official x402 client pays by default, so nothing ` +
        `was sent. The cap keeps a paywall from charging a payer more than it meant ` +
        `to; a target priced at $1 or less is checked as usual.`,
    );
  }
}

/**
 * What a payment check reads before it can pay: the challenge, the URL to pay
 * at, and the one option it would pay. Shared by `preparePayment` and the plan
 * (L1), so both judge the same option by the same rules.
 *
 * Throws `PaymentNotAttemptedError` when there is nothing to pay: an
 * unreadable or v1 challenge, no option on the run's network, or none in the
 * `exact` scheme.
 */
export async function readPaymentChallenge(options: RequestShape & { readonly target: string; readonly network: string }) {
  // The payment goes where this challenge came from, never through a redirect
  // (D-022c): `payUrl` is the target, or the URL one same-origin redirect led to.
  const { response: challenge, url: payUrl } = await fetchPaymentChallenge(options.target, buildInit(options));
  return { ...(await paymentTerms(challenge, options.network)), payUrl };
}

/** The terms of a challenge already fetched, by the rules of {@link readPaymentChallenge}. */
async function paymentTerms(challenge: Response, network: string) {
  const options = { network };
  let paymentRequired;
  try {
    paymentRequired = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((name) =>
      challenge.headers.get(name),
    );
  } catch (error) {
    // The read checks already report what is wrong with the challenge. Failing
    // the payment checks here too would count one broken challenge many times, and
    // would make X402-07 read as a signature that was not rejected when no
    // payment was ever sent. docs/CHECKS.md: an unreadable challenge produces
    // no verdict.
    const v1 = readV1BodyChallenge(await readText(challenge)) !== undefined;
    throw new PaymentNotAttemptedError(
      v1
        ? `the target issued an x402 v1 challenge, and Wasit's payment checks ` +
            `pay through x402 v2 only (on Stellar, the only version the \`exact\` ` +
            `scheme defines), so no payment was attempted (see X402-02).`
        : `the challenge could not be read as x402 payment requirements ` +
            `(${(error as Error).message}), so no payment was attempted ` +
            `(see X402-02–04).`,
    );
  }
  await challenge.body?.cancel().catch(() => undefined);

  // A target that offers no option Wasit can pay has not refused anything:
  // there is no payment to judge, so neither check gets a verdict. X402-05
  // already reports which networks it advertises.
  const onNetwork = paymentRequired.accepts.filter(
    (requirement) => requirement.network === options.network,
  );
  if (onNetwork.length === 0) {
    throw new PaymentNotAttemptedError(
      `the target offers no payment option on ${options.network} (it offers ` +
        `${describeOffered(paymentRequired.accepts)}), so no payment was ` +
        `attempted (see X402-05).`,
    );
  }
  if (!onNetwork.some((requirement) => requirement.scheme === "exact")) {
    throw new PaymentNotAttemptedError(
      `the target's ${options.network} option uses the ` +
        `"${onNetwork[0]!.scheme}" scheme, and Wasit pays through the \`exact\` ` +
        `scheme only, so no payment was attempted.`,
    );
  }

  const selected = onNetwork.find((requirement) => requirement.scheme === "exact")!;
  // The payment-identifier extension lets a server answer a repeated payload
  // with its cached response (specs/extensions/payment_identifier.md).
  const idempotent = paymentRequired.extensions?.["payment-identifier"] !== undefined;
  return { paymentRequired, selected, idempotent };
}

/** A stable text of a value, keys sorted, for a field-by-field comparison. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/**
 * L2 against the plan: the option a check is about to pay must be the one the
 * plan read, and the amount at most what the plan allowed for that check.
 * Returns that amount, or undefined when the run has no plan.
 */
function plannedAmount(plan: EndpointPlan | undefined, check: string, selected: PaymentRequirements): bigint | undefined {
  if (plan === undefined) return undefined;
  const option = plan.option;
  if (plan.status !== "planned" || option === undefined) {
    throw new PaymentGuardRefusedError(
      "plan",
      `The plan of this run did not plan a payment for ${plan.name} (${plan.status}), so ${check} does not pay it.` +
        (plan.reason === undefined ? "" : ` The plan says: ${plan.reason}`),
    );
  }
  for (const field of ["scheme", "network", "payTo", "asset"] as const) {
    const same =
      field === "payTo" || field === "asset"
        ? sameAddress(option.network, String(selected[field]), option[field])
        : selected[field] === option[field];
    if (!same) {
      throw new PaymentGuardRefusedError(
        "plan",
        `${check}: the service changed its ${field} after the plan (the plan read ${option[field]}), ` +
          `so the payment the plan allowed is not the one it now asks for.`,
      );
    }
  }
  const entry = plan.signatures.find((signature) => signature.check === check);
  if (entry === undefined) {
    throw new PaymentGuardRefusedError("plan", `The plan of this run has no signature for ${check}.`);
  }
  return entry.amount;
}

/**
 * Reads the challenge and produces a signed payment payload for it.
 *
 * Shared by every payment check so each one starts from a challenge the
 * target issued just now, rather than reusing a stale one. With `altered`,
 * the payment is signed for those terms instead, and its `accepted` is set
 * back to what the target advertised. `beforeSigning` runs once the option
 * to pay is known and before the client builds anything: the Stellar client
 * simulates the transfer while building, so a check placed later would never
 * see an unfunded payer.
 *
 * L2 (spec B3) is here, between the fresh challenge and the SDK: the pin over
 * every `exact` option, the plan, the $1 cap and the run's cap, the run charged
 * before the signature. The SDK is then handed exactly the one option checked,
 * and a payload whose `accepted` is not that option is discarded unsent.
 */
async function preparePayment(
  options: X402PaymentCheckOptions,
  check: string,
  alter?: (selected: PaymentRequirements) => AlteredSigning | Promise<AlteredSigning>,
  beforeSigning?: (selected: PaymentRequirements) => Promise<void>,
) {
  // L0 again at the one function every x402 signature goes through, whoever
  // reaches it: nothing is fetched or signed on a network that is not a test
  // network.
  assertPaymentNetworkAllowed("x402", options.network);
  const chain = chainFor(options.network);
  const budget = options.budget ?? new RunBudget();
  const { client, httpClient } = await buildX402Client(
    chain,
    options.network,
    options.payerSecretKey,
    chain.resolveRpcUrl(options.network, options.rpcUrl),
    options.pin,
  );

  const { paymentRequired, selected, idempotent, payUrl } = await readPaymentChallenge(options);

  // L2, before anything is built: the service may change its challenge between
  // requests, so the plan alone is not enough.
  assertPinned(options.network, paymentRequired.accepts, options.pin);
  const planned = plannedAmount(options.plan, check, selected);
  const signing: PaymentRequirements = alter === undefined ? selected : { ...selected, ...(await alter(selected)) };
  for (const field of ["scheme", "network", "payTo", "asset"] as const) {
    if (signing[field] !== selected[field]) {
      throw new PaymentGuardRefusedError("accepted", `${check} would sign different ${field} terms than the target's.`);
    }
  }
  budget.charge({
    check,
    network: options.network,
    asset: signing.asset,
    amount: signing.amount,
    ...(planned === undefined ? {} : { planned }),
  });

  await beforeSigning?.(selected);
  const signed = await withinSpendControls(options.network, selected, () =>
    client.createPaymentPayload({ ...paymentRequired, accepts: [signing] }),
  );
  // What the SDK says it signed must be the option checked, field by field;
  // otherwise the payload is discarded here, unsent. It stays charged.
  if (canonical(signed.accepted) !== canonical(signing)) {
    throw new PaymentGuardRefusedError(
      "accepted",
      `The payment the x402 client built for ${check} names other terms in its accepted field than the ` +
        `option Wasit checked.`,
      { signed: true },
    );
  }
  const paymentPayload = alter === undefined ? signed : { ...signed, accepted: selected };
  return { httpClient, paymentPayload, selected, idempotent, payUrl };
}

/**
 * Reads the settlement a paid response reports, before anything is looked up.
 *
 * Takes the header decoder rather than the response so the rules can be
 * exercised without a network. `readSettlement` throws when the response
 * carries no `PAYMENT-RESPONSE` header, as `x402HTTPClient` does.
 */
export function readSettlementReference(
  status: number,
  readSettlement: () => {
    readonly success: boolean;
    readonly transaction?: string;
    readonly errorReason?: string;
  },
  chain: PaymentChain = stellarChain,
): { readonly reference: string } | { readonly failure: string; readonly hint: string } {
  let settlement;
  try {
    settlement = readSettlement();
  } catch {
    return {
      failure:
        `Valid payment accepted (HTTP ${status}), but the response carried no ` +
        `PAYMENT-RESPONSE header, which the x402 v2 HTTP transport uses to ` +
        `report settlement. Whether the payment settled cannot be verified.`,
      hint:
        "After settling, return the facilitator's settle result base64-encoded " +
        "in a PAYMENT-RESPONSE header; the official x402 middleware does this.",
    };
  }

  const reference = settlement.transaction ?? "";
  // `settlement_pending` means broadcast but unconfirmed; the x402 spec has the
  // caller reconcile on chain, which is exactly what X402-06 goes on to do.
  const pending = !settlement.success && settlement.errorReason === "settlement_pending";
  if ((!settlement.success && !pending) || !chain.isSettlementReference(reference)) {
    return {
      failure:
        `Valid payment accepted (HTTP ${status}), but its PAYMENT-RESPONSE ` +
        `reports ${settlement.success ? "success" : "failure"} with transaction ` +
        `${JSON.stringify(reference)}, not ${chain.referenceKind}.`,
      hint:
        "PAYMENT-RESPONSE must report `success: true` and carry the settlement " +
        "transaction's hash in `transaction`.",
    };
  }
  return { reference };
}

/**
 * X402-06: a valid payment must be accepted, and must settle on-chain.
 *
 * A 2xx proves only that the target served the resource. The x402 v2 HTTP
 * transport reports settlement in the `PAYMENT-RESPONSE` header, whose
 * `transaction` is, for the `exact` scheme on Stellar, the settlement's hash.
 * That hash is looked up on RPC and the token contract's own transfer event is
 * held to what the target advertised, as MPP-01 does: a target that serves
 * the resource without settling, or settles something else, fails here.
 */
/** What X402-06 hands the negative checks: whether the honest payment was taken, and how to replay it. */
interface HonestPayment {
  readonly result: CheckResult;
  /** True when the target answered the honest payment with a 2xx. */
  readonly accepted: boolean;
  /** The exact headers the honest payment was sent with. */
  readonly headers: Record<string, string>;
  /** Where the honest payment was sent: the replay goes to the same URL. */
  readonly url: string;
  /** True when the challenge advertised the payment-identifier extension. */
  readonly idempotent: boolean;
  /** The honest payment's inner payload: X402-11 reads its authorization as the control. */
  readonly payload: Record<string, unknown>;
}

/**
 * Stops X402-06 before it pays when the payer certainly cannot cover the
 * price.
 *
 * A payment the payer cannot fund is refused, and the refusal reads as the
 * target's: on Solana devnet the facilitator answers
 * `invalid_exact_svm_transaction_simulation_failed`, the reason a real defect
 * gives too, so it cannot be told apart afterwards; the Stellar client fails
 * earlier, simulating the transfer while it builds, with only the token's
 * error code. Read before signing, so a target that settles and then refuses
 * still shows as one. Only a balance the
 * chain reported counts: when it cannot be read, the run pays as before, and
 * a failed read never becomes a verdict either way.
 */
async function assertPayerCanPay(
  options: X402PaymentCheckOptions,
  selected: PaymentRequirements,
): Promise<void> {
  let price: bigint;
  try {
    price = BigInt(selected.amount);
  } catch {
    return;
  }
  const chain = chainFor(options.network);
  let balance: bigint | undefined;
  try {
    balance = await chain.payerBalance(
      options.network,
      chain.resolveRpcUrl(options.network, options.rpcUrl),
      chain.payerAddress(options.payerSecretKey),
      selected.asset,
    );
  } catch {
    balance = undefined;
  }
  if (balance !== undefined && balance < price) {
    throw new CheckSetupError(
      `This run's payer holds less of ${selected.asset} than the advertised ${price} ` +
        `base units, so its payment cannot settle, and a refusal would say nothing ` +
        `about the target. Fund the payer (${chain.payerKeyEnv}), then re-run.`,
    );
  }
}

async function checkSignatureAccepted(options: X402PaymentCheckOptions): Promise<HonestPayment> {
  const id = "X402-06";
  const name = "Signature Resubmit Accepted";
  const fail = (detail: string, hint: string): CheckResult => ({ id, name, pass: false, detail, hint });

  const { httpClient, paymentPayload, idempotent, payUrl } = await preparePayment(options, "X402-06", undefined, (selected) =>
    assertPayerCanPay(options, selected),
  );
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
  const paid = await fetchTarget(payUrl, withPaymentHeaders(options, paymentHeaders));
  const honest = (result: CheckResult, accepted: boolean): HonestPayment => ({
    result,
    accepted,
    headers: paymentHeaders,
    url: payUrl,
    idempotent,
    payload: paymentPayload.payload,
  });

  if (paid.status < 200 || paid.status >= 300) {
    const reason = await refusalReason(paid);
    // Permit2 needs the payer to have approved the Permit2 contract once. A
    // target that offers no gas-sponsored approval leaves that to the payer,
    // so this refusal is about Wasit's payer, not the target: no verdict.
    if (reason === "permit2_allowance_required") {
      throw new CheckSetupError(
        "The target pays through Permit2 without a gas-sponsored approval, and this " +
          "run's payer has not approved the Permit2 contract for the token. Approve it " +
          "once (an on-chain transaction that needs gas), then re-run.",
      );
    }
    return honest(fail(
      `Expected 2xx after a valid payment, got ${paid.status}` +
        `${reason === undefined ? "" : ` (${reason})`}.`,
      reason?.startsWith("settlement failed:")
        ? "The payment verified, but the facilitator did not settle it, and said why. " +
          "That is the facilitator's failure, or its RPC's, yet a valid payment was " +
          "refused; check the facilitator's account and endpoint, then re-run."
        : "A valid payment was refused. Your server's log of the facilitator's " +
          "verify or settle response says why; serve the resource with a 2xx once " +
          "the payment settles.",
    ), false);
  }

  const chain = chainFor(options.network);
  const read = readSettlementReference(
    paid.status,
    () => httpClient.getPaymentSettleResponse((header) => paid.headers.get(header)),
    chain,
  );
  if ("failure" in read) return honest(fail(read.failure, read.hint), true);
  const reference = read.reference;

  const accepted = paymentPayload.accepted;
  let amount: bigint;
  try {
    amount = BigInt(accepted.amount);
  } catch {
    throw new MalformedResponseError(
      `The accepted payment requirements carry a non-numeric amount ` +
        `(${JSON.stringify(accepted.amount)}).`,
    );
  }

  const rpcUrl = chain.resolveRpcUrl(options.network, options.rpcUrl);
  const verdict = await chain.verifySettlement(options.network, rpcUrl, reference, {
    amount,
    token: accepted.asset,
    recipient: accepted.payTo,
    payer: chain.payerAddress(options.payerSecretKey),
  });

  return honest(
    verdict.pass
      ? {
          id,
          name,
          pass: true,
          detail: `Valid payment accepted (HTTP ${paid.status}) and ${verdict.detail}.`,
          // Read back from the chain and found to be this payment: a report may link it.
          reference,
        }
      : fail(
          verdict.detail,
          "PAYMENT-RESPONSE must name the transaction that settled this payment, " +
            "and that transaction must move exactly `amount` of `asset` from the " +
            "payer to `payTo`, in a single transfer.",
        ),
    true,
  );
}

/**
 * X402-07 (negative): a corrupted signature must be rejected.
 *
 * The payment is built exactly as for X402-06, then only the client's
 * authorization signature is corrupted (see {@link corruptAuthSignature}), so
 * the envelope still decodes and a target can refuse it only by verifying the
 * signature. Before 0.6.0 the base64 envelope's tail was overwritten instead,
 * which broke XDR decoding: a target that parsed the envelope and skipped
 * signature verification entirely still passed.
 *
 * A rejection is any non-2xx answer. A rejection is only established by an
 * answer: anything that prevents one produces no verdict.
 */
async function checkInvalidSignatureRejected(
  options: X402PaymentCheckOptions,
): Promise<CheckResult> {
  const { httpClient, paymentPayload, payUrl } = await preparePayment(options, "X402-07");

  const corrupted = {
    ...paymentPayload,
    payload: chainFor(options.network).corruptPayload(paymentPayload.payload),
  };

  const paymentHeaders = httpClient.encodePaymentSignatureHeader(corrupted);
  const response = await fetchTarget(payUrl, withPaymentHeaders(options, paymentHeaders));

  return signatureRejectionVerdict(response.status, await refusalReason(response));
}

/**
 * X402-07's verdict from the status a corrupted payment drew. Split out so
 * the verdict can be tested without building a payment.
 */
export function signatureRejectionVerdict(status: number, reason?: string): CheckResult {
  const accepted = status >= 200 && status < 300;
  return {
    id: "X402-07",
    name: "Invalid Signature Rejected",
    pass: !accepted,
    detail: accepted
      ? `A payment with a corrupted authorization signature was accepted with ` +
        `HTTP ${status} — security-relevant failure.`
      : `Payment with a corrupted authorization signature correctly rejected ` +
        `(${statusWithReason(status, reason)}).`,
    ...(accepted
      ? {
          hint:
            "Verify every payment before serving: pass it to the facilitator's " +
            "verify step and refuse it when verification fails. Never serve on a " +
            "payload that was only decoded.",
        }
      : {}),
  };
}


/** Any 2xx is the target serving the resource. */
function served(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Why the target refused a payment, when it says. A payment refused at
 * verify comes back with a fresh challenge whose `error` names the reason
 * (often the facilitator's, e.g. `invalid_exact_evm_payload_signature`). One
 * that verified but did not settle comes back with a `PAYMENT-RESPONSE` whose
 * `success` is false and whose `errorReason` says why, as the official SDK
 * server sends it; that is read first, and named as a settlement failure, so
 * an operator can tell their facilitator's failure from a refusal. Shown with
 * a PASS so a reader can tell the refusal came from the rule the check is
 * about, not from something else that also answers 402.
 */
async function refusalReason(response: Response): Promise<string | undefined> {
  const decode = (header: string): Record<string, unknown> | undefined => {
    try {
      return asRecord(JSON.parse(Buffer.from(header, "base64").toString("utf-8")));
    } catch {
      return undefined;
    }
  };
  const settlement = response.headers.get("PAYMENT-RESPONSE");
  if (settlement !== null) {
    const parsed = decode(settlement);
    const reason = parsed?.["errorReason"];
    if (parsed?.["success"] === false && typeof reason === "string" && reason.length > 0) {
      // The reason is a code; some facilitators append a long RPC message.
      return `settlement failed: ${/^[\w.-]+/.exec(reason)?.[0] ?? reason}`;
    }
  }
  const errorOf = (record: Record<string, unknown> | undefined): string | undefined => {
    const error = record?.["error"];
    return typeof error === "string" && error.length > 0 ? error : undefined;
  };
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (header !== null) return errorOf(decode(header));
  try {
    return errorOf(asRecord(JSON.parse(await readText(response))));
  } catch {
    return undefined;
  }
}

function statusWithReason(status: number, reason: string | undefined): string {
  return reason === undefined ? `HTTP ${status}` : `HTTP ${status}: ${reason}`;
}

/**
 * X402-08 (negative): a payment already accepted must not be accepted again.
 *
 * The headers X402-06's honest payment was sent with are sent once more,
 * byte for byte. Each authorization is single-use: an EIP-3009 nonce, or a
 * Soroban auth entry's nonce, is spent once the payment settles, so the
 * facilitator's verify refuses it (spec §10.1). A target that serves it again
 * has sold the resource twice for one payment. Nothing can settle twice.
 */
async function checkReplayRejected(
  options: X402PaymentCheckOptions,
  honest: HonestPayment,
): Promise<CheckResult> {
  if (honest.idempotent) {
    return skipped(
      "X402-08",
      "Payment Replay Rejected",
      "the challenge advertises the payment-identifier extension, under which a " +
        "server may answer a repeated payment with its cached response.",
    );
  }
  const response = await fetchTarget(honest.url, withPaymentHeaders(options, honest.headers));
  return replayVerdict(response.status, await refusalReason(response));
}

/** X402-08's verdict from the status the replayed payment drew. */
export function replayVerdict(status: number, reason?: string): CheckResult {
  const accepted = served(status);
  return {
    id: "X402-08",
    name: "Payment Replay Rejected",
    pass: !accepted,
    detail: accepted
      ? `The payment X402-06 had already been accepted for was accepted again ` +
        `(HTTP ${status}): one payment bought the resource twice.`
      : `The same payment, sent again, was refused (${statusWithReason(status, reason)}).`,
    ...(accepted
      ? {
          hint:
            "Treat every payment as single-use: verify it with the facilitator " +
            "before serving, which refuses an authorization whose nonce is already " +
            "spent, and never serve the same payload twice.",
        }
      : {}),
  };
}

/**
 * X402-09 (negative): a validly signed payment for less than the price must
 * be rejected.
 *
 * The payment is signed for half the advertised amount, while its `accepted`
 * still claims the advertised terms, so the signature is good and only the
 * amount is wrong. The facilitator must hold the signed amount to the
 * requirement (Stellar: exactly; EVM: verification step 3). If the target
 * accepts, the lower amount may settle.
 */
async function checkUnderpaymentRejected(options: X402PaymentCheckOptions): Promise<CheckResult> {
  // The plan of `wasit run` leaves X402-09 out at a price below 2 base units;
  // the check is then skipped as it is without a plan, and nothing is fetched.
  const plan = options.plan;
  if (
    plan?.status === "planned" &&
    plan.option !== undefined &&
    plan.option.amount < 2n &&
    !plan.signatures.some((signature) => signature.check === "X402-09")
  ) {
    const price = plan.option.amount;
    return skipped(
      "X402-09",
      "Underpayment Rejected",
      `the advertised price is ${price} base unit${price === 1n ? "" : "s"} (as the plan read it before the run), so ` +
        `there is no smaller payment to offer.`,
    );
  }
  let advertised = 0n;
  let offered = 0n;
  let prepared;
  try {
    prepared = await preparePayment(options, "X402-09", (selected) => {
      try {
        advertised = BigInt(selected.amount);
      } catch {
        throw new MalformedResponseError(
          `The payment requirements carry a non-numeric amount (${JSON.stringify(selected.amount)}).`,
        );
      }
      if (advertised < 2n) {
        throw new CheckNotApplicable(
          `the advertised price is ${advertised} base unit${advertised === 1n ? "" : "s"}, so ` +
            `there is no smaller payment to offer.`,
        );
      }
      offered = advertised / 2n;
      return { amount: offered.toString() };
    });
  } catch (error) {
    if (error instanceof CheckNotApplicable) {
      return skipped("X402-09", "Underpayment Rejected", error.message);
    }
    throw error;
  }
  const { httpClient, paymentPayload, payUrl } = prepared;
  const response = await fetchTarget(
    payUrl,
    withPaymentHeaders(options, httpClient.encodePaymentSignatureHeader(paymentPayload)),
  );
  return underpaymentVerdict(response.status, offered, advertised, await refusalReason(response));
}

/** X402-09's verdict from the status the underpaid payment drew. */
export function underpaymentVerdict(
  status: number,
  offered: bigint,
  advertised: bigint,
  reason?: string,
): CheckResult {
  const accepted = served(status);
  return {
    id: "X402-09",
    name: "Underpayment Rejected",
    pass: !accepted,
    detail: accepted
      ? `A validly signed payment for ${offered} of the advertised ${advertised} base ` +
        `units was accepted (HTTP ${status}) — security-relevant failure: the target ` +
        `served for less than its price.`
      : `A validly signed payment for ${offered} of the advertised ${advertised} base ` +
        `units was refused (${statusWithReason(status, reason)}).`,
    ...(accepted
      ? {
          hint:
            "Hold the signed payment to the advertised amount before serving. The " +
            "facilitator's verify does; a server that skips it, or checks only the " +
            "signature, sells for less than its price.",
        }
      : {}),
  };
}

/**
 * X402-10 (negative): a payment whose authorization has expired must be
 * rejected.
 *
 * Each chain says how the payment is made to expire (`expiredSigning`): on
 * Stellar and EVM it is signed with a one-second lifetime (the auth entry's
 * expiration ledger, or `validBefore`, both derived from `maxTimeoutSeconds`)
 * and held until that has passed; on Solana it is built on a blockhash already
 * past its lifetime. It is sent claiming the advertised terms. An expired
 * authorization cannot settle, so a target that serves it serves for nothing.
 */
async function checkExpiredRejected(options: X402PaymentCheckOptions): Promise<CheckResult> {
  const chain = chainFor(options.network);
  const rpcUrl = chain.resolveRpcUrl(options.network, options.rpcUrl);
  let holdMs = 0;
  const { httpClient, paymentPayload, payUrl } = await preparePayment(options, "X402-10", async (selected) => {
    const expired = await chain.expiredSigning(selected, rpcUrl);
    holdMs = expired.holdMs;
    return expired.terms;
  });
  await new Promise<void>((done) => setTimeout(done, holdMs));
  const response = await fetchTarget(
    payUrl,
    withPaymentHeaders(options, httpClient.encodePaymentSignatureHeader(paymentPayload)),
  );
  return expiredVerdict(response.status, await refusalReason(response));
}

/** X402-10's verdict from the status the expired payment drew. */
export function expiredVerdict(status: number, reason?: string): CheckResult {
  const accepted = served(status);
  return {
    id: "X402-10",
    name: "Expired Authorization Rejected",
    pass: !accepted,
    detail: accepted
      ? `A payment whose authorization had already expired was accepted (HTTP ` +
        `${status}). It cannot settle, so the target served for nothing.`
      : `A payment whose authorization had expired was refused (${statusWithReason(status, reason)}).`,
    ...(accepted
      ? {
          hint:
            "Verify each payment with the facilitator before serving: it refuses an " +
            "authorization past its window (validBefore on EVM, the auth entry's " +
            "expiration ledger on Stellar, the recent blockhash on Solana).",
        }
      : {}),
  };
}

/** A signed authorization, decoded and held to the run's payer; `what` names it in a message. */
function authorizationOf(
  chain: PaymentChain,
  payload: Record<string, unknown>,
  payer: string,
  what: string,
): ReturnType<NonNullable<PaymentChain["authorizations"]>["decode"]> {
  const watch = chain.authorizations!;
  let decoded;
  try {
    decoded = watch.decode(payload);
  } catch (error) {
    if (error instanceof CheckSetupError) throw error;
    throw new CheckSetupError(`The authorization of ${what} could not be read from its payload (${(error as Error).message}).`);
  }
  if (decoded.payer !== payer) {
    throw new CheckSetupError(`The authorization of ${what} is signed by another address than this run's payer.`);
  }
  return decoded;
}

/** A lifetime X402-11 signs for: at least 30 s, and at most the 300 s it waits out. */
function withinRejectLifetime(value: unknown): boolean {
  const lifetime = Number(value);
  return lifetime >= REJECTED_REQUEST_MIN_LIFETIME_SECONDS && lifetime <= REJECTED_REQUEST_MAX_LIFETIME_SECONDS;
}

/** Thrown before signing when the challenge X402-11 is paid from advertises a lifetime it does not sign for. */
class RejectLifetimeOutside extends Error {
  public constructor(public readonly lifetime: unknown) {
    super("the advertised lifetime is outside what X402-11 signs for");
  }
}

/**
 * X402-11 (negative, spec B7 as D-032 changed it): a valid payment sent with a
 * request the service must refuse must not settle. See `rejected-request.ts`
 * for the rules and the verdict.
 *
 * Nothing is signed when the check could not reach a verdict anyway: no
 * reject case, X402-06 not shown settled (its nonce is the control), a chain
 * whose authorizations Wasit cannot read, a service that refuses the request
 * before asking for payment, an advertised lifetime above 300 s, or a control
 * the chain does not return. The payment then goes through `preparePayment`
 * like every other: the pin, the plan, the $1 and run caps, the advertised
 * terms exactly.
 */
async function checkRejectedRequestNotSettled(
  options: X402PaymentCheckOptions,
  honest: HonestPayment,
): Promise<CheckResult> {
  const id = REJECTED_REQUEST_ID;
  const name = REJECTED_REQUEST_NAME;
  const reject = options.reject;
  if (reject === undefined) {
    return skipped(
      id,
      name,
      "no request the service must refuse is configured (endpoints[].reject in wasit.config.json, read by " +
        "wasit run), so there is nothing to send. Nothing was signed.",
      "not-applicable",
    );
  }
  const chain = chainFor(options.network);
  const watch = chain.authorizations;
  if (watch === undefined) {
    return skipped(
      id,
      name,
      `Wasit cannot read on ${chain.name} whether a payment's authorization was used, which this check needs, ` +
        `so nothing was signed.`,
      "not-applicable",
    );
  }
  if (honest.result.pass !== true || honest.result.error !== undefined || honest.result.skipped === true) {
    return skipped(
      id,
      name,
      "X402-06's payment was not shown settled on chain, so its authorization cannot be the control that shows a " +
        "chain read is complete. Nothing was signed.",
      "dependency",
    );
  }

  // The reject request is the endpoint's request with the reject case over it.
  const { method: _method, headers: _headers, body: _body, ...rest } = options;
  const shape = rejectRequestShape(options, reject);
  const rejectOptions: X402PaymentCheckOptions = { ...rest, ...shape };

  // Without payment first: a service that refuses it before asking for payment
  // gives this check nothing to watch.
  const { response: unpaid } = await fetchPaymentChallenge(options.target, buildInit(shape));
  if (unpaid.status !== 402) {
    await unpaid.body?.cancel().catch(() => undefined);
    const status = unpaid.status;
    return skipped(
      id,
      name,
      status >= 400 && status < 500
        ? `the service refuses this request before any payment is asked (HTTP ${status}), so there is no payment ` +
            `to watch. Nothing was signed.`
        : `the service answered this request with HTTP ${status} without asking for payment, so there is no ` +
            `payment to watch. Nothing was signed.`,
      "not-applicable",
    );
  }
  const { selected: advertised } = await paymentTerms(unpaid, options.network);
  const outside = (value: unknown, again: boolean): CheckResult =>
    skipped(
      id,
      name,
      `the service's payments stay valid for ${sanitizeText(String(value))} seconds (maxTimeoutSeconds)` +
        (again ? ", as it said when asked for payment again" : "") +
        (Number(value) > REJECTED_REQUEST_MAX_LIFETIME_SECONDS
          ? `, longer than the ${REJECTED_REQUEST_MAX_LIFETIME_SECONDS} seconds Wasit waits for one to expire on a ` +
            `test network, so this check could not show that the payment never settled.`
          : `, shorter than the ${REJECTED_REQUEST_MIN_LIFETIME_SECONDS} seconds this check needs: such a payment can ` +
            `expire before a service that settles it has it on chain, so its unused authorization would show nothing.`) +
        ` Nothing was signed.`,
    );
  if (!withinRejectLifetime(advertised.maxTimeoutSeconds)) return outside(advertised.maxTimeoutSeconds, false);

  const network = options.network;
  const rpcUrl = chain.resolveRpcUrl(network, options.rpcUrl);
  const payer = chain.payerAddress(options.payerSecretKey);
  const control = authorizationOf(chain, honest.payload, payer, "X402-06's payment");

  // Before signing: the chain must return X402-06's used authorization, and the
  // payer's balance must be readable. Otherwise no verdict could be reached, and
  // nothing is signed.
  let balanceBefore = 0n;
  let prepared;
  try {
    prepared = await preparePayment(rejectOptions, id, undefined, async (selected) => {
      // The challenge is read again for the signature, and the service may
      // answer it with another lifetime: the one signed is held to 300 s too.
      if (!withinRejectLifetime(selected.maxTimeoutSeconds)) throw new RejectLifetimeOutside(selected.maxTimeoutSeconds);
      let read;
      try {
        read = await watch.read(network, rpcUrl, [control]);
      } catch (error) {
        throw new CheckSetupError(`The chain could not be read before signing (${(error as Error).message}). Nothing was signed.`);
      }
      if (read.used[0] === undefined) {
        throw new CheckSetupError(
          "The chain's answer leaves out X402-06's authorization, which was used, so a later read could not show " +
            "that this payment's was not. Nothing was signed.",
        );
      }
      let balance: bigint | undefined;
      try {
        balance = await chain.payerBalance(network, rpcUrl, payer, advertised.asset);
      } catch {
        balance = undefined;
      }
      if (balance === undefined) {
        throw new CheckSetupError(
          "The payer's balance could not be read, and this check needs it as a second reading. Nothing was signed.",
        );
      }
      balanceBefore = balance;
    });
  } catch (error) {
    if (error instanceof RejectLifetimeOutside) return outside(error.lifetime, true);
    throw error;
  }
  const { httpClient, paymentPayload, selected, payUrl } = prepared;
  const amount = BigInt(selected.amount);
  const ours = authorizationOf(chain, paymentPayload.payload, payer, "this payment");
  if (ours.nonce === control.nonce) {
    throw new CheckSetupError("This payment's authorization carries X402-06's nonce, so it could not be told apart. It was not sent.");
  }

  // Right before sending: ours unused, the control found. This read's ledger
  // starts the range the transfers are read over.
  const before = await watch.read(network, rpcUrl, [ours, control]);
  if (before.used[1] === undefined) {
    throw new CheckSetupError("The chain's answer leaves out X402-06's authorization, so this payment was not sent.");
  }
  if (before.used[0] !== undefined) {
    throw new CheckSetupError("The chain records this payment's authorization as used before it was sent, so it was not sent.");
  }
  // What the client signed, not what it was asked: an authorization that stays
  // valid longer than the 300 s this check waits is not sent (2 units of slack
  // for the ledgers that close while it is built).
  const longest = Math.ceil(REJECTED_REQUEST_MAX_LIFETIME_SECONDS / watch.unitSeconds) + 2;
  if (ours.expiresAt - before.latest > longest) {
    throw new CheckSetupError(
      `This payment's authorization stays valid until ${watch.unit} ${ours.expiresAt}, ` +
        `${ours.expiresAt - before.latest} ${watch.unit}s after the latest (${before.latest}), longer than the ` +
        `${REJECTED_REQUEST_MAX_LIFETIME_SECONDS} seconds this check waits. It was signed and discarded; it was not sent.`,
    );
  }
  // And long enough that a service which settles it could still get it on chain.
  if (ours.expiresAt - before.latest < REJECTED_REQUEST_MIN_UNITS_LEFT) {
    throw new CheckSetupError(
      `This payment's authorization expires at ${watch.unit} ${ours.expiresAt}, ` +
        `${ours.expiresAt - before.latest} ${watch.unit}s after the latest (${before.latest}): too soon for an unused ` +
        `authorization to show anything. It was signed and discarded; it was not sent.`,
    );
  }

  const sentAt = Date.now();
  const response = await fetchTarget(payUrl, withPaymentHeaders(shape, httpClient.encodePaymentSignatureHeader(paymentPayload)));
  const status = response.status;
  const reason = await refusalReason(response);
  options.onProgress?.(
    `X402-11: the payment was sent with the request the service must refuse (HTTP ${status}); reading the chain ` +
      `once a ${watch.unit} until its authorization expires at ${watch.unit} ${ours.expiresAt}, for at most ` +
      `${Math.round(rejectedRequestHardStopMs() / 1000)} s.`,
  );

  let outcome: WatchOutcome = await watchAuthorization({ watch, network, rpcUrl, ours, control, sentAt });
  let balance: { before: bigint; after: bigint } | undefined;
  let transfers: { reference: string; ledger: number }[] | undefined;
  if (outcome.kind === "used" || outcome.kind === "unused") {
    try {
      const after = await chain.payerBalance(network, rpcUrl, payer, selected.asset);
      if (after === undefined) throw new Error("the payer's balance could not be read after the watch");
      balance = { before: balanceBefore, after };
      const recorded = await watch.transfers(network, rpcUrl, {
        asset: selected.asset,
        from: payer,
        to: selected.payTo,
        fromLedger: before.latest + 1,
      });
      // Only what the watch covered: from the ledger after the pre-send read to the last ledger
      // it read. A later transfer of the same amount (another run with this payer) is not this one.
      const lastRead = outcome.latest;
      transfers = recorded.transfers
        .filter((transfer) => transfer.amount === amount && transfer.ledger <= lastRead)
        .map((transfer) => ({ reference: transfer.reference, ledger: transfer.ledger }));
    } catch (error) {
      outcome = { kind: "unread", why: `the second readings failed: ${sanitizeText((error as Error).message).slice(0, 200)}` };
      balance = undefined;
      transfers = undefined;
    }
  }

  return rejectedRequestVerdict({
    status,
    ...(reason === undefined ? {} : { reason }),
    amount,
    expiresAt: ours.expiresAt,
    unit: watch.unit,
    watch: outcome,
    ...(balance === undefined ? {} : { balance }),
    ...(transfers === undefined ? {} : { transfers }),
  });
}

/** The negative checks, in catalogue order, each with how it runs. */
const NEGATIVE_CHECKS: ReadonlyArray<
  readonly [string, string, (options: X402PaymentCheckOptions, honest: HonestPayment) => Promise<CheckResult>]
> = [
  ["X402-07", "Invalid Signature Rejected", (options) => checkInvalidSignatureRejected(options)],
  ["X402-08", "Payment Replay Rejected", checkReplayRejected],
  ["X402-09", "Underpayment Rejected", (options) => checkUnderpaymentRejected(options)],
  ["X402-10", "Expired Authorization Rejected", (options) => checkExpiredRejected(options)],
  [REJECTED_REQUEST_ID, REJECTED_REQUEST_NAME, checkRejectedRequestNotSettled],
];

/**
 * Every check `runX402PaymentChecks` reports, in order. Front ends that list
 * checks before a run use it, so a read-only run never shows these as pending.
 */
export const X402_PAYMENT_CHECK_IDS: readonly string[] = [
  "X402-06",
  ...NEGATIVE_CHECKS.map(([id]) => id),
];

/**
 * Runs X402-06 through X402-10 against a target.
 *
 * X402-06 settles a real payment. The negative checks send payments the
 * target must refuse; a target that accepts the underpaid one may settle it.
 * See docs/CHECKS.md.
 */
export async function runX402PaymentChecks(
  input: X402PaymentCheckOptions,
): Promise<CheckResult[]> {
  // One budget for every signature these checks make: the run's, when the
  // caller shares one across endpoints, or this call's own $5.
  const options: X402PaymentCheckOptions = { ...input, budget: input.budget ?? new RunBudget() };
  try {
    assertHttpUrl(options.target);
    buildInit(options);
    // The payment checks pay only where Wasit has an adapter, and X402-06 can
    // only verify a settlement it can look up. Both are known before any
    // money moves, so a run that could not finish is stopped here rather than
    // after paying.
    const chain = chainFor(options.network);
    // L0: an adapter for the network is not permission to pay on it. Only a
    // test network passes; stellar:pubnet waits for the mainnet opt-in, which
    // this version does not have.
    assertPaymentNetworkAllowed("x402", options.network);
    const rpcUrl = chain.resolveRpcUrl(options.network, options.rpcUrl);
    // A key for another chain, or a malformed one, would otherwise surface
    // mid-payment as a harness error. Checked here, it is what it is: the
    // run's configuration. The message never echoes the key.
    try {
      chain.payerAddress(options.payerSecretKey);
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError(
        `The payer key is not a valid ${chain.name} key (read from ${chain.payerKeyEnv} ` +
          `or --payer-key).`,
      );
    }
    // The RPC signs and settles nothing itself, but the payment is built and
    // its settlement read through it: it must serve the run's network (D-023).
    await assertRpcServesNetwork(options.network, rpcUrl);
  } catch (error) {
    // A network no adapter pays on is not a failure of the run: Wasit does not
    // grade it (spec A3). Every payment check is skipped as unsupported, and
    // nothing was fetched or signed. The guard's refusals are not this: they
    // are other errors, and stay a PREFLIGHT error below.
    if (error instanceof UnsupportedPaymentNetworkError) {
      const unsupported = [["X402-06", "Signature Resubmit Accepted"], ...NEGATIVE_CHECKS.map(([id, name]) => [id, name])]
        .map(([id, name]) => skipped(id!, name!, error.message, "unsupported"));
      for (const result of unsupported) options.onResult?.(result);
      return unsupported;
    }
    const preflight = errored("PREFLIGHT", "Run Preflight", error);
    options.onResult?.(preflight);
    return [preflight];
  }

  const results: CheckResult[] = [];
  const emit = (result: CheckResult): void => {
    results.push(result);
    options.onResult?.(result);
  };
  const skipNegatives = (reason: string): CheckResult[] => {
    for (const [id, name] of NEGATIVE_CHECKS) emit(skipped(id, name, reason));
    return results;
  };

  let honest: HonestPayment;
  try {
    honest = await checkSignatureAccepted(options);
  } catch (error) {
    if (error instanceof PaymentNotAttemptedError) {
      emit(skipped("X402-06", "Signature Resubmit Accepted", error.message));
      return skipNegatives(error.message);
    }
    const failed = errored("X402-06", "Signature Resubmit Accepted", error);
    emit(failed);
    // If the payment flow could not be exercised at all, no altered variant of
    // it can be either, and none may be reported as a passing rejection.
    return skipNegatives(
      `the payment flow could not be exercised (${failed.error?.kind ?? "harness"}), ` +
        `so no altered payment can be tested against it.`,
    );
  }
  emit(honest.result);

  // A negative check passes when the target refuses. A target that refused
  // the honest payment too proves nothing by refusing a bad one, so without an
  // accepted baseline none of them has a verdict.
  if (!honest.accepted) {
    return skipNegatives(
      "the target refused X402-06's valid payment, so refusing an altered one " +
        "says nothing about what it checks.",
    );
  }

  for (const [id, name, run] of NEGATIVE_CHECKS) {
    try {
      emit(await run(options, honest));
    } catch (error) {
      emit(errored(id, name, error));
    }
  }
  return results;
}
