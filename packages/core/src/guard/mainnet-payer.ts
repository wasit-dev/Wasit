/**
 * L1's rule on the mainnet payer's account (spec B3, B4, B17.5).
 *
 * The caps hold one run to $5 (`budget.ts`). They do not hold two runs at once
 * on the same account, nor a server that is restarted: each gets its own $5.
 * What bounds those is the account. So before a mainnet run signs anything, it
 * reads its payer's USDC balance and does not start when the account holds
 * more than $10, or when the balance cannot be read. With $10 or less in it,
 * runs at once on that account can together sign no more than it holds.
 *
 * The balance is the RPC's answer. It is read through the run's RPC, the one
 * whose network was checked; a reader the caller hands in, so the rule itself
 * is pure.
 *
 * Nothing here says "allowed" for `stellar:pubnet`: the plan of a mainnet run
 * (`planX402Run` with the opt-in) calls {@link assertMainnetPayerBalance} in
 * L1, after the opt-in took the run's lock (`run-lock.ts`) and before anything
 * is signed.
 */

import { ConfigurationError } from "../errors.js";
import { PER_RUN_CAP_USD, formatUsd, usdFromBaseUnits, usdFromDollars } from "./budget.js";
import { networkClass } from "./networks.js";

/** At most this many dollars of USDC in the account a mainnet run pays from. */
export const MAINNET_PAYER_MAX_USD = 10;

/** USDC on Stellar has 7 decimals, as every Stellar Asset Contract has. */
const STELLAR_USDC_DECIMALS = 7;

/** {@link MAINNET_PAYER_MAX_USD} in base units of USDC on Stellar. */
export const MAINNET_PAYER_MAX_BASE_UNITS = BigInt(MAINNET_PAYER_MAX_USD) * 10n ** BigInt(STELLAR_USDC_DECIMALS);

/** The one mainnet a payer's balance is held to the rule on. */
const STELLAR_PUBNET = "stellar:pubnet";

/** A Stellar account address; anything else is never echoed. */
const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

/** Why the payer's account stops the run. */
export type MainnetPayerRefusal =
  /** It holds more than $10 of USDC. */
  | "above-max"
  /** Its balance could not be read. */
  | "unreadable"
  /** The run's network has no rule here (fail closed). */
  | "network";

/**
 * A mainnet run does not start because of its payer's account. A
 * `ConfigurationError`: it says nothing about the target. Nothing was signed.
 */
export class MainnetPayerRefusedError extends ConfigurationError {
  public readonly reason: MainnetPayerRefusal;

  public constructor(reason: MainnetPayerRefusal, message: string) {
    super(`${message} Nothing was signed.`);
    this.name = "MainnetPayerRefusedError";
    this.reason = reason;
  }
}

export interface MainnetPayerAccount {
  /** The run's network. */
  readonly network: string;
  /** The payer's public address. */
  readonly payer: string;
  /**
   * Reads the payer's balance of the run's USDC in base units, through the
   * run's RPC; undefined when it cannot.
   */
  readonly readBalance: () => Promise<bigint | undefined>;
}

function payerShown(payer: unknown): string {
  return typeof payer === "string" && STELLAR_ADDRESS.test(payer) ? `the mainnet payer ${payer}` : "the mainnet payer";
}

/**
 * Holds the payer's account to {@link MAINNET_PAYER_MAX_USD}.
 *
 * On a test network nothing is read and undefined is returned: the rule is for
 * real funds. On `stellar:pubnet` the balance is read once and returned when
 * it is $10 or less, for the plan to print. Any other network has no rule here
 * and is refused without a read.
 *
 * @throws {MainnetPayerRefusedError} On `stellar:pubnet` when the balance is
 *   above $10 or cannot be read (no answer, an answer that is not a whole
 *   number of base units, or a read that threw: what it threw is not echoed,
 *   since an RPC URL may carry a key); and on any network that is neither a
 *   test network nor `stellar:pubnet`.
 */
export async function assertMainnetPayerBalance(account: MainnetPayerAccount): Promise<bigint | undefined> {
  const { network } = account;
  if (networkClass(network) === "test") return undefined;
  if (network !== STELLAR_PUBNET) {
    throw new MainnetPayerRefusedError(
      "network",
      "The run's network is not one whose payer's balance Wasit can hold to a limit, so no payment is made on it.",
    );
  }

  const max = usdFromDollars(MAINNET_PAYER_MAX_USD);
  let balance: unknown;
  try {
    balance = await account.readBalance();
  } catch {
    balance = undefined;
  }
  if (typeof balance !== "bigint" || balance < 0n) {
    throw new MainnetPayerRefusedError(
      "unreadable",
      `The USDC balance of ${payerShown(account.payer)} could not be read on ${STELLAR_PUBNET}, so this run cannot ` +
        `show that the account holds ${formatUsd(max)} or less.`,
    );
  }
  if (balance > MAINNET_PAYER_MAX_BASE_UNITS) {
    throw new MainnetPayerRefusedError(
      "above-max",
      `${capitalised(payerShown(account.payer))} holds ${formatUsd(usdFromBaseUnits(balance, STELLAR_USDC_DECIMALS))} ` +
        `in USDC (${balance} base units), above the ${formatUsd(max)} a mainnet payer may hold. The ` +
        `${formatUsd(usdFromDollars(PER_RUN_CAP_USD))} cap holds one run, not two at once on one account: with ` +
        `${formatUsd(max)} or less in it, the account is the limit. Move the rest out of this account, or pay from ` +
        `a dedicated account that holds ${formatUsd(max)} or less.`,
    );
  }
  return balance;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
