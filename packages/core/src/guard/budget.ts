/**
 * The caps of spec B4, in code: at most $1 a payment and $5 a run, the run's
 * total charged BEFORE each signature and never credited back (B3, B-A08).
 *
 * A cap in dollars needs an asset whose dollar value is known. Wasit pays only
 * in USDC (the SDK client's default assets, plus Circle's USDC on Ethereum
 * Sepolia), so the table below lists USDC on each test network with its
 * decimals, and a payment in any other asset is refused: Wasit cannot hold it
 * to the cap. On mainnet it lists Circle's USDC on Stellar mainnet only, the
 * one asset a mainnet run pays in (B4); L0 refuses that network without the
 * mainnet opt-in, so valuing it allows nothing by itself.
 *
 * Amounts in dollars are bigints at 10^-18 of a dollar, so 6 and 7 decimal
 * tokens add up exactly.
 *
 * Pure: no network, no key.
 */

import { CheckSetupError, ConfigurationError } from "../errors.js";
import { sanitizeText } from "../sanitize.js";

/** At most this many dollars in one payment. Fixed; nothing raises it. */
export const PER_PAYMENT_CAP_USD = 1;

/** At most this many dollars signed in one run. A config may only lower it (`maxRunUsd`). */
export const PER_RUN_CAP_USD = 5;

/** A dollar, in the units this module counts in. */
const DOLLAR = 10n ** 18n;

export interface UsdAsset {
  readonly network: string;
  readonly asset: string;
  readonly decimals: number;
  readonly symbol: string;
}

/**
 * USDC on each test network. Sources (read 2026-11-16): `@x402/stellar` 2.28.0
 * `USDC_TESTNET_ADDRESS`, `DEFAULT_TOKEN_DECIMALS = 7`; `@x402/evm` 2.28.0 default
 * asset of `eip155:84532`, decimals 6; Circle's USDC on Ethereum Sepolia as
 * `chains/evm.ts` (`ETHEREUM_SEPOLIA_USDC`, 6 decimals read from the contract
 * 2026-10-05); `@x402/svm` 2.28.0 `USDC_DEVNET_ADDRESS`, decimals 6.
 */
