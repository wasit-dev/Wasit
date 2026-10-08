/**
 * The `exact` scheme on Solana: the payer signs a transaction carrying one
 * `TransferChecked` to the payee's associated token account, and the sponsor
 * named in `extra.feePayer` (usually the facilitator) adds its signature as
 * fee payer and submits it (`scheme_exact_svm.md`). So a payer needs the
 * token, and no SOL.
 *
 * Settlement is read from the confirmed transaction's token balances, the
 * outcome the spec defines a payment by: exactly one transfer of the
 * advertised amount of the advertised mint, from this run's payer to an
 * account `payTo` owns, as the other adapters hold the token's own transfer
 * record. Only Solana devnet for now: the official SDK ships its
 * USDC and the public facilitator settles there.
 */

import { createPrivateKey, generateKeyPairSync } from "node:crypto";

import { DEVNET_RPC_URL, SOLANA_DEVNET_CAIP2 } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
  isSignature,
  signature,
  type Blockhash,
  type Transaction,
} from "@solana/kit";

import { CheckSetupError, ConfigurationError } from "../../errors.js";
import type { ExpectedSettlement, SettlementVerdict } from "../../settlement.js";
import type { PaymentChain } from "./types.js";
import { waitForReceipt } from "./wait.js";

/** The networks this adapter pays on, with the SDK's default RPC for each. */
const NETWORKS: Readonly<Record<string, string>> = {
  [SOLANA_DEVNET_CAIP2]: DEVNET_RPC_URL,
};

/**
 * How long to look for the settled transaction, in slots: 150, the lifetime
 * of a blockhash. Devnet produced 152 slots in about 37 seconds on
 * 2026-10-05. The facilitator answers only once the transaction is confirmed,
 * so a real settlement is visible at once; a cited signature still missing
 * after this was never broadcast.
 */
const SLOTS_BEFORE_MISSING = 150n;

/**
 * How far back X402-10 takes its blockhash. A transaction is valid for 150
 * blocks after its blockhash; 300 slots back is past that even if half the
 * slots in between were skipped, and the RPC confirms it before it is used.
 */
const EXPIRED_SLOTS_BACK = 300n;

/** RFC 8410's PKCS#8 prefix for a raw 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Whether the public half of a 64-byte Solana keypair belongs to its seed. */
function keypairMatches(bytes: Uint8Array): boolean {
  // An Ed25519 private JWK carries its public key as `x`.
  const { x } = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, bytes.subarray(0, 32)]),
    format: "der",
    type: "pkcs8",
  }).export({ format: "jwk" });
  return x !== undefined && Buffer.from(x, "base64url").equals(bytes.subarray(32));
}

/**
 * The payer's 64-byte keypair from its base58 export, as wallets and the
 * SDK's examples write `SVM_PRIVATE_KEY`.
 *
 * A keypair whose public half is not its seed's would sign as one address
 * while Wasit holds the settlement to another, so it is refused here, before
 * any payment. The message never echoes the key: it is a secret, and a
 * malformed one is often a real key pasted with a character missing.
 */
function secretKeyBytes(payerKey: string): Uint8Array {
  let bytes: Uint8Array | undefined;
  try {
    bytes = new Uint8Array(getBase58Encoder().encode(payerKey));
  } catch {
    bytes = undefined;
  }
  if (bytes === undefined || bytes.length !== 64 || !keypairMatches(bytes)) {
    throw new ConfigurationError(
      "SVM_PRIVATE_KEY is not a Solana keypair: expected the base58 encoding of " +
        "its 64 bytes (seed, then public key), as wallets export it.",
    );
  }
  return bytes;
}

/** A token account's balance in a transaction's metadata, as RPC reports it. */
export interface SvmTokenBalance {
  readonly accountIndex: number | bigint;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: { readonly amount: string };
}

/** A confirmed transaction, reduced to what a settlement is read from. */
export interface SvmTransaction {
  readonly meta: {
    readonly err: unknown;
    readonly preTokenBalances?: readonly SvmTokenBalance[] | null;
    readonly postTokenBalances?: readonly SvmTokenBalance[] | null;
  } | null;
}

