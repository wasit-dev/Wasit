/**
 * What the x402 payment checks need that differs from chain to chain.
 *
 * X402-01 through X402-05 need none of it: they read the challenge only, and
 * apply to an x402 service on any chain. X402-06 to X402-10 build real
 * payments, so they need a signer, a way to look the settlement up, and a way
 * to forge only the payer's signature. One adapter per chain family supplies
 * those, and the checks themselves stay the same everywhere.
 */

import type { x402Client } from "@x402/fetch";

import type { ExpectedSettlement, SettlementVerdict } from "../../settlement.js";

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
   * How long X402-10 holds a payment signed with a one-second lifetime before
   * sending it, so it has certainly expired on this chain.
   */
  readonly expiryWaitMs: number;
  /**
   * The RPC endpoint X402-06 verifies the settlement on. Throws
   * `ConfigurationError` when there is none, before any payment is made.
   */
  resolveRpcUrl(network: string, override?: string): string;
  /**
   * Registers this chain's `exact` client scheme, signing with `payerKey`.
   * `rpcUrl` is for client schemes that read the chain while building a
   * payment (EVM Permit2 checks the token allowance); others ignore it.
   */
  registerPayer(client: x402Client, network: string, payerKey: string, rpcUrl: string): void;
  /** The payer's address, which the settlement must come from. */
  payerAddress(payerKey: string): string;
  /** Whether `reference` has the shape of a settlement on this chain. */
  isSettlementReference(reference: string): boolean;
  /**
   * Looks the settlement up and holds it to the advertised terms. Returns a
   * verdict about the target; throws when the chain's RPC gives no answer,
   * which says nothing about the target.
   */
  verifySettlement(
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
}
