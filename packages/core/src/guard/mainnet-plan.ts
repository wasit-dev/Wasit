/**
 * L1's rules for a mainnet run (spec B3, B4, B5, B17.2), as pure checks.
 *
 * A mainnet run pays in one asset, Circle's USDC on Stellar mainnet, to the
 * one payee its config pins, with a lifetime short enough to wait out, and
 * only when the token, the RPC's latest ledger and the payer's balance read
 * as expected. Each rule here throws {@link MainnetPlanRefusedError} when it
 * does not hold; nothing was signed at that point.
 *
 * Nothing here says "allowed": the plan of a mainnet run (L1, with the opt-in)
 * and its signatures (L2) call these before anything is signed, and the dry
 * run on `stellar:pubnet` calls them with no key.
 *
 * Pure: no network, no key. The reads they judge are `horizon.ts` and the
 * chain adapter's.
 */

import { StrKey } from "@stellar/stellar-sdk";

import { ConfigurationError } from "../errors.js";
import { shown, type PinTerms } from "./budget.js";

/** The one network these rules are for. */
const STELLAR_PUBNET = "stellar:pubnet";

/**
 * Circle's USDC on Stellar mainnet, as a Stellar Asset Contract. Checked three
 * ways on 2026-11-21: the issuer as Circle's page lists it
 * (https://developers.circle.com/stablecoins/usdc-contract-addresses,
 * "USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"); the
 * contract derived from that issuer with the SDK
 * (`new Asset("USDC", issuer).contractId(Networks.PUBLIC)`); and
 * `USDC_PUBNET_ADDRESS` of `@x402/stellar` 2.28.0. A test asserts all three.
 */
export const MAINNET_USDC = {
  network: STELLAR_PUBNET,
  asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  code: "USDC",
  issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  decimals: 7,
  symbol: "USDC",
} as const;

/** The classic asset a Stellar Asset Contract wraps, as Horizon names it. */
export interface ClassicAsset {
  readonly code: string;
  readonly issuer: string;
}

/** The longest lifetime a mainnet payment is signed for, in seconds (B3): the run waits it out. */
export const MAINNET_MAX_TIMEOUT_SECONDS = 300;

/** At most this many ledgers between the RPC's latest ledger and public Horizon's (B17.2). */
export const MAINNET_ANCHOR_MAX_GAP_LEDGERS = 12;

/** Public Horizon of Stellar mainnet (B5 point 4): the SDK reads the ledger close time there too. */
export const PUBNET_HORIZON_URL = "https://horizon.stellar.org";

/** Which rule stopped the run. */
export type MainnetPlanRefusal =
  /** The config's pin is missing, or its payee is not a valid address other than the payer. */
  | "pin"
  /** An asset other than mainnet USDC. */
  | "asset"
  /** An option on another scheme or network. */
  | "network"
  /** A lifetime above 300 s, or not a positive whole number of seconds. */
  | "lifetime"
  /** The token's decimals are not 7. */
  | "decimals"
  /** The RPC's latest ledger is too far from Horizon's, or not a ledger number. */
  | "anchor"
  /** The RPC's USDC balance of the payer differs from Horizon's, or has no reading. */
  | "balance"
  /** Horizon could not be read, or its answer cannot be trusted. */
  | "horizon"
  /** The endpoint's URL: not https (and not on this machine), credentials in it, or a redirect elsewhere. */
  | "endpoint";

/**
 * A mainnet run does not start, or stops, because of one of L1's rules. A
 * `ConfigurationError`: it says nothing about the target. Nothing was signed.
 */
export class MainnetPlanRefusedError extends ConfigurationError {
  public readonly reason: MainnetPlanRefusal;

  public constructor(reason: MainnetPlanRefusal, message: string) {
    super(`${message} Nothing was signed.`);
    this.name = "MainnetPlanRefusedError";
    this.reason = reason;
  }
}

function isStellarAddress(value: unknown): value is string {
  return typeof value === "string" && (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value));
}

