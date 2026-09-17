/**
 * MPP-01: Charge-mode settlement, verified on-chain.
 *
 * The target's own 402 challenge is the source of truth for what should be
 * paid. Verifying against it rather than against this run's configuration is
 * what makes the check meaningful against a third-party service: it asks
 * whether the service settled what it advertised, not what we assumed.
 *
 * Settlement is verified from the CAP-46 `transfer` contract event rather than
 * the transaction envelope, because those can disagree. The envelope records
 * what was requested; the event records what the token contract actually did.
 * A `currency` contract whose `transfer` moves a different amount than its
 * arguments claim is caught here and nowhere else — the same threat model
 * @stellar/mpp's own client guards against when it refuses to sign a
 * non-transfer authorization.
 */

import { Address, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
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
import { assertMppNetwork, resolveRpcUrl } from "./network.js";

const CHECK_ID = "MPP-01";
const CHECK_NAME = "Charge Settlement On-Chain";

/** How long to wait for the settled transaction to become visible to RPC. */
const POLL_ATTEMPTS = 12;
const POLL_DELAY_MS = 1_000;

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
}

/** What the token contract actually did, read from the settled transaction. */
interface TransferEvent {
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
  readonly contract: string;
}

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

  return { amount, currency, recipient };
}

/**
 * Extracts CAP-46 `transfer` events from a settled transaction.
 *
 * Adapted from @stellar/mpp's own `validateSimulationEvents`, with one
 * necessary difference: that function reads `xdr.DiagnosticEvent[]` from a
 * simulation and unwraps each via `.event()`. RPC's `getTransaction` returns
 * `contractEventsXdr` as `xdr.ContractEvent[][]` — already unwrapped, and
 * nested per operation. Calling `.event()` on these would throw at runtime.
 */
function collectTransferEvents(
  contractEventsXdr: xdr.ContractEvent[][],
): TransferEvent[] {
  const transfers: TransferEvent[] = [];

  for (const perOperation of contractEventsXdr) {
    for (const contractEvent of perOperation) {
      if (contractEvent.type().name !== "contract") continue;

      const body = contractEvent.body().v0();
      const topics = body.topics();
      if (topics.length < 3) continue;

      // CAP-46: topic[0] = "transfer", topic[1] = from, topic[2] = to.
      if (topics[0]?.sym?.()?.toString() !== "transfer") continue;

      const amount = scValToNative(body.data());
      if (typeof amount !== "bigint") continue;

      const contractId = contractEvent.contractId();
      if (!contractId) continue;

      transfers.push({
        from: Address.fromScVal(topics[1]!).toString(),
        to: Address.fromScVal(topics[2]!).toString(),
        amount,
        contract: Address.fromScAddress(
          xdr.ScAddress.scAddressTypeContract(contractId),
        ).toString(),
      });
    }
  }

  return transfers;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

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
 * @throws {ConfigurationError} Invalid target URL, network, or missing key.
 * @throws {TargetUnreachableError} The target never answered.
 * @throws {MalformedResponseError} The target answered, non-conformantly.
 * @throws {Error} RPC failure — reported as `harness`, never as a target defect.
 */
export async function runMppChargeChecks(
  options: MppChargeCheckOptions,
): Promise<CheckResult[]> {
  const { target, network, payerSecretKey, rpcUrl } = options;

  assertHttpUrl(target);
  assertMppNetwork(network);

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

  const advertised = await fetchChargeChallenge(target);

  const mppx = Mppx.create({ methods: [charge({ secretKey: payerSecretKey })], polyfill: false });

  let paid: Response;
  try {
    paid = await mppx.fetch(target);
  } catch (error) {
    // The target was reachable moments ago, so this is the payment path
    // failing, not the network. Report it as a conformance failure.
    throw new MalformedResponseError(
      `Payment attempt failed: ${(error as Error).message}`,
    );
  }

  if (!paid.ok) {
    return fail(
      `Paid the advertised ${advertised.amount} base units, but the target ` +
        `answered HTTP ${paid.status} instead of serving the resource.`,
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

  const server = new rpc.Server(endpoint, {
    allowHttp: endpoint.startsWith("http://"),
  });

  let settled: rpc.Api.GetTransactionResponse | undefined;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    // An RPC failure is a harness problem: it says nothing about the target.
    const current = await server.getTransaction(reference);
    if (current.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      settled = current;
      break;
    }
    await sleep(POLL_DELAY_MS);
  }

  if (!settled || settled.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    return fail(
      `Target reported settlement as tx ${reference}, but RPC still has no ` +
        `such transaction after ${POLL_ATTEMPTS} seconds. Either it was never ` +
        `broadcast, or the receipt references a transaction that does not exist.`,
    );
  }

  if (settled.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    return fail(
      `Transaction ${reference} exists on-chain but failed (status ` +
        `${settled.status}). The target reported success for a settlement that ` +
        `did not settle.`,
    );
  }

  const transfers = collectTransferEvents(settled.events.contractEventsXdr);

  if (transfers.length === 0) {
    return fail(
      `Transaction ${reference} succeeded but emitted no CAP-46 transfer ` +
        `event, so no token movement can be verified.`,
    );
  }

  // Per the MPP spec, events must show only the expected balance change.
  if (transfers.length !== 1) {
    return fail(
      `Transaction ${reference} emitted ${transfers.length} transfer events; ` +
        `exactly one was expected. Additional balance changes mean the ` +
        `settlement moved more than what was advertised.`,
    );
  }

  const actual = transfers[0]!;
  const mismatches: string[] = [];

  if (actual.amount !== advertised.amount) {
    mismatches.push(
      `amount: advertised ${advertised.amount} base units, moved ${actual.amount}`,
    );
  }
  if (actual.to !== advertised.recipient) {
    mismatches.push(
      `recipient: advertised ${advertised.recipient}, paid ${actual.to}`,
    );
  }
  if (actual.contract !== advertised.currency) {
    mismatches.push(
      `token: advertised ${advertised.currency}, moved ${actual.contract}`,
    );
  }
  // Without this, a target could reference any pre-existing transaction that
  // happens to match the amount and recipient, and never take payment at all.
  if (actual.from !== payer.publicKey()) {
    mismatches.push(
      `payer: this run paid from ${payer.publicKey()}, but the referenced ` +
        `transfer came from ${actual.from}`,
    );
  }

  if (mismatches.length > 0) {
    return fail(
      `Settlement does not match what the target advertised — ` +
        `${mismatches.join("; ")} (tx ${reference}).`,
    );
  }

  return pass(
    `Settled on-chain for exactly the advertised ${advertised.amount} base ` +
      `units of ${advertised.currency} to ${advertised.recipient}, verified ` +
      `from the transfer event (tx ${reference}).`,
  );
}
