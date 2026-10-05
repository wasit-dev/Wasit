import { errored, skipped, type CheckResult } from "../check.js";
import {
  CheckSetupError,
  ConfigurationError,
  MalformedResponseError,
  assertHttpUrl,
  fetchTarget,
} from "../errors.js";
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
    skipped(checkId, name, reason),
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

/** A body that cannot be read is simply not a v1 challenge. */
async function readText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
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
    response = await fetchTarget(target, init);
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
    ...(statusPass ? {} : { hint: statusHint(response.status) }),
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

  // x402 v1 signals payment in the response body rather than a header. The
  // `exact` scheme on Stellar is defined for v2 only, so a missing header is
  // still X402-02's failure — but a v1 challenge in the body still has terms
  // worth checking, and skipping them would hide which ones diverge.
  const v1Payload =
    headerValue === null ? readV1BodyChallenge(await readText(response)) : undefined;

  const r2: CheckResult = {
    id: "X402-02",
    name: "Payment Header Present",
    pass: headerValue !== null,
    detail:
      headerValue !== null
        ? "Payment header found."
        : v1Payload !== undefined
          ? `Neither PAYMENT-REQUIRED nor X-Payment header was present. The ` +
            `response body carries an x402 v1 challenge instead; the \`exact\` ` +
            `scheme on Stellar is defined for v2 only, which signals payment in ` +
            `the PAYMENT-REQUIRED header.`
          : "Neither PAYMENT-REQUIRED nor X-Payment header was present.",
    ...(headerValue !== null
      ? {}
      : {
          hint:
            v1Payload !== undefined
              ? "Move to x402 v2: send the challenge base64-encoded in a " +
                "PAYMENT-REQUIRED response header instead of the body, with " +
                "x402Version 2 and v2 field names."
              : "Send the challenge as base64-encoded JSON in a PAYMENT-REQUIRED " +
                "response header, as the x402 v2 HTTP transport defines.",
        }),
  };

  if (headerValue === null && v1Payload !== undefined) {
    return emit([
      r1,
      r2,
      {
        id: "X402-03",
        name: "Header Payload Decodable",
        pass: true,
        detail:
          "No header to decode; the x402 v1 challenge in the response body " +
          "decoded to valid JSON.",
      },
      checkRequiredFields(v1Payload),
      checkNetworkIdentifier(v1Payload),
    ]);
  }

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

import { paymentChainFor, paymentNetworks, type PaymentChain } from "./chains/index.js";
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
}

/** The payment flow was never started, so neither payment check has a verdict. */
class PaymentNotAttemptedError extends Error {
  public constructor(reason: string) {
    super(reason);
    this.name = "PaymentNotAttemptedError";
  }
}

/**
 * The adapter for the run's network. Throws `ConfigurationError` for a
 * network the payment checks cannot pay on; preflight calls this before
 * anything is sent.
 */
function chainFor(network: string): PaymentChain {
  const chain = paymentChainFor(network);
  if (chain === undefined) {
    throw new ConfigurationError(
      `The payment checks pay on ${paymentNetworks().join(", ")}; "${network}" is ` +
        `not one of them. X402-01..05 still apply to a challenge on any chain ` +
        `(--read-only, MCP readOnly).`,
    );
  }
  return chain;
}

function buildX402Client(chain: PaymentChain, network: string, payerSecretKey: string) {
  const client = new x402Client();
  chain.registerPayer(client, network, payerSecretKey);
  client
    // A challenge may offer several networks, including both Stellar ones.
    // The client's default pick is the first it supports, which would sign
    // for one network with a signer built for another; pay only on the
    // network this run was asked to use.
    .registerPolicy((_version, requirements) =>
      requirements.filter((requirement) => requirement.network === network),
    );
  return { client, httpClient: new x402HTTPClient(client) };
}

/** The networks a challenge offers, for a report. */
function describeOffered(accepts: ReadonlyArray<{ readonly network: string }>): string {
  const networks = [...new Set(accepts.map((requirement) => requirement.network))];
  return networks.length === 0 ? "none" : networks.join(", ");
}

/**
 * Reads the challenge and produces a signed payment payload for it.
 *
 * Shared by both payment checks so each one starts from a challenge the
 * target issued just now, rather than reusing a stale one.
 */
