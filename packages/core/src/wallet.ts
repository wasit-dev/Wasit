/**
 * Testnet wallet helpers: generate a keypair, fund it with XLM via Friendbot,
 * establish a USDC trustline, and read balances back. Every function here is
 * scoped to Stellar testnet on purpose — Friendbot, the USDC issuer address
 * below, and the whole idea of a disposable throwaway wallet only make sense
 * there. None of this accepts a network parameter; there is nothing here
 * that could be pointed at pubnet by mistake.
 *
 * USDC funding is split into two steps because only one half can actually be
 * automated: a trustline is just a local signature away, but there is no
 * scriptable, unauthenticated faucet for testnet USDC. Circle's own faucet
 * (faucet.circle.com) is a captcha-gated web form with no public API for
 * Stellar. `sendUsdcFromDistributor` covers the case where the operator has
 * already completed that manual step once, on an account of their own.
 * `addTestnetUsdc` (used by `wasit init`) needs neither: it swaps a little of
 * the account's own test XLM for test USDC on the public test exchange, the
 * starter kit's way, and falls back to the trustline alone.
 *
 * **Error contract.** Every exported function that can fail throws one of
 * `errors.ts`'s types and never a raw Stellar SDK error: a bad key or a
 * rejected transaction is a `ConfigurationError`, an unreachable Horizon or
 * Friendbot is a `TargetUnreachableError`. Callers render `error.message`
 * directly and never need to know which SDK produced it, which is what keeps
 * the CLI and the dashboard from drifting apart in how they report the same
 * failure. `describeTransactionError` is the internal formatter that puts
 * Horizon's result codes into those messages; it stays exported only because
 * the CLI's own `--json` surface reuses it for non-wallet errors.
 */

import { randomBytes } from "node:crypto";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  NotFoundError,
  Operation,
  TransactionBuilder,
  TransactionFailedError,
  type Transaction,
  type TransactionSource,
} from "@stellar/stellar-sdk";
import { COMMITMENT_SEED_BYTES } from "./mpp/channel-commitment.js";
import { ConfigurationError, TargetUnreachableError } from "./errors.js";

export const TESTNET_HORIZON_URL = "https://horizon-testnet.stellar.org";

const FRIENDBOT_URL = "https://friendbot.stellar.org";

/**
 * Ceiling on any single Horizon or Friendbot request. Both are shared public
 * services with no uptime guarantee: without this a stalled connection hangs
 * the CLI (or pins the dashboard on its spinner) with no way back, since a
 * retry loop cannot help a request that never returns at all.
 */
const NETWORK_TIMEOUT_MS = 15_000;

/** Circle's official USDC issuer on Stellar testnet — not a pubnet address. */
export const TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** The testnet USDC asset, ready to use in a changeTrust or payment operation. */
export function testnetUsdcAsset(): Asset {
  return new Asset("USDC", TESTNET_USDC_ISSUER);
}

export interface GeneratedWallet {
  readonly publicKey: string;
  readonly secretKey: string;
}

/** A fresh testnet Stellar keypair. Never touches the network. */
export function generateTestnetWallet(): GeneratedWallet {
  const keypair = Keypair.random();
  return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
}

/**
 * Derives the public key for a secret key, without doing anything else with it.
 *
 * A malformed key is the single most likely thing to be wrong in someone's
 * `.env` — a truncated paste, a `G...` public key in a secret's slot, or a
 * raw hex commitment seed where a Stellar `S...` string belongs. The SDK
 * reports all three as `invalid encoded string`, which names neither the
 * problem nor where to fix it, so it is translated here into a
 * `ConfigurationError` that says which variable to look at.
 *
 * `source` is that variable's name (e.g. "MPP_PAYER_SECRET"). The secret
 * itself is never included in the message: this string reaches logs, saved
 * JSON runs and terminal recordings.
 */
export function publicKeyFromSecret(secretKey: string, source?: string): string {
  try {
    return Keypair.fromSecret(secretKey).publicKey();
  } catch {
    const where = source === undefined ? "The secret key provided" : source;
    throw new ConfigurationError(
      `${where} is not a valid Stellar secret key. It must be a 56-character ` +
        `string starting with "S" — not a "G..." public key, and not a raw hex ` +
        `seed (COMMITMENT_SECRET_HEX is hex and belongs to a different role; ` +
        `see docs/guides/configuration.md).`,
    );
  }
}

export interface GeneratedCommitmentKey {
  readonly secretHex: string;
  readonly publicKeyHex: string;
}