/** How one token account's balance moved in a transaction. */
export interface SvmBalanceChange {
  readonly mint: string;
  readonly owner: string;
  readonly delta: bigint;
}

/**
 * The token balances a transaction changed, from its pre- and post-balances.
 *
 * An account missing from the pre-balances was created in the transaction,
 * and one missing from the post-balances was closed; both count from zero.
 * Throws when RPC leaves out an account's owner, since then the recipient and
 * the payer cannot be read, and that says nothing about the target.
 */
export function svmBalanceChanges(meta: NonNullable<SvmTransaction["meta"]>): SvmBalanceChange[] {
  const accounts = new Map<string, { mint: string; owner?: string; pre: bigint; post: bigint }>();
  const record = (balance: SvmTokenBalance, side: "pre" | "post") => {
    const key = `${balance.accountIndex}:${balance.mint}`;
    const entry = accounts.get(key) ?? { mint: balance.mint, pre: 0n, post: 0n };
    entry.owner ??= balance.owner;
    entry[side] = BigInt(balance.uiTokenAmount.amount);
    accounts.set(key, entry);
  };
  for (const balance of meta.preTokenBalances ?? []) record(balance, "pre");
  for (const balance of meta.postTokenBalances ?? []) record(balance, "post");

  const changes: SvmBalanceChange[] = [];
  for (const entry of accounts.values()) {
    if (entry.post === entry.pre) continue;
    if (entry.owner === undefined) {
      throw new Error(
        "RPC reported a token balance change without the account's owner, so the " +
          "settlement's payer and recipient cannot be read. Point --rpc-url at an " +
          "endpoint that returns token balance owners.",
      );
    }
    changes.push({ mint: entry.mint, owner: entry.owner, delta: entry.post - entry.pre });
  }
  return changes;
}

/**
 * Holds a confirmed transaction to what the target advertised.
 *
 * The same rules as on Stellar and EVM: the transaction succeeded, it moved
 * exactly one token transfer (one account debited, one credited, by the same
 * amount of the same mint), and that transfer is the advertised amount of the
 * advertised mint, to an account `payTo` owns, from this run's own payer, so
 * a target cannot cite some other transaction that happens to match.
 */
export function verifySvmTransaction(
  transaction: SvmTransaction,
  reference: string,
  expected: ExpectedSettlement,
): SettlementVerdict {
  const fail = (detail: string): SettlementVerdict => ({ pass: false, detail });

  if (transaction.meta === null) {
    throw new Error(
      `RPC returned transaction ${reference} without its status, so whether it ` +
        `succeeded cannot be read. Re-run, or point --rpc-url at another endpoint.`,
    );
  }
  if (transaction.meta.err !== null) {
    return fail(
      `Transaction ${reference} exists on-chain but failed ` +
        `(${JSON.stringify(transaction.meta.err)}). The target reported success for ` +
        `a settlement that did not settle.`,
    );
  }

  const changes = svmBalanceChanges(transaction.meta);
  if (changes.length === 0) {
    return fail(
      `Transaction ${reference} succeeded but changed no token balance, so no ` +
        `token movement can be verified.`,
    );
  }
  const credit = changes.find((change) => change.delta > 0n);
  const debit = changes.find((change) => change.delta < 0n);
  if (
    changes.length !== 2 ||
    credit === undefined ||
    debit === undefined ||
    credit.mint !== debit.mint ||
    credit.delta !== -debit.delta
  ) {
    return fail(
      `Transaction ${reference} changed ${changes.length} token balances in a way ` +
        `that is not one transfer; exactly one was expected. Additional balance ` +
        `changes mean the settlement moved more than what was advertised.`,
    );
  }

  const mismatches: string[] = [];
  if (credit.delta !== expected.amount) {
    mismatches.push(`amount: advertised ${expected.amount} base units, moved ${credit.delta}`);
  }
  if (credit.owner !== expected.recipient) {
    mismatches.push(`recipient: advertised ${expected.recipient}, paid ${credit.owner}`);
  }
  if (credit.mint !== expected.token) {
    mismatches.push(`token: advertised ${expected.token}, moved ${credit.mint}`);
  }
  if (debit.owner !== expected.payer) {
    mismatches.push(
      `payer: this run paid from ${expected.payer}, but the referenced transfer ` +
        `came from ${debit.owner}`,
    );
  }
  if (mismatches.length > 0) {
    return fail(
      `Settlement does not match what the target advertised — ` +
        `${mismatches.join("; ")} (tx ${reference}).`,
    );
  }
  return {
    pass: true,
    detail:
      `settled on-chain for exactly the advertised ${expected.amount} base ` +
      `units of ${expected.token} to ${expected.recipient}, verified from the ` +
      `transaction's token balances (tx ${reference})`,
  };
}

