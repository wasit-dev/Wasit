/**
 * The `exact` scheme on Stellar: Soroban authorization entries signed by the
 * payer, settlement read from the token contract's `transfer` event on
 * Stellar RPC (settlement.ts). This is the chain Wasit was built on, and the
 * only one with MPP as well.
 */

import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme as ExactStellarClientScheme } from "@x402/stellar/exact/client";
import { Keypair, xdr } from "@stellar/stellar-sdk";

import { CheckSetupError } from "../../errors.js";
import { resolveRpcUrl } from "../../mpp/network.js";
import { verifySettlement } from "../../settlement.js";
import type { PaymentChain } from "./types.js";

/** A Stellar transaction hash: 64 hex characters. */
const TRANSACTION_HASH = /^[0-9a-f]{64}$/i;

/**
 * Corrupts the client's authorization signature, and nothing else.
 *
 * In the `exact` scheme on Stellar the client signs a Soroban authorization
 * entry, not the envelope: the facilitator signs the envelope later. So the
 * signature that proves the payer consented is the address credential's
 * `signature`, a `Vec<{ public_key, signature }>`. Flipping one byte of it
 * leaves a transaction that still decodes, carries the same amount, payer and
 * recipient, and fails only signature verification. A target can refuse it
 * only by verifying the signature.
 *
 * Throws {@link CheckSetupError} if the payload carries no such signature, so
 * the check reports no verdict rather than one it did not establish.
 */
export function corruptAuthSignature(transaction: string): string {
  const envelope = xdr.TransactionEnvelope.fromXDR(transaction, "base64");
  const operations =
    envelope.switch().name === "envelopeTypeTx" ? envelope.v1().tx().operations() : [];

  let corrupted = false;
  for (const operation of operations) {
    if (operation.body().switch().name !== "invokeHostFunction") continue;
    for (const entry of operation.body().invokeHostFunctionOp().auth()) {
      const credentials = entry.credentials();
      if (credentials.switch().name !== "sorobanCredentialsAddress") continue;
      const signature = credentials.address().signature();
      if (signature.switch().name !== "scvVec") continue;
      for (const item of signature.vec() ?? []) {
        if (item.switch().name !== "scvMap") continue;
        for (const field of item.map() ?? []) {
          if (field.key().switch().name !== "scvSymbol") continue;
          if (field.key().sym().toString() !== "signature") continue;
          const bytes = Buffer.from(field.val().bytes());
          bytes[0] = bytes[0]! ^ 0xff;
          field.val(xdr.ScVal.scvBytes(bytes));
          corrupted = true;
        }
      }
    }
  }

  if (!corrupted) {
    throw new CheckSetupError(
      "The payment payload carries no authorization-entry signature to " +
        "corrupt, so a corrupted signature cannot be tested.",
    );
  }
  return envelope.toXDR("base64");
}

export const stellarChain: PaymentChain = {
  name: "Stellar",
  networks: ["stellar:testnet", "stellar:pubnet"],
  payerKeyEnv: "STELLAR_PRIVATE_KEY",
  referenceKind: "a settled Stellar transaction hash",
  resolveRpcUrl: (network, override) => resolveRpcUrl(network, override),
  registerPayer(client, network, payerKey) {
    const signer = createEd25519Signer(payerKey, network as `${string}:${string}`);
    client.register("stellar:*", new ExactStellarClientScheme(signer));
  },
  payerAddress: (payerKey) => Keypair.fromSecret(payerKey).publicKey(),
  isSettlementReference: (reference) => TRANSACTION_HASH.test(reference),
  verifySettlement,
  corruptPayload: (payload) => ({
    ...payload,
    transaction: corruptAuthSignature(payload["transaction"] as string),
  }),
};