/**
 * A fresh MPP channel commitment key — a raw ed25519 seed, not a funded
 * Stellar account. It only ever signs commitment bytes off-chain (see
 * `commitmentKeypairFromHex` in mpp/channel-commitment.ts), so unlike the
 * wallets above it never needs XLM or a balance of its own.
 */
export function generateCommitmentKey(): GeneratedCommitmentKey {
  const seed = randomBytes(COMMITMENT_SEED_BYTES);
  const keypair = Keypair.fromRawEd25519Seed(seed);
  return {
    secretHex: seed.toString("hex"),
    publicKeyHex: keypair.rawPublicKey().toString("hex"),
  };
}

export interface AssetBalance {
  /** "XLM" for the native asset, otherwise the asset code (e.g. "USDC"). */
  readonly code: string;
  readonly issuer?: string;
  /** Decimal string straight from Horizon — never parsed to a float here. */
  readonly balance: string;
}

export interface WalletStatus {
  readonly publicKey: string;
  /** False when the account has never been created on-chain. */
  readonly exists: boolean;
  readonly balances: readonly AssetBalance[];
}

function horizonServer(): Horizon.Server {
  return new Horizon.Server(TESTNET_HORIZON_URL);
}

/**
 * Formats a TransactionFailedError with the actual Horizon result codes
 * (e.g. "op_underfunded") instead of just its generic top-level message,
 * which by itself is rarely enough to tell a user what to fix.
 */
export function describeTransactionError(error: unknown): string {
  if (error instanceof TransactionFailedError) {
    const codes = error.getResultCodes();
    const detail = [codes.transaction, ...codes.operations].filter(Boolean).join(", ");
    return detail ? `${error.message} (${detail})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Maps a thrown Horizon failure onto the taxonomy in errors.ts.
 *
 * The split that matters: a transaction Horizon *rejected* is a statement
 * about this run's own configuration or funding (`op_underfunded`,
 * `op_no_trust`) and is actionable, while a transaction that never reached
 * Horizon at all says nothing about the account and belongs with every other
 * connectivity failure. Anything already classified is passed through
 * untouched so a wrapped error is never wrapped twice.
 */
function asWalletError(error: unknown, action: string): Error {
  if (error instanceof ConfigurationError || error instanceof TargetUnreachableError) {
    return error;
  }
  if (error instanceof TransactionFailedError) {
    return new ConfigurationError(`Could not ${action}: ${describeTransactionError(error)}`);
  }
  if (error instanceof NotFoundError) {
    return new ConfigurationError(
      `Could not ${action}: the account does not exist on testnet yet. ` +
        `Fund it first with \`wasit wallet fund\`.`,
    );
  }
  return new TargetUnreachableError(TESTNET_HORIZON_URL, error);
}

/**
 * Reads an account's balances from testnet Horizon.
 *
 * An account that has never been funded is not an error — it's the expected
 * starting state for a freshly generated wallet — so it comes back as
 * `{ exists: false, balances: [] }` rather than a thrown NotFoundError.
 */
export async function getTestnetWalletStatus(publicKey: string): Promise<WalletStatus> {
  const server = horizonServer();
  try {
    const account = await server.loadAccount(publicKey);
    const balances = account.balances.map((entry): AssetBalance => {
      if (entry.asset_type === "native") {
        return { code: "XLM", balance: entry.balance };
      }
      if (entry.asset_type === "liquidity_pool_shares") {
        return { code: "LP_SHARE", balance: entry.balance };
      }
      return { code: entry.asset_code, issuer: entry.asset_issuer, balance: entry.balance };
    });
    return { publicKey, exists: true, balances };
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { publicKey, exists: false, balances: [] };
    }
    throw new TargetUnreachableError(TESTNET_HORIZON_URL, error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * What `fundWithFriendbot` actually did.
 *
 * Both outcomes mean the caller got what it asked for — a funded account —
 * but only one of them moved any XLM, and a UI that reports "Funded: 10,000
 * XLM" for an account that already had a balance is simply telling the user
 * something untrue.
 */
export type FriendbotOutcome = "funded" | "already-funded";

/**
 * Funds a testnet account via Friendbot (10,000 XLM per request). Friendbot
 * is a shared public resource with no documented uptime guarantee, so
 * transient failures are retried with a short backoff before giving up, and
 * every attempt is bounded by its own timeout. A 400 reporting the account
 * already exists is not a failure — the thing the caller actually wanted is
 * already true — and comes back as `"already-funded"` so the caller can say
 * so rather than claiming a transfer that never happened.
 */
export async function fundWithFriendbot(
  publicKey: string,
  attempts = 3,
): Promise<FriendbotOutcome> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(publicKey)}`, {
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
      if (response.ok) return "funded";
      const body = await response.text();
      if (
        response.status === 400 &&
        /already (funded|exists)|createAccountAlreadyExist/i.test(body)
      ) {
        return "already-funded";
      }
      lastError = new Error(`Friendbot responded ${response.status}: ${body}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) await sleep(500 * attempt);
  }
  throw new ConfigurationError(
    `Could not fund ${publicKey} via Friendbot after ${attempts} attempt${attempts === 1 ? "" : "s"}: ` +
      (lastError instanceof Error ? lastError.message : String(lastError)),
  );
}

