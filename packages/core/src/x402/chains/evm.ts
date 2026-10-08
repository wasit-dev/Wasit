/**
 * The `exact` scheme on EVM, with the EIP-3009 transfer method (USDC's
 * `transferWithAuthorization`): the payer signs an authorization off-chain,
 * the facilitator submits it and pays the gas (`scheme_exact_evm.md`). So a
 * payer needs the token and nothing else. A target that advertises the
 * Permit2 method instead is paid through Permit2; with the
 * `eip2612GasSponsoring` extension its one-time approval is a signed permit
 * the facilitator submits, so that path needs no gas either.
 *
 * Settlement is read from the transaction receipt: the token contract's own
 * ERC-20 `Transfer` log is held to the advertised terms, as the Stellar
 * adapter holds the `transfer` event. Base Sepolia, where the official SDK
 * ships its USDC and the public facilitator settles, and Ethereum
 * Sepolia, which Circle's USDC with EIP-3009 also serves but no public
 * facilitator settles.
 */

import { toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import {
  TransactionReceiptNotFoundError,
  createPublicClient,
  erc20Abi,
  http,
  isAddress,
  isAddressEqual,
  toEventSelector,
  type Chain,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";

import { CheckSetupError, ConfigurationError } from "../../errors.js";
import type { ExpectedSettlement, SettlementVerdict } from "../../settlement.js";
import type { PaymentChain } from "./types.js";
import { waitForReceipt } from "./wait.js";

/** What differs between the EVM networks this adapter pays on. */
interface EvmNetwork {
  /** viem's definition, whose first default RPC is the default endpoint. */
  readonly chain: Chain;
  /**
   * How long to look for the settled transaction, in blocks, as the Stellar
   * adapter counts ledgers: about a minute or two of the chain's own blocks,
   * long enough for any facilitator that reports a hash before its receipt,
   * short enough that a fabricated hash fails soon.
   */
  readonly blocksBeforeMissing: bigint;
  /** The wall-clock limit on that wait, past which a still RPC gives no verdict. */
  readonly maxWaitMs: number;
  /**
   * Tokens to pay in besides the SDK's default assets. The SDK client's spend
   * controls refuse any other asset; each entry keeps the cap the SDK puts on
   * its defaults, $1 a payment, as base units.
   */
  readonly allowedAssets?: readonly { readonly asset: string; readonly maxAmountPerPayment: string }[];
}

/**
 * Circle's USDC on Ethereum Sepolia: EIP-3009, EIP-712 domain "USDC" version
 * "2", 6 decimals (read from the contract, 2026-10-05). Not an SDK default.
 */
export const ETHEREUM_SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

const NETWORKS: Readonly<Record<string, EvmNetwork>> = {
  // A block every 2 seconds: 30 blocks is about a minute.
  "eip155:84532": { chain: baseSepolia, blocksBeforeMissing: 30n, maxWaitMs: 120_000 },
  // A block every 12 seconds: 10 blocks is about two minutes.
  "eip155:11155111": {
    chain: sepolia,
    blocksBeforeMissing: 10n,
    maxWaitMs: 240_000,
    allowedAssets: [{ asset: ETHEREUM_SEPOLIA_USDC, maxAmountPerPayment: "1000000" }],
  },
};

/** An EVM transaction hash: 0x and 32 bytes of hex. */
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

/** A raw secp256k1 private key: 0x and 32 bytes of hex. */
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/** `Transfer(address indexed from, address indexed to, uint256 value)`. */
const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");

function payerAccount(payerKey: string) {
  // The message never echoes the key: it is a secret, and a malformed one is
  // often a real key pasted with a character missing.
  if (!PRIVATE_KEY.test(payerKey)) {
    throw new ConfigurationError(
      "EVM_PRIVATE_KEY is not an EVM private key: expected 0x followed by 64 hex characters.",
    );
  }
  return privateKeyToAccount(payerKey as Hex);
}

/** One ERC-20 `Transfer`, as the token contract logged it. */
export interface EvmTransfer {
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
}

/** A log as RPC returns it, reduced to what a transfer is read from. */
export interface EvmLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/** The last 20 bytes of a 32-byte topic: an indexed address. */
function topicAddress(topic: string): string {
  return `0x${topic.slice(-40)}`;
}

/**
 * The ERC-20 `Transfer` logs in a receipt. ERC-721 shares the event
 * signature but indexes the token id as a fourth topic, so only logs with
 * exactly three topics and a 32-byte value are read as token transfers.
 */
export function evmTransfers(logs: readonly EvmLog[]): EvmTransfer[] {
  return logs
    .filter(
      (log) =>
        log.topics.length === 3 &&
        log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
        /^0x[0-9a-fA-F]{64}$/.test(log.data),
    )
    .map((log) => ({
      token: log.address,
      from: topicAddress(log.topics[1]!),
      to: topicAddress(log.topics[2]!),
      value: BigInt(log.data),
    }));
}

/**
 * Holds a settled transaction's receipt to what the target advertised.
 *
 * The same rules as on Stellar: the transaction succeeded, it moved exactly
 * one token transfer, and that transfer is the advertised amount of the
 * advertised token, to the advertised recipient, from this run's own payer,
 * so a target cannot cite some other transaction that happens to match.
 */
export function verifyEvmReceipt(
  receipt: { readonly status: string; readonly logs: readonly EvmLog[] },
  reference: string,
  expected: ExpectedSettlement,
): SettlementVerdict {
  const fail = (detail: string): SettlementVerdict => ({ pass: false, detail });

  if (receipt.status !== "success") {
    return fail(
      `Transaction ${reference} exists on-chain but reverted. The target reported ` +
        `success for a settlement that did not settle.`,
    );
  }

  const transfers = evmTransfers(receipt.logs);
  if (transfers.length === 0) {
    return fail(
      `Transaction ${reference} succeeded but logged no ERC-20 Transfer, so no ` +
        `token movement can be verified.`,
    );
  }
  if (transfers.length !== 1) {
    return fail(
      `Transaction ${reference} logged ${transfers.length} ERC-20 Transfers; ` +
        `exactly one was expected. Additional balance changes mean the settlement ` +
        `moved more than what was advertised.`,
    );
  }

  const actual = transfers[0]!;
  const same = (a: string, b: string) => {
    try {
      return isAddressEqual(a as Hex, b as Hex);
    } catch {
      return false;
    }
  };
  const mismatches: string[] = [];
  if (actual.value !== expected.amount) {
    mismatches.push(`amount: advertised ${expected.amount} base units, moved ${actual.value}`);
  }
  if (!same(actual.to, expected.recipient)) {
    mismatches.push(`recipient: advertised ${expected.recipient}, paid ${actual.to}`);
  }
  if (!same(actual.token, expected.token)) {
    mismatches.push(`token: advertised ${expected.token}, moved ${actual.token}`);
  }
  if (!same(actual.from, expected.payer)) {
    mismatches.push(
      `payer: this run paid from ${expected.payer}, but the referenced transfer ` +
        `came from ${actual.from}`,
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
      `Transfer log (tx ${reference})`,
  };
}

async function verifyEvmSettlement(
  network: string,
  rpcUrl: string,
  reference: string,
  expected: ExpectedSettlement,
): Promise<SettlementVerdict> {
  const profile = NETWORKS[network];
  if (profile === undefined) {
    throw new ConfigurationError(`No EVM network "${network}" in Wasit's payment checks.`);
  }
  const client = createPublicClient({ transport: http(rpcUrl) });
  const lookup = await waitForReceipt(
    async () => {
      try {
        return await client.getTransactionReceipt({ hash: reference as Hex });
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return undefined;
        throw error;
      }
    },
    () => client.getBlockNumber(),
    { blocks: profile.blocksBeforeMissing, maxWaitMs: profile.maxWaitMs },
  );

  if (lookup.kind === "stalled") {
    // An RPC that is not advancing says nothing about the target: no verdict.
    throw new Error(
      `RPC at ${rpcUrl} produced only ${lookup.blocksWatched} blocks in ` +
        `${Math.round(lookup.waitedMs / 1000)} seconds while looking for tx ` +
        `${reference}, so its absence says nothing about the target. Re-run, ` +
        `or point --rpc-url at another endpoint.`,
    );
  }
  if (lookup.kind === "missing") {
    return {
      pass: false,
      detail:
        `Target reported settlement as tx ${reference}, but the chain produced ` +
        `${lookup.blocksWatched} more blocks without it. Either it was never ` +
        `broadcast, or the target referenced a transaction that does not exist.`,
    };
  }
  return verifyEvmReceipt(lookup.receipt, reference, expected);
}

/**
 * Corrupts the payer's signature, and nothing else.
 *
 * The EIP-3009 payload is `{ signature, authorization }`; Permit2's carries a
 * `signature` too. Flipping the first byte of `r` leaves a signature of the
 * same length whose recovered signer is no longer `authorization.from`, while
 * the amount, recipient and validity window stay intact. A target can refuse
 * it only by verifying the signature (spec, verification step 1).
 */
export function corruptEvmSignature(payload: Record<string, unknown>): Record<string, unknown> {
  const signature = payload["signature"];
  // 65 bytes for an EOA; a contract wallet's signature is longer, never shorter.
  if (typeof signature !== "string" || !/^0x(?:[0-9a-fA-F]{2}){65,}$/.test(signature)) {
    throw new CheckSetupError(
      "The payment payload carries no EVM signature to corrupt, so a corrupted " +
        "signature cannot be tested.",
    );
  }
  const first = (Number.parseInt(signature.slice(2, 4), 16) ^ 0xff).toString(16).padStart(2, "0");
  return { ...payload, signature: `0x${first}${signature.slice(4)}` };
}

export const evmChain: PaymentChain = {
  name: "EVM",
  networks: Object.keys(NETWORKS),
  payerKeyEnv: "EVM_PRIVATE_KEY",
  referenceKind: "an EVM transaction hash",
  resolveRpcUrl(network, override) {
    const profile = NETWORKS[network];
    if (profile === undefined) {
      throw new ConfigurationError(`No EVM network "${network}" in Wasit's payment checks.`);
    }
    if (override) return override;
    const fallback = profile.chain.rpcUrls.default.http[0];
    if (fallback === undefined) {
      throw new ConfigurationError(`No default RPC endpoint for ${network}. Pass an explicit rpcUrl.`);
    }
    return fallback;
  },
  registerPayer(client, network, payerKey, rpcUrl) {
    // The signer can read the chain: the SDK needs that only on the Permit2
    // path (allowance, permit nonce). EIP-3009 signing stays offline.
    const signer = toClientEvmSigner(
      payerAccount(payerKey),
      createPublicClient({ transport: http(rpcUrl) }),
    );
    client.register("eip155:*", new ExactEvmScheme(signer, { rpcUrl }));
    const allowed = NETWORKS[network]?.allowedAssets;
    if (allowed !== undefined) {
      client.setSpendControls({
        allowedAssets: allowed.map((entry) => ({ network: network as `${string}:${string}`, ...entry })),
      });
    }
  },
  // validBefore is now + 1 second. Held 5 seconds, it has passed by the
  // clock, and any block that could include it is later still, whatever
  // the chain's block time.
  expiredSigning: async () => ({ terms: { maxTimeoutSeconds: 1 }, holdMs: 5_000 }),
  payerAddress: (payerKey) => payerAccount(payerKey).address,
  generatePayerKey: () => generatePrivateKey(),
  async payerBalance(_network, rpcUrl, payer, asset) {
    if (!isAddress(asset) || !isAddress(payer)) return undefined;
    return createPublicClient({ transport: http(rpcUrl) }).readContract({
      address: asset,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [payer],
    });
  },
  isSettlementReference: (reference) => TRANSACTION_HASH.test(reference),
  verifySettlement: verifyEvmSettlement,
  corruptPayload: corruptEvmSignature,
};
