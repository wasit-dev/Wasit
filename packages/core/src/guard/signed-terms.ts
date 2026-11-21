/**
 * The signed-terms gate (spec B17.2): what the payer's key signs is checked,
 * not only what the x402 client was asked to pay.
 *
 * L2 checks the terms Wasit hands the client: the pin, the plan, the $1 and
 * the run's cap. On Stellar the client then builds the transfer by simulating
 * it on the RPC and signs the authorization entries the simulation returns
 * (`@x402/stellar` `ExactStellarScheme.createPaymentPayload`, through
 * `AssembledTransaction.signAuthEntries`). The RPC chooses the contract, the
 * function, the arguments, the sub-invocations, how many entries name the
 * payer and the ledger the expiration is counted from. So the payer's signer
 * is wrapped: each request to sign is decoded, and the key signs only when the
 * preimage, which is exactly what the signature covers, authorizes
 * `transfer(payer, payTo, amount)` on the asset that was checked, on the run's
 * network, with no further call, once per payment, and expires no later than
 * the payment's lifetime allows. Otherwise nothing is signed.
 *
 * What the cap then rests on: a signature authorizes that one transfer, once
 * (its nonce), whoever submits it. The expiration bound keeps a signature from
 * outliving the run; the cap does not depend on it.
 */

import { performance } from "node:perf_hooks";

import { Address, hash, scValToNative, xdr } from "@stellar/stellar-sdk";

import { networkPassphrase } from "../mpp/network.js";
import { PaymentGuardRefusedError, shown } from "./budget.js";

/** What one payment may be signed for: the terms L2 checked and charged. */
export interface SigningTerms {
  /** The run's CAIP-2 network. */
  readonly network: string;
  /** The payer's address, derived from the key Wasit holds. */
  readonly payer: string;
  /** The asset contract that was checked. */
  readonly asset: string;
  /** The payee that was checked. */
  readonly payTo: string;
  /** The amount charged to the run, in base units. */
  readonly amount: string;
  /** The latest ledger (the chain's unit) the signature may stay valid to. */
  readonly maxExpiration: number;
}

/** A signature the gate let through, with the preimage it covers (base64 XDR). */
export interface SignedRecord {
  readonly preimage: string;
  readonly signature: Buffer;
}

function refuse(message: string, options: { readonly signed?: boolean } = {}): PaymentGuardRefusedError {
  return new PaymentGuardRefusedError("signed-terms", message, options);
}

/**
 * One payment's permission to sign. `preparePayment` arms it with the terms
 * it checked, right before the client builds the payment; the payer's signer
 * takes the terms once. A request to sign before it is armed, or a second one
 * in the same payment, is refused.
 */
export class SigningGate {
  #terms: SigningTerms | undefined;
  #taken = false;
  #signed: SignedRecord | undefined;