/**
 * Establishes a trustline from `secretKey`'s own account to testnet USDC.
 *
 * This only opens the door — it does not put anything in it. The account
 * needs a small amount of existing XLM first (the transaction fee, plus the
 * reserve a trustline adds); callers should ensure that before calling this.
 */
export async function createUsdcTrustline(secretKey: string, source?: string): Promise<void> {
  // Validates first, so a malformed key is reported as the named .env
  // variable rather than as the SDK's bare "invalid encoded string".
  publicKeyFromSecret(secretKey, source);
  const keypair = Keypair.fromSecret(secretKey);
  const server = horizonServer();
  try {
    const account = await server.loadAccount(keypair.publicKey());
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset: testnetUsdcAsset() }))
      .setTimeout(30)
      .build();
    transaction.sign(keypair);
    await server.submitTransaction(transaction);
  } catch (error) {
    throw asWalletError(error, "create the USDC trustline");
  }
}

/**
 * How much test XLM a new payer swaps for test USDC on the public test
 * exchange, so it needs no faucet: the starter kit's amount
 * (x402-starter-kit `lib/full.mjs`, `SWAP_XLM`), out of the 10,000 XLM
 * Friendbot gives.
 */
export const TESTNET_SWAP_XLM = "10";

/** The swap accepts no less than this share of the quoted USDC, in percent (the kit's `SWAP_MIN_SHARE`, 0.8). */
const SWAP_MIN_PERCENT = 80n;

/** A quote under one USDC, in stroops, is no usable price (the kit's `out >= 1`). */
const SWAP_MIN_QUOTE_STROOPS = 10_000_000n;

const STROOPS_PER_UNIT = 10_000_000n;

/** A Stellar amount (at most 7 decimals) in stroops, or undefined when it is not one. */
function toStroops(amount: unknown): bigint | undefined {
  if (typeof amount !== "string") return undefined;
  const match = /^(\d{1,15})(?:\.(\d{1,7}))?$/.exec(amount);
  if (match === null) return undefined;
  return BigInt(match[1]!) * STROOPS_PER_UNIT + BigInt((match[2] ?? "").padEnd(7, "0"));
}

function fromStroops(stroops: bigint): string {
  return `${stroops / STROOPS_PER_UNIT}.${(stroops % STROOPS_PER_UNIT).toString().padStart(7, "0")}`;
}

/** One path Horizon's strict-send search answers with: only the fields the swap reads. */
export interface SwapPathRecord {
  readonly destination_amount?: unknown;
  readonly destination_asset_type?: unknown;
  readonly destination_asset_code?: unknown;
  readonly destination_asset_issuer?: unknown;
  readonly path?: unknown;
}

/** The terms of the swap: the least USDC it accepts, and the assets in between. */
export interface UsdcSwapQuote {
  /** A Stellar amount with 7 decimals. */
  readonly destMin: string;
  readonly path: readonly Asset[];
}

function pathAssets(path: unknown): Asset[] | undefined {
  if (!Array.isArray(path)) return undefined;
  try {
    return path.map((entry: { asset_type?: unknown; asset_code?: unknown; asset_issuer?: unknown }) =>
      entry.asset_type === "native" ? Asset.native() : new Asset(String(entry.asset_code), String(entry.asset_issuer)),
    );
  } catch {
    return undefined;
  }
}

/**
 * The swap's terms from Horizon's answer, or undefined when it gives no usable
 * price. Every record is the exchange's, not trusted: only a path to Circle's
 * testnet USDC counts, with an amount Stellar can carry and assets that parse;
 * of those, the one that gives the most. It must give at least one USDC, and
 * the swap then accepts no less than 80% of it, so it never runs at a much
 * worse price than the one quoted. Sends nothing.
 */