async function verifySvmSettlement(
  rpcUrl: string,
  reference: string,
  expected: ExpectedSettlement,
): Promise<SettlementVerdict> {
  const rpc = createSolanaRpc(rpcUrl);
  const lookup = await waitForReceipt(
    async () =>
      ((await rpc
        .getTransaction(signature(reference), {
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        })
        .send()) as SvmTransaction | null) ?? undefined,
    () => rpc.getSlot({ commitment: "confirmed" }).send(),
    { blocks: SLOTS_BEFORE_MISSING },
  );

  if (lookup.kind === "stalled") {
    // An RPC that is not advancing says nothing about the target: no verdict.
    throw new Error(
      `RPC at ${rpcUrl} advanced only ${lookup.blocksWatched} slots in ` +
        `${Math.round(lookup.waitedMs / 1000)} seconds while looking for tx ` +
        `${reference}, so its absence says nothing about the target. Re-run, ` +
        `or point --rpc-url at another endpoint.`,
    );
  }
  if (lookup.kind === "missing") {
    return {
      pass: false,
      detail:
        `Target reported settlement as tx ${reference}, but the chain advanced ` +
        `${lookup.blocksWatched} more slots without it. Either it was never ` +
        `broadcast, or the target referenced a transaction that does not exist.`,
    };
  }
  return verifySvmTransaction(lookup.receipt, reference, expected);
}

/**
 * A real blockhash that is already past its lifetime.
 *
 * On Solana a payment's lifetime is its transaction's recent blockhash, not
 * `maxTimeoutSeconds`, which the SDK client does not read. The client builds
 * on `extra.recentBlockhash` when it is given one (spec: a hint the server
 * may supply), so X402-10 hands it one that has expired, rather than holding
 * a fresh payment for the minute or more it takes to expire. The RPC is asked
 * whether it is still valid, so the check never sends a payment that might
 * yet land.
 */
async function expiredBlockhash(rpcUrl: string): Promise<Blockhash> {
  const rpc = createSolanaRpc(rpcUrl);
  const slot = await rpc.getSlot({ commitment: "finalized" }).send();
  const [old] = await rpc
    .getBlocksWithLimit(slot - EXPIRED_SLOTS_BACK, 1, { commitment: "finalized" })
    .send();
  const block =
    old === undefined
      ? null
      : await rpc
          .getBlock(old, {
            commitment: "finalized",
            maxSupportedTransactionVersion: 0,
            rewards: false,
            transactionDetails: "none",
          })
          .send();
  if (block === null) {
    throw new CheckSetupError(
      `RPC at ${rpcUrl} returned no block from ${EXPIRED_SLOTS_BACK} slots back, so ` +
        `an expired payment cannot be built.`,
    );
  }
  const { value: valid } = await rpc
    .isBlockhashValid(block.blockhash, { commitment: "finalized" })
    .send();
  if (valid) {
    throw new CheckSetupError(
      `RPC at ${rpcUrl} still accepts blockhash ${block.blockhash} from ` +
        `${EXPIRED_SLOTS_BACK} slots back, so a payment built on it might land.`,
    );
  }
  return block.blockhash;
}