/**
 * The pin a mainnet environment must have (B5 point 2): a payee that is a
 * valid Stellar address and not the payer itself, and mainnet USDC as the
 * asset. A transfer to the payer would leave its balance as it was and hide
 * what the run paid. `payer` undefined: the dry run, which reads no key; the
 * paid run holds the payee to the payer's address when it opens.
 */
export function assertMainnetPin(pin: PinTerms | undefined, payer: string | undefined): void {
  if (pin === undefined) {
    throw new MainnetPlanRefusedError(
      "pin",
      "A mainnet environment needs pinned.payTo and pinned.asset in the config: Wasit pays only the payee and the " +
        "asset written there.",
    );
  }
  if (pin.asset !== MAINNET_USDC.asset) {
    throw new MainnetPlanRefusedError(
      "asset",
      `pinned.asset of a mainnet environment must be ${MAINNET_USDC.asset}, Circle's USDC on Stellar mainnet; ` +
        `the config has ${isStellarAddress(pin.asset) ? pin.asset : "another value"}.`,
    );
  }
  if (!isStellarAddress(pin.payTo)) {
    throw new MainnetPlanRefusedError("pin", "pinned.payTo of a mainnet environment is not a valid Stellar address.");
  }
  if (payer !== undefined && pin.payTo === payer) {
    throw new MainnetPlanRefusedError(
      "pin",
      "pinned.payTo is the payer's own address: on mainnet the payee must be another account, so the payer's " +
        "balance shows what the run paid.",
    );
  }
}

/**
 * Where a URL pays, as a mainnet plan records it and L2 holds each payment to
 * it: origin and path, the query and the fragment left out (a query may hold
 * a key, and the plan is written to the ledger).
 */
export function paidUrlOf(target: string): string {
  const url = new URL(target);
  return `${url.origin}${url.pathname}`;
}

/** The fields of a challenge's option these rules judge. */
export interface MainnetOption {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly maxTimeoutSeconds: number;
}

/**
 * The option a mainnet endpoint may be paid by (L1, B3): `exact` on
 * `stellar:pubnet`, in mainnet USDC, valid for at most 300 s. The pin (payee
 * and asset over every option) is `assertPinned`'s; the price is the budget's.
 */
export function assertMainnetOption(option: MainnetOption): void {
  if (option.scheme !== "exact" || option.network !== STELLAR_PUBNET) {
    throw new MainnetPlanRefusedError(
      "network",
      `The option to pay is ${shown(option.scheme)} on ${shown(option.network)}; a mainnet run pays exact on ` +
        `${STELLAR_PUBNET} only.`,
    );
  }
  if (option.asset !== MAINNET_USDC.asset) {
    throw new MainnetPlanRefusedError(
      "asset",
      `The option to pay asks for ${shown(option.asset)}; a mainnet run pays in ${MAINNET_USDC.asset} ` +
        `(USDC) only.`,
    );
  }
  const lifetime: unknown = option.maxTimeoutSeconds;
  if (
    typeof lifetime !== "number" ||
    !Number.isSafeInteger(lifetime) ||
    lifetime < 1 ||
    lifetime > MAINNET_MAX_TIMEOUT_SECONDS
  ) {
    throw new MainnetPlanRefusedError(
      "lifetime",
      `The option to pay stays valid for ${shown(lifetime)} s; a mainnet payment is signed for a whole number of ` +
        `seconds from 1 to ${MAINNET_MAX_TIMEOUT_SECONDS}, so the run can wait until every signature it made has ` +
        `expired.`,
    );
  }
}

/** The token's decimals, as read on chain (B4): the caps count USDC at 7. */
export function assertMainnetDecimals(decimals: unknown): void {
  if (decimals !== MAINNET_USDC.decimals) {
    throw new MainnetPlanRefusedError(
      "decimals",
      `The asset contract reports ${shown(decimals)} decimals; mainnet USDC has ${MAINNET_USDC.decimals}, and the ` +
        `caps are counted at ${MAINNET_USDC.decimals}.`,
    );
  }
}

