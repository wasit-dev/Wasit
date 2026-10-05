/**
 * The `exact` scheme on Stellar: Soroban authorization entries signed by the
 * payer, settlement read from the token contract's `transfer` event on
 * Stellar RPC (settlement.ts). This is the chain Wasit was built on, and the
 * only one with MPP as well.
 */

import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme as ExactStellarClientScheme } from "@x402/stellar/exact/client";
import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { CheckSetupError } from "../../errors.js";
import { networkPassphrase, resolveRpcUrl } from "../../mpp/network.js";
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

/**
 * A format-valid all-zero account, as the simulation source: a read-only
 * simulation never touches it, so it need not exist (channel-commitment.ts
 * uses the same).
 */
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** A read-only contract call, simulated; undefined unless it succeeds with a value. */
async function simulateTokenRead(
  server: rpc.Server,
  passphrase: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  const transaction = new TransactionBuilder(new Account(SIMULATION_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (
    !rpc.Api.isSimulationSuccess(simulation) ||
    rpc.Api.isSimulationRestore(simulation) ||
    simulation.result === undefined
  ) {
    return undefined;
  }
  return scValToNative(simulation.result.retval);
}

/**
 * The classic asset a Stellar Asset Contract wraps, from the `name` it
 * reports ("CODE:ISSUER", CAP-46-06), only when that asset's contract id is
 * `contractId`: any contract can return such a name, but only the SAC has
 * the id derived from the asset.
 */
export function sacAssetFromName(name: unknown, contractId: string, passphrase: string): Asset | undefined {
  if (typeof name !== "string") return undefined;
  const match = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/.exec(name);
  if (match === null || !StrKey.isValidEd25519PublicKey(match[2]!)) return undefined;
  const asset = new Asset(match[1]!, match[2]!);
  return asset.contractId(passphrase) === contractId ? asset : undefined;
}

/**
 * The payer's balance of a SEP-41 token, read by simulating its `balance`.
 *
 * A Stellar Asset Contract reports a payer without a trustline as an error,
 * not as zero, and an unfunded payer is the usual case. So when `balance`
 * gives no value and the token is a SAC, the trustline is looked up: none
 * means the payer holds nothing. The asset's issuer needs no trustline, so it
 * is left unread. Anything else gives undefined.
 */
async function stellarTokenBalance(
  network: string,
  rpcUrl: string,
  payer: string,
  asset: string,
): Promise<bigint | undefined> {
  if (!StrKey.isValidContract(asset) || !StrKey.isValidEd25519PublicKey(payer)) return undefined;
  const passphrase = networkPassphrase(network);
  const server = new rpc.Server(rpcUrl);
  const balance = await simulateTokenRead(server, passphrase, asset, "balance", [
    new Address(payer).toScVal(),
  ]);
  if (typeof balance === "bigint") return balance;

  const classic = sacAssetFromName(
    await simulateTokenRead(server, passphrase, asset, "name", []),
    asset,
    passphrase,
  );
  if (classic === undefined || classic.getIssuer() === payer) return undefined;
  const { entries } = await server.getLedgerEntries(
    xdr.LedgerKey.trustline(
      new xdr.LedgerKeyTrustLine({
        accountId: Keypair.fromPublicKey(payer).xdrAccountId(),
        asset: classic.toTrustLineXDRObject(),
      }),
    ),
  );
  return entries.length === 0 ? 0n : undefined;
}

export const stellarChain: PaymentChain = {
  name: "Stellar",
  networks: ["stellar:testnet", "stellar:pubnet"],
  payerKeyEnv: "STELLAR_PRIVATE_KEY",
  referenceKind: "a settled Stellar transaction hash",
  resolveRpcUrl: (network, override) => resolveRpcUrl(network, override),
  registerPayer(client, network, payerKey, _rpcUrl) {
    const signer = createEd25519Signer(payerKey, network as `${string}:${string}`);
    client.register("stellar:*", new ExactStellarClientScheme(signer));
  },
  // A one-second lifetime is one ledger (ceil(1 / 5)); ledgers close about
  // every 5 to 6 seconds, so 20 seconds is three or more ledgers past it.
  expiredSigning: async () => ({ terms: { maxTimeoutSeconds: 1 }, holdMs: 20_000 }),
  payerAddress: (payerKey) => Keypair.fromSecret(payerKey).publicKey(),
  payerBalance: stellarTokenBalance,
  isSettlementReference: (reference) => TRANSACTION_HASH.test(reference),
  verifySettlement,
  corruptPayload: (payload) => ({
    ...payload,
    transaction: corruptAuthSignature(payload["transaction"] as string),
  }),
};
