/**
 * What the x402 payment checks need that differs from chain to chain.
 *
 * X402-01 through X402-05 need none of it: they read the challenge only, and
 * apply to an x402 service on any chain. X402-06 to X402-10 build real
 * payments, so they need a signer, a way to look the settlement up, and a way
 * to forge only the payer's signature. One adapter per chain family supplies
 * those, and the checks themselves stay the same everywhere.
 */

import type { PaymentRequirements } from "@x402/core/types";
import type { x402Client } from "@x402/fetch";

import type { ExpectedSettlement, SettlementVerdict } from "../../settlement.js";

/**
 * What a negative check signs differently from the honest payment. The
 * payload still claims, in `accepted`, the terms the target advertised, so the
 * only thing wrong with it is what was signed.
 */
export interface AlteredSigning {
  readonly amount?: string;
  readonly maxTimeoutSeconds?: number;
  readonly extra?: Record<string, unknown>;
}

/** How X402-10 builds a payment that has expired by the time it is sent. */
export interface ExpiredSigning {
  /** The terms to sign the payment for. */
  readonly terms: AlteredSigning;
  /** How long to hold the signed payment before sending it. */
  readonly holdMs: number;
}

/**
 * One signed authorization of a payment, as the chain records its use
 * (X402-11, D-032). Decoded from what the payer signed, never computed.
 */
export interface SignedAuthorization {
  /** The address that signed it. X402-11 holds it to the run's payer. */
  readonly payer: string;
  /** Its single-use id on the chain (on Stellar the auth entry's nonce), as text. */
  readonly nonce: string;
  /** The last ledger (or block) it can be used in, as signed. */
  readonly expiresAt: number;
}

/** One read of the chain about some authorizations, all at the same state. */
export interface AuthorizationRead {
  /** The chain's latest closed ledger when it answered. */
  readonly latest: number;
  /**
   * Per authorization asked for, in order: the ledger its use was recorded in,
   * or undefined when the chain holds no record of a use.
   */
  readonly used: readonly (number | undefined)[];
}

/** A transfer the chain recorded, as X402-11's second reading counts it. */
export interface RecordedTransfer {
  readonly amount: bigint;
  /** The transaction that made it (a hash), for the report. */
  readonly reference: string;
  readonly ledger: number;
}

/**
 * How X402-11 reads whether an authorization was used, on chains where that
 * can be read directly. A chain without one does not run X402-11.
 */
export interface AuthorizationWatch {
  /** What the chain's unit of time is called in a report: "ledger". */
  readonly unit: string;
  /** About how long one unit lasts, in milliseconds: the watch reads once per unit. */
  readonly unitMs: number;
  /**
   * The authorization a payment payload's inner `payload` carries. Throws
   * `CheckSetupError` when it carries none that can be read, or more than one.
   */
  decode(payload: Record<string, unknown>): SignedAuthorization;
  /** Whether each authorization was used, read in one call, so all at one state of the chain. */
  read(network: string, rpcUrl: string, authorizations: readonly SignedAuthorization[]): Promise<AuthorizationRead>;
  /**
   * Every successful transfer of `asset` from `from` to `to` recorded from
   * ledger `fromLedger` on. Throws when the chain cannot serve that range in
   * full: a partial answer is never read as "no transfer".
   */
  transfers(
    network: string,
    rpcUrl: string,
    query: { readonly asset: string; readonly from: string; readonly to: string; readonly fromLedger: number },
  ): Promise<{ readonly latest: number; readonly transfers: readonly RecordedTransfer[] }>;
}

export interface PaymentChain {
  /** The chain family's name, for reports. */
  readonly name: string;
  /** The CAIP-2 networks Wasit pays on with this adapter. */
  readonly networks: readonly string[];
  /** The environment variable front ends read the payer key from. */
  readonly payerKeyEnv: string;
  /** What a settlement reference is on this chain, for a report ("a ... hash"). */
  readonly referenceKind: string;
  /**
   * The RPC endpoint X402-06 verifies the settlement on. Throws
   * `ConfigurationError` when there is none, before any payment is made.
   */
  resolveRpcUrl(network: string, override?: string): string;
  /**
   * Registers this chain's `exact` client scheme, signing with `payerKey`.
   * `rpcUrl` is for client schemes that read the chain while building a
   * payment (EVM Permit2 checks the token allowance, Solana fetches the mint
   * and a blockhash); others ignore it.
   */
  registerPayer(
    client: x402Client,
    network: string,
    payerKey: string,
    rpcUrl: string,
  ): void | Promise<void>;
  /**
   * How X402-10 makes a payment that has expired when it arrives, for the
   * option `selected`. Where the client derives the lifetime from
   * `maxTimeoutSeconds`, a one-second lifetime and a hold long enough for the
   * chain to pass it.
   */
  expiredSigning(selected: PaymentRequirements, rpcUrl: string): Promise<ExpiredSigning>;
  /** The payer's address, which the settlement must come from. */
  payerAddress(payerKey: string): string;
  /** A new random payer key, in the form `payerKeyEnv` takes. */
  generatePayerKey(): string;
  /**
   * The payer's balance of `asset`, in base units, as the chain reports it,
   * or at most what the payer can spend from (never more than it holds).
   * Undefined, or a throw, when the chain gives no clear answer: X402-06 then
   * pays as if the balance were enough, so a failed read never becomes a
   * verdict.
   */
  payerBalance(network: string, rpcUrl: string, payer: string, asset: string): Promise<bigint | undefined>;
  /** Whether `reference` has the shape of a settlement on this chain. */
  isSettlementReference(reference: string): boolean;
  /**
   * Looks the settlement up on `network` and holds it to the advertised
   * terms. Returns a verdict about the target; throws when the chain's RPC
   * gives no answer, which says nothing about the target.
   */
  verifySettlement(
    network: string,
    rpcUrl: string,
    reference: string,
    expected: ExpectedSettlement,
  ): Promise<SettlementVerdict>;
  /**
   * The payment payload's inner `payload` with the payer's signature, and
   * nothing else, corrupted. Throws `CheckSetupError` when there is no
   * signature to corrupt.
   */
  corruptPayload(payload: Record<string, unknown>): Record<string, unknown>;
  /** X402-11's chain reads. Absent: X402-11 is skipped on this chain, nothing signed. */
  readonly authorizations?: AuthorizationWatch;
}