async function preparePayment(options: X402PaymentCheckOptions) {
  const { client, httpClient } = buildX402Client(
    chainFor(options.network),
    options.network,
    options.payerSecretKey,
  );

  const challenge = await fetchTarget(options.target, buildInit(options));

  let paymentRequired;
  try {
    paymentRequired = httpClient.getPaymentRequiredResponse((name) =>
      challenge.headers.get(name),
    );
  } catch (error) {
    // The read checks already report what is wrong with the challenge. Failing
    // X402-06/07 here too would count one broken challenge three times, and
    // would make X402-07 read as a signature that was not rejected when no
    // payment was ever sent. docs/CHECKS.md: an unreadable challenge produces
    // no verdict.
    const v1 = readV1BodyChallenge(await readText(challenge)) !== undefined;
    throw new PaymentNotAttemptedError(
      v1
        ? `the target issued an x402 v1 challenge, and Wasit pays through the ` +
            `v2 \`exact\` scheme on Stellar, the only version the spec defines, ` +
            `so no payment was attempted (see X402-02).`
        : `the challenge could not be read as x402 payment requirements ` +
            `(${(error as Error).message}), so no payment was attempted ` +
            `(see X402-02–04).`,
    );
  }

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

  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  return { httpClient, paymentPayload };
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
async function checkSignatureAccepted(
  options: X402PaymentCheckOptions,
): Promise<CheckResult> {
  const id = "X402-06";
  const name = "Signature Resubmit Accepted";
  const fail = (detail: string, hint: string): CheckResult => ({ id, name, pass: false, detail, hint });

  const { httpClient, paymentPayload } = await preparePayment(options);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
  const paid = await fetchTarget(
    options.target,
    withPaymentHeaders(options, paymentHeaders),
  );

  if (paid.status < 200 || paid.status >= 300) {
    return fail(
      `Expected 2xx after a valid payment, got ${paid.status}.`,
      "A valid payment was refused. Your server's log of the facilitator's " +
        "verify or settle response says why; serve the resource with a 2xx once " +
        "the payment settles.",
    );
  }

  const chain = chainFor(options.network);
  const read = readSettlementReference(
    paid.status,
    () => httpClient.getPaymentSettleResponse((header) => paid.headers.get(header)),
    chain,
  );
  if ("failure" in read) return fail(read.failure, read.hint);
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
  const verdict = await chain.verifySettlement(rpcUrl, reference, {
    amount,
    token: accepted.asset,
    recipient: accepted.payTo,
    payer: chain.payerAddress(options.payerSecretKey),
  });

  return verdict.pass
    ? {
        id,
        name,
        pass: true,
        detail: `Valid payment accepted (HTTP ${paid.status}) and ${verdict.detail}.`,
      }
    : fail(
        verdict.detail,
        "PAYMENT-RESPONSE must name the transaction that settled this payment, " +
          "and that transaction must move exactly `amount` of `asset` from the " +
          "payer to `payTo`, in a single transfer.",
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
  const { httpClient, paymentPayload } = await preparePayment(options);

  const corrupted = {
    ...paymentPayload,
    payload: chainFor(options.network).corruptPayload(paymentPayload.payload),
  };

  const paymentHeaders = httpClient.encodePaymentSignatureHeader(corrupted);
  const response = await fetchTarget(
    options.target,
    withPaymentHeaders(options, paymentHeaders),
  );

  return signatureRejectionVerdict(response.status);
}

/**
 * X402-07's verdict from the status a corrupted payment drew. Split out so
 * the verdict can be tested without building a payment.
 */
export function signatureRejectionVerdict(status: number): CheckResult {
  const accepted = status >= 200 && status < 300;
  return {
    id: "X402-07",
    name: "Invalid Signature Rejected",
    pass: !accepted,
    detail: accepted
      ? `A payment with a corrupted authorization signature was accepted with ` +
        `HTTP ${status} — security-relevant failure.`
      : `Payment with a corrupted authorization signature correctly rejected ` +
        `(HTTP ${status}).`,
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

/**
 * Runs X402-06 and X402-07 against a target.
 *
 * Both settle real payments when the target accepts them; see docs/CHECKS.md.
 */
export async function runX402PaymentChecks(
  options: X402PaymentCheckOptions,
): Promise<CheckResult[]> {
  try {
    assertHttpUrl(options.target);
    buildInit(options);
    // The payment checks pay only where Wasit has an adapter, and X402-06 can
    // only verify a settlement it can look up. Both are known before any
    // money moves, so a run that could not finish is stopped here rather than
    // after paying.
    chainFor(options.network).resolveRpcUrl(options.network, options.rpcUrl);
  } catch (error) {
    const preflight = errored("PREFLIGHT", "Run Preflight", error);
    options.onResult?.(preflight);
    return [preflight];
  }

  const results: CheckResult[] = [];

  let accepted: CheckResult;
  try {
    accepted = await checkSignatureAccepted(options);
  } catch (error) {
    if (error instanceof PaymentNotAttemptedError) {
      const notAttempted = [
        skipped("X402-06", "Signature Resubmit Accepted", error.message),
        skipped("X402-07", "Invalid Signature Rejected", error.message),
      ];
      for (const result of notAttempted) options.onResult?.(result);
      return notAttempted;
    }
    accepted = errored("X402-06", "Signature Resubmit Accepted", error);
  }
  results.push(accepted);
  options.onResult?.(accepted);

  // If the payment flow could not be exercised at all, a corrupted variant of
  // it cannot be either — and must not be reported as a passing rejection.
  if (accepted.error !== undefined) {
    const notExercised = skipped(
      "X402-07",
      "Invalid Signature Rejected",
      `the payment flow could not be exercised (${accepted.error.kind}), so ` +
        `a corrupted signature cannot be tested against it.`,
    );
    results.push(notExercised);
    options.onResult?.(notExercised);
    return results;
  }

  let rejected: CheckResult;
  try {
    rejected = await checkInvalidSignatureRejected(options);
  } catch (error) {
    rejected = errored("X402-07", "Invalid Signature Rejected", error);
  }
  results.push(rejected);
  options.onResult?.(rejected);

  return results;
}