export function swapQuoteFrom(records: readonly SwapPathRecord[]): UsdcSwapQuote | undefined {
  let best: { readonly stroops: bigint; readonly path: Asset[] } | undefined;
  for (const record of records) {
    if (
      record.destination_asset_type === "native" ||
      record.destination_asset_code !== "USDC" ||
      record.destination_asset_issuer !== TESTNET_USDC_ISSUER
    ) {
      continue;
    }
    const stroops = toStroops(record.destination_amount);
    const path = pathAssets(record.path);
    if (stroops === undefined || path === undefined) continue;
    if (best === undefined || stroops > best.stroops) best = { stroops, path };
  }
  if (best === undefined || best.stroops < SWAP_MIN_QUOTE_STROOPS) return undefined;
  return { destMin: fromStroops((best.stroops * SWAP_MIN_PERCENT) / 100n), path: best.path };
}

/**
 * The one transaction that gives the account of `keypair` the testnet USDC
 * trustline and, with a quote, swaps {@link TESTNET_SWAP_XLM} of its test XLM
 * for test USDC paid to itself: both happen or neither does. Built for Stellar
 * testnet only and signed; sends nothing.
 */
export function usdcSetupTransaction(account: TransactionSource, keypair: Keypair, quote: UsdcSwapQuote | undefined): Transaction {
  const usdc = testnetUsdcAsset();
  const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }).addOperation(
    Operation.changeTrust({ asset: usdc }),
  );
  if (quote !== undefined) {
    builder.addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: TESTNET_SWAP_XLM,
        destination: keypair.publicKey(),
        destAsset: usdc,
        destMin: quote.destMin,
        path: [...quote.path],
      }),
    );
  }
  const transaction = builder.setTimeout(60).build();
  transaction.sign(keypair);
  return transaction;
}

/** What {@link addTestnetUsdc} did: the trustline is there in both cases. */
export type UsdcSetupOutcome =
  | { readonly swapped: true }
  | { readonly swapped: false; readonly why: string };

/**
 * Gives the account of `secretKey` the testnet USDC trustline and test USDC,
 * with no faucet: it swaps {@link TESTNET_SWAP_XLM} test XLM on the public test
 * exchange, in the same transaction as the trustline (the starter kit's way,
 * spec C7 row 3). Without a usable price, or when that transaction fails (a
 * price that moved, an empty book), it adds the trustline alone and says why.
 * Throws only when the trustline itself could not be added. The account needs
 * its test XLM first.
 */
export async function addTestnetUsdc(secretKey: string, source?: string): Promise<UsdcSetupOutcome> {
  publicKeyFromSecret(secretKey, source);
  const keypair = Keypair.fromSecret(secretKey);
  const server = horizonServer();

  let quote: UsdcSwapQuote | undefined;
  let why = "the public test exchange gave no usable price";
  try {
    const found = await server.strictSendPaths(Asset.native(), TESTNET_SWAP_XLM, [testnetUsdcAsset()]).call();
    quote = swapQuoteFrom(found.records);
  } catch {
    why = "the public test exchange could not be asked for a price";
  }

  if (quote !== undefined) {
    try {
      const account = await server.loadAccount(keypair.publicKey());
      await server.submitTransaction(usdcSetupTransaction(account, keypair, quote));
      return { swapped: true };
    } catch (error) {
      why = `the swap was not confirmed (${describeTransactionError(error)})`;
    }
  }

  try {
    const account = await server.loadAccount(keypair.publicKey());
    await server.submitTransaction(usdcSetupTransaction(account, keypair, undefined));
  } catch (error) {
    throw asWalletError(error, "create the USDC trustline");
  }
  return { swapped: false, why };
}

/**
 * Sends testnet USDC from an already-funded distributor account to
 * `destinationPublicKey`. There is no way to acquire the first unit of
 * testnet USDC without a human completing Circle's faucet form
 * (faucet.circle.com) once — this only helps once that has happened for the
 * distributor account. The destination must already hold a USDC trustline;
 * Stellar rejects a payment in an asset the receiver has not opted into.
 */
export async function sendUsdcFromDistributor(
  distributorSecretKey: string,
  destinationPublicKey: string,
  amount: string,
): Promise<void> {
  publicKeyFromSecret(distributorSecretKey, "WASIT_USDC_DISTRIBUTOR_SECRET");
  if (!/^\d+(\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) {
    throw new ConfigurationError(
      `"${amount}" is not a valid USDC amount. Use a positive decimal with at ` +
        `most 7 decimal places, e.g. 50 or 12.5.`,
    );
  }

  const keypair = Keypair.fromSecret(distributorSecretKey);
  const server = horizonServer();
  try {
    const account = await server.loadAccount(keypair.publicKey());
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({ destination: destinationPublicKey, asset: testnetUsdcAsset(), amount }),
      )
      .setTimeout(30)
      .build();
    transaction.sign(keypair);
    await server.submitTransaction(transaction);
  } catch (error) {
    throw asWalletError(error, "send USDC from the distributor account");
  }
}