export const USD_ASSETS: readonly UsdAsset[] = [
  { network: "stellar:testnet", asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", decimals: 7, symbol: "USDC" },
  { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, symbol: "USDC" },
  { network: "eip155:11155111", asset: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6, symbol: "USDC" },
  { network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, symbol: "USDC" },
  // MAINNET_USDC of guard/mainnet-plan.ts (checked three ways there); a test asserts they are the same.
  { network: "stellar:pubnet", asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", decimals: 7, symbol: "USDC" },
];

/** Whether two addresses on `network` are the same: an EVM address in any letter case, others exactly. */
export function sameAddress(network: string, a: string, b: string): boolean {
  if (network.startsWith("eip155:")) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/** The dollar asset `asset` is on `network`, if Wasit knows it. */
export function usdAsset(network: string, asset: string): UsdAsset | undefined {
  return USD_ASSETS.find((entry) => entry.network === network && sameAddress(network, entry.asset, asset));
}

/** `amount` base units of a dollar token with `decimals` decimals, in this module's dollar units. */
export function usdFromBaseUnits(amount: bigint, decimals: number): bigint {
  return (amount * DOLLAR) / 10n ** BigInt(decimals);
}

/** `amount` base units of `asset`, in this module's dollar units. */
function toUsd(asset: UsdAsset, amount: bigint): bigint {
  return usdFromBaseUnits(amount, asset.decimals);
}

/** Whole and fractional dollars, rounded down to a millionth: a cap is never rounded up. */
export function usdFromDollars(dollars: number): bigint {
  return (BigInt(Math.floor(dollars * 1_000_000)) * DOLLAR) / 1_000_000n;
}

/** "$4.50", "$0.0000001": exact, at least two decimals. */
export function formatUsd(amount: bigint): string {
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  const whole = absolute / DOLLAR;
  let fraction = (absolute % DOLLAR).toString().padStart(18, "0").replace(/0+$/, "");
  if (fraction.length < 2) fraction = fraction.padEnd(2, "0");
  return `${sign}$${whole}.${fraction}`;
}

export type GuardRefusal = "price" | "asset" | "amount" | "pin" | "plan" | "run-cap" | "accepted" | "signed-terms";

/**
 * A payment the guard will not sign, or, with `signed`, a signed payment it
 * will not send. A setup error: it says nothing about the target, and the
 * check that hit it has no verdict.
 */
export class PaymentGuardRefusedError extends CheckSetupError {
  public readonly reason: GuardRefusal;

  public constructor(reason: GuardRefusal, message: string, options: { readonly signed?: boolean } = {}) {
    super(options.signed === true ? `${message} It was signed and discarded; it was not sent.` : `${message} Nothing was signed.`);
    this.name = "PaymentGuardRefusedError";
    this.reason = reason;
  }
}

/** A value the target chose, for a message: one line, no control characters, bounded. */
export function shown(value: unknown): string {
  const text = sanitizeText(String(value)).replace(/\s+/g, " ");
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}...` : text);
}

/** A base-unit amount as the challenge gives it: digits only, at most 78 (a uint256). */
const AMOUNT = /^\d{1,78}$/;

export function parseAmount(amount: unknown): bigint {
  if (typeof amount !== "string" || !AMOUNT.test(amount)) {
    throw new PaymentGuardRefusedError(
      "amount",
      `The amount to sign, ${shown(amount)}, is not a whole number of base units.`,
    );
  }
  return BigInt(amount);
}

export interface PinTerms {
  readonly payTo: string;
  readonly asset: string;
}

interface OptionTerms {
  readonly scheme: string;
  readonly network: string;
  readonly payTo: string;
  readonly asset: string;
}

/**
 * Refuses unless EVERY `exact` option on `network` pays the pinned `payTo` in
 * the pinned asset (B-A02): the SDK picks among the options by its own rules,
 * so a check of the first one alone would not cover what it signs. Options on
 * other networks or schemes are never signed and are not judged.
 */
export function assertPinned(network: string, accepts: readonly OptionTerms[], pin: PinTerms | undefined): void {
  if (pin === undefined) return;
  for (const [index, requirement] of accepts.entries()) {
    if (requirement.scheme !== "exact" || requirement.network !== network) continue;
    for (const field of ["payTo", "asset"] as const) {
      if (!sameAddress(network, String(requirement[field]), pin[field])) {
        throw new PaymentGuardRefusedError(
          "pin",
          `Option ${index + 1} of the challenge (exact, ${network}) has ${field} ${shown(requirement[field])}, ` +
            `not the pinned ${pin[field]}.`,
        );
      }
    }
  }
}

/** One signature a run makes, and its amount in base units. */
export interface PlannedSignature {
  readonly check: string;
  readonly amount: bigint;
}

/**
 * What the payment checks sign for an endpoint priced `price` (B0 fact 8):
 * X402-06 the price (settles), X402-07 the price (signature then corrupted),
 * X402-09 half the price, rounded down (none when there is no smaller amount),
 * X402-10 the price with a short lifetime. X402-08 resends X402-06 and signs
 * nothing. 3.5 times the price. With `rejectedRequest`, X402-11 the price as
 * well (a valid payment sent with a request the service must refuse): 4.5 times.
 */
export function plannedSignatures(price: bigint, options: { readonly rejectedRequest?: boolean } = {}): PlannedSignature[] {
  return [
    { check: "X402-06", amount: price },
    { check: "X402-07", amount: price },
    ...(price >= 2n ? [{ check: "X402-09", amount: price / 2n }] : []),
    { check: "X402-10", amount: price },
    ...(options.rejectedRequest === true ? [{ check: "X402-11", amount: price }] : []),
  ];
}

export interface BudgetOptions {
  /** A lower per-run cap in dollars; a value above {@link PER_RUN_CAP_USD} is read as it. */
  readonly maxRunUsd?: number;
}

export interface Charge {
  readonly check: string;
  readonly network: string;
  readonly asset: string;
  /** Base units, as the payment states them. */
  readonly amount: string;
  /** What the plan allowed for this check, in base units, when the run has a plan. */
  readonly planned?: bigint;
}

export interface ChargedEntry {
  readonly check: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: bigint;
}

/**
 * The dollars one run may sign. Every signature is charged here first; a
 * charge that does not fit is refused and nothing is signed. Nothing is ever
 * credited back: a payment that failed after it was signed may still settle.
 * Once the cap refuses a payment, the budget is spent: every later charge is
 * refused too, so a run never signs a smaller payment after a larger one did
 * not fit.
 */
export class RunBudget {
  readonly #cap: bigint;
  #spent = 0n;
  #exhausted: string | undefined;
  readonly #entries: ChargedEntry[] = [];

  public constructor(options: BudgetOptions = {}) {
    const lower = options.maxRunUsd;
    if (lower !== undefined && (!Number.isFinite(lower) || lower <= 0)) {
      throw new ConfigurationError("maxRunUsd must be a number above 0: it can only lower the per-run cap.");
    }
    this.#cap = usdFromDollars(Math.min(lower ?? PER_RUN_CAP_USD, PER_RUN_CAP_USD));
  }

  /** The run's cap, in dollar units. */
  public get capUsd(): bigint {
    return this.#cap;
  }

  /** What the run has charged so far, in dollar units. */
  public get spentUsd(): bigint {
    return this.#spent;
  }

  public get entries(): readonly ChargedEntry[] {
    return [...this.#entries];
  }

  /**
   * Charges one payment, or refuses it. Called before the signature, with the
   * amount that will be signed.
   */
  public charge(charge: Charge): void {
    const amount = parseAmount(charge.amount);
    const asset = usdAsset(charge.network, charge.asset);
    if (asset === undefined) {
      throw new PaymentGuardRefusedError(
        "asset",
        `The target asks to be paid in ${shown(charge.asset)} on ${charge.network}, an asset Wasit does not ` +
          `value in US dollars, so it cannot hold the payment to the $${PER_PAYMENT_CAP_USD}.00 cap.`,
      );
    }
    const usd = toUsd(asset, amount);
    const perPayment = usdFromDollars(PER_PAYMENT_CAP_USD);
    if (usd > perPayment) {
      throw new PaymentGuardRefusedError(
        "price",
        `${charge.check} would sign ${amount} base units of ${asset.symbol} (${formatUsd(usd)}), above the ` +
          `${formatUsd(perPayment)} per payment fixed in Wasit. A route priced at ` +
          `${formatUsd(perPayment)} or less is checked as usual.`,
      );
    }
    if (charge.planned !== undefined && amount > charge.planned) {
      throw new PaymentGuardRefusedError(
        "plan",
        `${charge.check} would sign ${amount} base units, more than the ${charge.planned} the plan allowed ` +
          `for it before the run started: the service changed its price after the plan.`,
      );
    }
    if (this.#exhausted !== undefined) {
      throw new PaymentGuardRefusedError("run-cap", this.#exhausted);
    }
    if (this.#spent + usd > this.#cap) {
      this.#exhausted =
        `The run reached its ${formatUsd(this.#cap)} cap: ${charge.check} would have taken it from ` +
        `${formatUsd(this.#spent)} to ${formatUsd(this.#spent + usd)}, so the run signs nothing more.`;
      throw new PaymentGuardRefusedError("run-cap", this.#exhausted);
    }
    this.#spent += usd;
    this.#entries.push({ check: charge.check, network: charge.network, asset: asset.asset, amount });
  }

  /** The dollar value of `amount` base units of `asset` on `network`, if Wasit can value it. */
  public static valueOf(network: string, asset: string, amount: bigint): bigint | undefined {
    const known = usdAsset(network, asset);
    return known === undefined ? undefined : toUsd(known, amount);
  }
}