function isLedger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * The RPC's latest ledger must be within {@link MAINNET_ANCHOR_MAX_GAP_LEDGERS}
 * of public Horizon's (B17.2): the expiration bound of every signature counts
 * from it, so an RPC that reports a later ledger cannot stretch a signature's
 * life on mainnet.
 */
export function assertAnchorNearHorizon(rpcLatest: number, horizonLatest: number): void {
  if (!isLedger(rpcLatest) || !isLedger(horizonLatest)) {
    throw new MainnetPlanRefusedError("anchor", "The latest ledger could not be read as a ledger number from the RPC and Horizon.");
  }
  const gap = Math.abs(rpcLatest - horizonLatest);
  if (gap > MAINNET_ANCHOR_MAX_GAP_LEDGERS) {
    throw new MainnetPlanRefusedError(
      "anchor",
      `The RPC's latest ledger (${rpcLatest}) is ${gap} ledgers from public Horizon's (${horizonLatest}), more than ` +
        `the ${MAINNET_ANCHOR_MAX_GAP_LEDGERS} a mainnet run allows: the RPC may not serve the current chain.`,
    );
  }
}

/** Horizon's amounts: whole units, a point, exactly seven decimals. */
const HORIZON_AMOUNT = /^(0|[1-9][0-9]{0,18})\.([0-9]{7})$/;

/** An amount as Horizon writes it ("10.0000000"), in base units at 7 decimals; undefined for anything else. */
export function parseHorizonAmount(text: unknown): bigint | undefined {
  if (typeof text !== "string") return undefined;
  const match = HORIZON_AMOUNT.exec(text);
  if (match === null) return undefined;
  return BigInt(match[1]!) * 10_000_000n + BigInt(match[2]!);
}

/** An account's balances as Horizon lists them, in base units. */
export interface HorizonBalances {
  /** The trustline of the asset; 0 when the account has none. */
  readonly usdc: bigint;
  /** Lumens (XLM). */
  readonly native: bigint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The USDC and XLM balances of a Horizon account answer, in base units. The
 * trustline is matched by type, code and issuer; a token with the same code
 * from another issuer is not it. Undefined for an answer that cannot be read
 * plainly: no `balances`, no native balance, an amount that does not parse,
 * or the same asset listed twice.
 */
export function horizonBalances(account: unknown, asset: ClassicAsset): HorizonBalances | undefined {
  if (!isRecord(account) || !Array.isArray(account["balances"])) return undefined;
  const type = asset.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12";
  let usdc: bigint | undefined;
  let native: bigint | undefined;
  for (const entry of account["balances"] as unknown[]) {
    if (!isRecord(entry)) return undefined;
    if (entry["asset_type"] === "native") {
      if (native !== undefined) return undefined;
      native = parseHorizonAmount(entry["balance"]);
      if (native === undefined) return undefined;
    } else if (entry["asset_type"] === type && entry["asset_code"] === asset.code && entry["asset_issuer"] === asset.issuer) {
      if (usdc !== undefined) return undefined;
      usdc = parseHorizonAmount(entry["balance"]);
      if (usdc === undefined) return undefined;
    }
  }
  if (native === undefined) return undefined;
  return { usdc: usdc ?? 0n, native };
}

/**
 * The payer's USDC balance as the RPC reads it must be what Horizon lists
 * (B17.12): the $10 rule reads the RPC's, and an RPC that under-reports it
 * would let a fuller account pay.
 */
export function assertBalancesAgree(rpcBalance: bigint | undefined, horizonBalance: bigint | undefined): void {
  if (horizonBalance === undefined) {
    throw new MainnetPlanRefusedError("horizon", "The payer's USDC balance could not be read from public Horizon.");
  }
  if (rpcBalance === undefined) {
    throw new MainnetPlanRefusedError("balance", "The payer's USDC balance could not be read through the RPC.");
  }
  if (rpcBalance !== horizonBalance) {
    throw new MainnetPlanRefusedError(
      "balance",
      `The RPC reads the payer's USDC balance as ${rpcBalance} base units and public Horizon as ${horizonBalance}: ` +
        `the two must agree before a mainnet run signs anything.`,
    );
  }
}
