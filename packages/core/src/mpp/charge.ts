/**
 * MPP-01: Charge-mode settlement, verified on-chain.
 *
 * The target's own 402 challenge is the source of truth for what should be
 * paid. Verifying against it rather than against this run's configuration is
 * what makes the check meaningful against a third-party service: it asks
 * whether the service settled what it advertised, not what we assumed. The
 * one term it does not get to choose is the network: Wasit signs only for the
 * network the run names, so a target cannot redirect the payer's key to
 * mainnet by asking for it.
 *
 * Settlement is verified from the CAP-46 `transfer` contract event rather than
 * the transaction envelope, because those can disagree. The envelope records
 * what was requested; the event records what the token contract actually did.
 * A `currency` contract whose `transfer` moves a different amount than its
 * arguments claim is caught here and nowhere else — the same threat model
 * @stellar/mpp's own client guards against when it refuses to sign a
 * non-transfer authorization.
 */

import { Mppx, charge } from "@stellar/mpp/charge/client";
import { Challenge, Receipt } from "mppx";
import { Keypair } from "@stellar/stellar-sdk";

import { type CheckResult } from "../check.js";
import {
  ConfigurationError,
  MalformedResponseError,
  assertHttpUrl,
  fetchTarget,
} from "../errors.js";
import { type MppNetwork, assertMppNetwork, isMppNetwork, resolveRpcUrl } from "./network.js";
import { verifySettlement } from "../settlement.js";

const CHECK_ID = "MPP-01";
const CHECK_NAME = "Charge Settlement On-Chain";

export interface MppChargeCheckOptions {
  readonly target: string;
  readonly network: string;
  readonly payerSecretKey: string;
  readonly rpcUrl?: string;
}

/** What the target advertised it wants paid, read from its own 402 challenge. */
export interface ChargeChallenge {
  readonly amount: bigint;
  readonly currency: string;
  readonly recipient: string;
  /** The network the SDK's charge client would sign this challenge for. */
  readonly network: MppNetwork;
}

/** The SDK's charge client, as `charge()` from @stellar/mpp builds it. */
type ChargeClient = ReturnType<typeof charge>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Reads the charge challenge without paying.
 *
 * Done as a separate unpaid request so the advertised terms are captured
 * before any money moves. `amount` is in base units: the server converts via
 * `toBaseUnits()` before building the challenge, so it is directly comparable
 * to the `i128` in the transfer event without any decimal handling.
 */
async function fetchChargeChallenge(target: string): Promise<ChargeChallenge> {
  const response = await fetchTarget(target);

  if (response.status !== 402) {
    throw new MalformedResponseError(
      `Expected HTTP 402 with a payment challenge, got ${response.status}.`,
    );
  }

  let challenge: Challenge.Challenge;
  try {
    challenge = Challenge.fromResponse(response);
  } catch (error) {
    throw new MalformedResponseError(
      `Challenge could not be parsed from the WWW-Authenticate header: ` +
        `${(error as Error).message}`,
    );
  }

  return parseChargeChallenge(challenge);
}

/**
 * Reads the advertised charge terms out of an already-decoded challenge.
 *
 * Separated from the request that produced it so these rules can be exercised
 * directly, including against the malformed challenges a conforming service
 * will not produce on demand. Everything it throws is a
 * {@link MalformedResponseError}, so a bad challenge is reported as a verdict
 * about the target rather than as a harness failure.
 */
export function parseChargeChallenge(
  challenge: Challenge.Challenge,
): ChargeChallenge {
  const request = asRecord(challenge.request);
  if (!request) {
    throw new MalformedResponseError("Challenge carries no request object.");
  }

  const amountRaw = readString(request, "amount");
  const currency = readString(request, "currency");
  const recipient = readString(request, "recipient");

  const missing = [
    amountRaw ? null : "amount",
    currency ? null : "currency",
    recipient ? null : "recipient",
  ].filter((entry): entry is string => entry !== null);

  if (missing.length > 0 || !amountRaw || !currency || !recipient) {
    throw new MalformedResponseError(
      `Charge challenge is missing ${missing.join(", ")}.`,
    );
  }

  let amount: bigint;
  try {
    amount = BigInt(amountRaw);
  } catch {
    throw new MalformedResponseError(
      `Challenge advertises a non-numeric amount ("${amountRaw}"). The spec ` +
        `requires base units, e.g. "10000" for 0.001 of a 7-decimal token.`,
    );
  }

  return { amount, currency, recipient, network: chargeNetwork(request) };
}

/**
 * The network @stellar/mpp's charge client signs a challenge for.
 *
 * The client takes it from the challenge, `methodDetails.network`, and signs a
 * challenge that names none for testnet (`resolveNetworkId`,
 * dist/shared/validation.js in 0.7.1). This reads it the same way, because
 * what matters is the network the signature will be valid on.
 */
function chargeNetwork(request: Record<string, unknown>): MppNetwork {
  const network = asRecord(request["methodDetails"])?.["network"];
  if (network === undefined || network === null) return "stellar:testnet";
  if (typeof network === "string" && isMppNetwork(network)) return network;
  throw new MalformedResponseError(
    `Charge challenge names network ${JSON.stringify(network)}. A Stellar ` +
      `network is "stellar:testnet" or "stellar:pubnet" (CAIP-2).`,
  );
}