/**
 * Corrupts the payer's signature, and nothing else.
 *
 * The payload is a partially signed transaction: the payer has signed, and
 * the fee payer's slot is still empty until the sponsor signs at settlement.
 * Flipping the first byte of the one signature present leaves a transaction
 * that decodes, with the same transfer, amount and blockhash, whose payer
 * signature no longer verifies. A target can refuse it only by verifying it.
 */
export function corruptSvmSignature(payload: Record<string, unknown>): Record<string, unknown> {
  const wire = payload["transaction"];
  let transaction: Transaction | undefined;
  try {
    transaction =
      typeof wire === "string" ? getTransactionDecoder().decode(getBase64Encoder().encode(wire)) : undefined;
  } catch {
    transaction = undefined;
  }
  const signed = Object.entries(transaction?.signatures ?? {}).filter(([, bytes]) => bytes !== null);
  if (transaction === undefined || signed.length !== 1) {
    throw new CheckSetupError(
      "The payment payload carries no partially signed Solana transaction with " +
        "exactly one signature, the payer's, so a corrupted signature cannot be tested.",
    );
  }
  const [signer, bytes] = signed[0]!;
  const forged = new Uint8Array(bytes!);
  forged[0] = forged[0]! ^ 0xff;
  const corrupted = {
    ...transaction,
    signatures: { ...transaction.signatures, [signer]: forged },
  } as Transaction;
  return {
    ...payload,
    transaction: getBase64Decoder().decode(getTransactionEncoder().encode(corrupted)),
  };
}

export const svmChain: PaymentChain = {
  name: "Solana",
  networks: Object.keys(NETWORKS),
  payerKeyEnv: "SVM_PRIVATE_KEY",
  referenceKind: "a Solana transaction signature",
  resolveRpcUrl(network, override) {
    const fallback = NETWORKS[network];
    if (fallback === undefined) {
      throw new ConfigurationError(`No Solana network "${network}" in Wasit's payment checks.`);
    }
    return override || fallback;
  },
  async registerPayer(client, _network, payerKey, rpcUrl) {
    // The client reads the chain while building: the mint's token program and
    // decimals, and a recent blockhash unless the target supplies one.
    const signer = await createKeyPairSignerFromBytes(secretKeyBytes(payerKey));
    client.register("solana:*", new ExactSvmScheme(signer, { rpcUrl }));
  },
  async expiredSigning(selected, rpcUrl) {
    return {
      terms: { extra: { ...selected.extra, recentBlockhash: await expiredBlockhash(rpcUrl) } },
      holdMs: 0,
    };
  },
  payerAddress: (payerKey) => getBase58Decoder().decode(secretKeyBytes(payerKey).subarray(32)),
  generatePayerKey() {
    // The wallet export form: base58 of the seed followed by the public key.
    const { d, x } = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    return getBase58Decoder().decode(
      new Uint8Array([...Buffer.from(d!, "base64url"), ...Buffer.from(x!, "base64url")]),
    );
  },
  async payerBalance(_network, rpcUrl, payer, asset) {
    // Every token account the payer holds for the mint, summed: the client
    // pays from the associated one only, so this is never less than what it
    // can spend, and a sum below the price means the payment cannot settle.
    const { value } = await createSolanaRpc(rpcUrl)
      .getTokenAccountsByOwner(address(payer), { mint: address(asset) }, {
        encoding: "jsonParsed",
        commitment: "confirmed",
      })
      .send();
    let total = 0n;
    for (const account of value) {
      const amount = (account.account.data as { parsed?: { info?: { tokenAmount?: { amount?: unknown } } } })
        .parsed?.info?.tokenAmount?.amount;
      if (typeof amount !== "string" || !/^\d+$/.test(amount)) return undefined;
      total += BigInt(amount);
    }
    return total;
  },
  isSettlementReference(reference) {
    // kit's isSignature throws, rather than answering false, on a string of
    // the right length outside the base58 alphabet (an EVM hash, for one).
    try {
      return isSignature(reference);
    } catch {
      return false;
    }
  },
  verifySettlement: (_network, rpcUrl, reference, expected) => verifySvmSettlement(rpcUrl, reference, expected),
  corruptPayload: corruptSvmSignature,
};