  public arm(terms: SigningTerms): void {
    if (this.#terms !== undefined) throw new Error("A signing gate is armed once, for one payment.");
    this.#terms = terms;
  }

  /** The terms it was armed with, if any. */
  public get terms(): SigningTerms | undefined {
    return this.#terms;
  }

  /** Called by the signer before it signs: the terms, once. */
  public take(): SigningTerms {
    if (this.#terms === undefined) {
      throw refuse("The payer's key was asked to sign when Wasit expected no signature.");
    }
    if (this.#taken) {
      throw refuse(
        "The x402 client asked the payer's key for a second signature in one payment; Wasit signs one per payment.",
      );
    }
    this.#taken = true;
    return this.#terms;
  }

  /** Called by the signer after it signed. */
  public record(signed: SignedRecord): void {
    if (this.#signed !== undefined) throw new Error("A signing gate records one signature.");
    this.#signed = signed;
  }

  /** The signature it let through, if any. */
  public get signed(): SignedRecord | undefined {
    return this.#signed;
  }
}

/**
 * The ledger a signature the gate let through expires at, decoded from the
 * preimage the key signed (spec B5: the expiry is read, never computed);
 * undefined when it does not decode as the address credential's preimage.
 */
export function expirationOfSigned(record: SignedRecord): number | undefined {
  try {
    const decoded = xdr.HashIdPreimage.fromXDR(record.preimage, "base64");
    if (decoded.switch().name !== "envelopeTypeSorobanAuthorization") return undefined;
    return decoded.sorobanAuthorization().signatureExpirationLedger();
  } catch {
    return undefined;
  }
}

/**
 * The run's first reading of the chain's latest unit (a ledger on Stellar),
 * and when it was read on a monotonic clock. A signature made later may stay
 * valid only for the units that can have closed since, plus its lifetime: so
 * an RPC that answers a later ledger after this reading cannot stretch it.
 */
export class SigningAnchor {
  #reading: { readonly unit: number; readonly at: number } | undefined;

  public get reading(): { readonly unit: number; readonly at: number } | undefined {
    return this.#reading;
  }

  /** Keeps the first reading only. `at` is `performance.now()` milliseconds. */
  public set(unit: number, at: number = performance.now()): void {
    if (this.#reading === undefined) this.#reading = { unit, at };
  }

  /**
   * The latest unit a signature made `now` may expire at, for a lifetime of
   * `lifetimeSeconds`, with units of `unitSeconds` (the shortest a unit takes:
   * a faster chain only tightens the bound) and 2 units of slack.
   */
  public maxExpiration(unitSeconds: number, lifetimeSeconds: number, now: number = performance.now()): number {
    const reading = this.#reading;
    if (reading === undefined) throw new Error("The anchor has no reading yet.");
    if (typeof lifetimeSeconds !== "number" || !Number.isFinite(lifetimeSeconds) || lifetimeSeconds <= 0) {
      throw refuse(
        `The payment's lifetime (${shown(lifetimeSeconds)} s) is not a positive number of seconds, so how long its ` +
          `signature would stay valid cannot be bounded.`,
      );
    }
    const elapsed = Math.max(0, now - reading.at);
    return reading.unit + Math.ceil(elapsed / (unitSeconds * 1000)) + Math.ceil(lifetimeSeconds / unitSeconds) + 2;
  }
}

const ASKED = "The authorization the x402 client asked the payer to sign";

function addressOf(value: xdr.ScVal): string | undefined {
  if (value.switch().name !== "scvAddress") return undefined;
  try {
    return Address.fromScVal(value).toString();
  } catch {
    return undefined;
  }
}

/**
 * Throws, so that nothing is signed, unless the Soroban authorization preimage
 * `preimage` (base64 XDR, as the SDK hands it to the signer) authorizes exactly
 * `transfer(payer, payTo, amount)` on `asset`, on the run's network, with no
 * sub-invocation, expiring no later than `maxExpiration`.
 *
 * Only the address credential's preimage is signed: the address-bound form
 * (`AddressV2`, delegates) is refused, as is anything that does not decode.
 */
export function checkStellarPreimage(preimage: string, terms: SigningTerms): void {
  let decoded: xdr.HashIdPreimage;
  try {
    decoded = xdr.HashIdPreimage.fromXDR(preimage, "base64");
  } catch {
    throw refuse(`${ASKED} does not decode as a Soroban authorization.`);
  }
  if (decoded.switch().name !== "envelopeTypeSorobanAuthorization") {
    throw refuse(`${ASKED} is a form of authorization Wasit does not sign (it signs the address credential only).`);
  }
  const authorization = decoded.sorobanAuthorization();

  const networkId = hash(Buffer.from(networkPassphrase(terms.network)));
  if (!Buffer.from(authorization.networkId()).equals(networkId)) {
    throw refuse(`${ASKED} is for another network than this run's (${terms.network}).`);
  }

  const invocation = authorization.invocation();
  const fn = invocation.function();
  if (fn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") {
    throw refuse(`${ASKED} is not a contract call.`);
  }
  const call = fn.contractFn();
  let contract: string;
  try {
    contract = Address.fromScAddress(call.contractAddress()).toString();
  } catch {
    throw refuse(`${ASKED} calls a contract whose address does not decode.`);
  }
  if (contract !== terms.asset) {
    throw refuse(`${ASKED} calls the contract ${shown(contract)}, not the asset ${terms.asset} that was checked.`);
  }
  const name = call.functionName().toString();
  if (name !== "transfer") {
    throw refuse(`${ASKED} calls ${shown(name)} instead of transfer.`);
  }
  const args = call.args();
  if (args.length !== 3) {
    throw refuse(`${ASKED} gives transfer ${args.length} arguments instead of 3 (from, to, amount).`);
  }

  const from = addressOf(args[0]!);
  if (from !== terms.payer) {
    throw refuse(`${ASKED} transfers from ${from === undefined ? "something that is not an address" : shown(from)}, not from the payer.`);
  }
  const to = addressOf(args[1]!);
  if (to !== terms.payTo) {
    throw refuse(
      `${ASKED} pays ${to === undefined ? "something that is not an address" : shown(to)}, not ${terms.payTo}, ` +
        `the payee that was checked.`,
    );
  }
  if (!/^[1-9][0-9]*$/.test(terms.amount)) {
    throw refuse(`The amount checked for this payment (${shown(terms.amount)}) is not a positive number of base units.`);
  }
  if (args[2]!.switch().name !== "scvI128") {
    throw refuse(`${ASKED} gives the amount as ${args[2]!.switch().name}, not as the i128 of base units transfer takes.`);
  }
  const amount = scValToNative(args[2]!) as bigint;
  if (amount !== BigInt(terms.amount)) {
    throw refuse(`${ASKED} is for ${shown(String(amount))} base units, not the ${terms.amount} that was checked.`);
  }

  const further = invocation.subInvocations().length;
  if (further !== 0) {
    throw refuse(`${ASKED} also authorizes ${further} further call${further === 1 ? "" : "s"} beside the transfer.`);
  }

  const expiration = authorization.signatureExpirationLedger();
  if (expiration > terms.maxExpiration) {
    throw refuse(
      `${ASKED} stays valid until ledger ${expiration}, past ledger ${terms.maxExpiration}, the latest this ` +
        `payment's lifetime allows.`,
    );
  }
}