/** Refuses a challenge for any network but the run's, before anything is signed. */
function assertRunNetwork(asked: MppNetwork, network: MppNetwork): void {
  if (asked !== network) {
    throw new ConfigurationError(
      `The target asks to be paid on ${asked}, and this run pays on ${network} ` +
        `only, so nothing was signed.`,
    );
  }
}

/**
 * `method`, refusing to sign a challenge for any network but `network`.
 *
 * Checking the unpaid challenge is not enough on its own: mppx requests the
 * target again and pays the challenge in that answer, which the target is
 * free to change. So the check also sits here, on the exact challenge about to
 * be signed. Without it a target asking for `stellar:pubnet` gets a mainnet
 * transfer signed, sent through the SDK's own default pubnet RPC endpoint.
 */
function onNetwork(method: ChargeClient, network: MppNetwork): ChargeClient {
  return {
    ...method,
    createCredential: async (parameters) => {
      assertRunNetwork(chargeNetwork(asRecord(parameters.challenge.request) ?? {}), network);
      return method.createCredential(parameters);
    },
  };
}

/**
 * Pays `target` through `method` once at most, and only a challenge for
 * `network`.
 *
 * mppx answers a 402 that follows a payment by paying the new challenge, up to
 * `maxPaymentRetries` attempts (3 by default, dist/client/internal/Fetch.js in
 * 0.8.14). MPP-01 judges one payment: a target that answers 402 after being
 * paid has that 402 reported, rather than being paid twice more.
 */
export async function payCharge(
  target: string,
  network: MppNetwork,
  method: ChargeClient,
): Promise<Response> {
  const mppx = Mppx.create({
    methods: [onNetwork(method, network)],
    polyfill: false,
    maxPaymentRetries: 1,
  });
  return mppx.fetch(target);
}

function fail(detail: string): CheckResult[] {
  return [{ id: CHECK_ID, name: CHECK_NAME, pass: false, detail }];
}

function pass(detail: string): CheckResult[] {
  return [{ id: CHECK_ID, name: CHECK_NAME, pass: true, detail }];
}

/**
 * MPP-01: the charge must settle on-chain for exactly the advertised amount.
 *
 * Runs a real payment against the target every time it is called. See
 * docs/CHECKS.md — this check spends funds by design.
 *
 * @throws {ConfigurationError} Invalid target URL, network, or missing key, or
 *   a challenge for another network than the run's (nothing is signed).
 * @throws {TargetUnreachableError} The target never answered.
 * @throws {MalformedResponseError} The target answered, non-conformantly.
 * @throws {Error} RPC failure — reported as `harness`, never as a target defect.
 */
export async function runMppChargeChecks(
  options: MppChargeCheckOptions,
): Promise<CheckResult[]> {
  const { target, network, payerSecretKey, rpcUrl } = options;

  assertHttpUrl(target);
  const runNetwork = assertMppNetwork(network);

  if (!payerSecretKey) {
    throw new ConfigurationError(
      "No payer secret key. MPP-01 settles a real payment and cannot run without one.",
    );
  }

  let payer: Keypair;
  try {
    payer = Keypair.fromSecret(payerSecretKey);
  } catch {
    throw new ConfigurationError(
      "Payer secret key is not a valid Stellar secret (expected an S... string).",
    );
  }

  // Resolve the endpoint before spending anything: a bad RPC URL discovered
  // after settlement would leave money moved and no verdict to show for it.
  const endpoint = resolveRpcUrl(network, rpcUrl);
  // The SDK's charge client builds its RPC client without `allowHttp`, so it
  // cannot pay through an http endpoint, though settlement could be read from
  // one. Say so before paying, instead of reporting the SDK's refusal as the
  // target's failure.
  if (endpoint.startsWith("http://")) {
    throw new ConfigurationError(
      `MPP-01 pays through @stellar/mpp's charge client, which accepts only an ` +
        `https RPC endpoint, and ${endpoint} is http. Nothing was sent.`,
    );
  }

  const advertised = await fetchChargeChallenge(target);
  assertRunNetwork(advertised.network, runNetwork);

  let paid: Response;
  try {
    // The payment goes through the run's endpoint too. Left to itself the SDK
    // picks its own per network, so `--rpc-url` would cover only the
    // settlement read, and pubnet would get a default endpoint after all.
    paid = await payCharge(target, runNetwork, charge({ secretKey: payerSecretKey, rpcUrl: endpoint }));
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    // The target was reachable moments ago, so this is the payment path
    // failing, not the network. Report it as a conformance failure.
    throw new MalformedResponseError(
      `Payment attempt failed: ${(error as Error).message}`,
    );
  }

  if (!paid.ok) {
    return fail(
      `Submitted a payment for the advertised ${advertised.amount} base ` +
        `units, but the target answered HTTP ${paid.status} instead of ` +
        `serving the resource. Nothing is claimed about settlement: a target ` +
        `that refuses may never have broadcast the transaction.`,
    );
  }

  let reference: string;
  try {
    reference = Receipt.fromResponse(paid).reference;
  } catch (error) {
    return fail(
      `Target returned ${paid.status} but no valid Payment-Receipt header: ` +
        `${(error as Error).message}`,
    );
  }

  const verdict = await verifySettlement(endpoint, reference, {
    amount: advertised.amount,
    token: advertised.currency,
    recipient: advertised.recipient,
    payer: payer.publicKey(),
  });
  // Same sentence MPP-01 has always printed, capitalised and closed.
  return verdict.pass
    ? pass(`${verdict.detail.charAt(0).toUpperCase()}${verdict.detail.slice(1)}.`)
    : fail(verdict.detail);
}
