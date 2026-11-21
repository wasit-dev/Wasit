/**
 * Opening a mainnet run (spec B5, B18 O1): the one place a {@link MainnetOptIn}
 * is made. A front end calls it only when its own switch is set (`--mainnet`,
 * the Action's `mainnet: true` on workflow_dispatch, the MCP server's start-up
 * setting); every other rule a mainnet x402 run needs before anything is sent
 * is checked here, in core, so each front end gets the same refusals:
 *
 * 1. the config environment is on `stellar:pubnet` and has `operatedByMe: true`;
 * 2. the key is read from `WASIT_MAINNET_PAYER_SECRET` only, is a Stellar
 *    secret, and is the value of no other key variable (a dedicated account);
 * 3. the pin pays mainnet USDC to a valid payee that is not the payer;
 * 4. an RPC is given (pubnet has no default), is https, and serves pubnet;
 * 5. in GitHub Actions, the job keeps the mainnet job rules (B17.4);
 * 6. no other mainnet run holds the lock in the ledger's folder.
 *
 * Only then is the opt-in made and the lock held. The key is read to derive
 * the payer's address and is not kept. The plan (L1) comes next, with the
 * opt-in: `planX402Run({ ..., mainnet })`.
 */

import { basename } from "node:path";

import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { DENIED_ENV_NAMES } from "../denied-env.js";
import { ConfigurationError } from "../errors.js";
import { paymentChainFor } from "../x402/chains/index.js";
import { assertX402PaymentRpc } from "../x402/simulator.js";
import { RunBudget } from "./budget.js";
import { inGithubActions } from "./ci-event.js";
import { assertMainnetJob, type MainnetJob } from "./ci-mainnet.js";
import { readHorizonAccount, readHorizonLatestLedger } from "./horizon.js";
import { MAINNET_MAX_TIMEOUT_SECONDS, assertMainnetPin } from "./mainnet-plan.js";
import {
  MainnetRunRefusedError,
  anchorOfOptIn,
  isMainnetOptIn,
  issueMainnetOptIn,
  type MainnetFrontEnd,
  type MainnetOptIn,
} from "./optin.js";
import { openAuthorizationsUntil, type LedgerConsistency } from "./run-ledger.js";
import { acquireMainnetRunLock } from "./run-lock.js";
import type { PinTerms } from "./budget.js";

/** The one variable a mainnet run reads its key from (spec B5 point 3). */
export const MAINNET_PAYER_KEY_ENV = "WASIT_MAINNET_PAYER_SECRET";

const STELLAR_PUBNET = "stellar:pubnet";

export { MainnetRunRefusedError, type MainnetRunRefusal } from "./optin.js";

export interface MainnetOptInInput {
  readonly frontEnd: MainnetFrontEnd;
  /** The process environment: the key and, in GitHub Actions, the job's variables. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The config environment's name, its network, its `operatedByMe` and its pin. */
  readonly environment: string;
  readonly network: string;
  readonly operatedByMe: boolean;
  readonly pin: PinTerms | undefined;
  /** The RPC the payment is built and the settlement read through. */
  readonly rpcUrl: string | undefined;
  /** Where the lock is taken and the ledger written. */
  readonly ledgerDir: string;
  /** A lower per-run cap. Not with `budget`. */
  readonly maxRunUsd?: number;
  /** The MCP server's budget for the whole process (D-018). Not with `maxRunUsd`. */
  readonly budget?: RunBudget;
  /** In GitHub Actions: what the mainnet job rules read about the job. Required there. */
  readonly job?: Omit<MainnetJob, "env">;
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** The mainnet key: set, a Stellar secret, and no other key variable's value. */
function readMainnetKey(env: Readonly<Record<string, string | undefined>>): string {
  const value = env[MAINNET_PAYER_KEY_ENV];
  if (!nonEmpty(value)) {
    throw new MainnetRunRefusedError(
      "key",
      `${MAINNET_PAYER_KEY_ENV} is not set: a mainnet run reads its key from that variable only, never from ` +
        `STELLAR_PRIVATE_KEY or --payer-key.`,
    );
  }
  const key = value.trim();
  if (!StrKey.isValidEd25519SecretSeed(key)) {
    throw new MainnetRunRefusedError("key", `${MAINNET_PAYER_KEY_ENV} does not hold a Stellar secret key.`);
  }
  for (const [name, other] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (upper === MAINNET_PAYER_KEY_ENV || !DENIED_ENV_NAMES.includes(upper) || !nonEmpty(other)) continue;
    if (other.trim() === key) {
      throw new MainnetRunRefusedError(
        "key",
        `${MAINNET_PAYER_KEY_ENV} holds the same key as ${upper}: a mainnet run pays from a dedicated account, whose ` +
          `key is in no other variable.`,
      );
    }
  }
  return key;
}

/**
 * Opens a mainnet x402 run, or refuses it before anything is sent.
 *
 * @throws {MainnetRunRefusedError} network, `operatedByMe`, key, RPC missing, cap, job unknown in GitHub Actions.
 * @throws {MainnetPlanRefusedError} The pin (missing, not USDC, payee not valid or the payer).
 * @throws {RpcIdentityError} An RPC that is not https or does not serve pubnet.
 * @throws {MainnetJobRefusedError} A GitHub Actions job that breaks the mainnet job rules.
 * @throws {MainnetRunLockedError} Another mainnet run holds the lock.
 */
export async function openMainnetOptIn(input: MainnetOptInInput): Promise<MainnetOptIn> {
  if (input.network !== STELLAR_PUBNET) {
    throw new MainnetRunRefusedError(
      "network",
      `A mainnet run is on ${STELLAR_PUBNET} only, and this environment's network is another.`,
    );
  }
  if (input.operatedByMe !== true) {
    throw new MainnetRunRefusedError(
      "operated-by-me",
      `operatedByMe is not true for environment ${input.environment}: Wasit pays only a service its operator runs.`,
    );
  }
  const key = readMainnetKey(input.env);
  const payer = Keypair.fromSecret(key).publicKey();
  assertMainnetPin(input.pin, payer);
  const pin = input.pin!;
  if (input.budget !== undefined && input.maxRunUsd !== undefined) {
    throw new MainnetRunRefusedError("cap", "A mainnet run takes its cap from one place: a shared budget or maxRunUsd, not both.");
  }
  // A shared budget must be Wasit's own: a subclass could charge nothing.
  if (input.budget !== undefined && Object.getPrototypeOf(input.budget) !== RunBudget.prototype) {
    throw new MainnetRunRefusedError("cap", "A mainnet run's shared budget is a RunBudget of Wasit's own.");
  }
  const budget = input.budget ?? new RunBudget(input.maxRunUsd === undefined ? {} : { maxRunUsd: input.maxRunUsd });
  if (inGithubActions(input.env)) {
    if (input.job === undefined) {
      throw new MainnetRunRefusedError("job", "This run is in GitHub Actions, and the job could not be checked against the mainnet job rules.");
    }
    assertMainnetJob({ ...input.job, env: input.env });
  }
  if (!nonEmpty(input.rpcUrl)) {
    throw new MainnetRunRefusedError(
      "rpc",
      `A mainnet run needs an RPC for ${STELLAR_PUBNET} (rpcUrl in the config, or WASIT_RPC_URL): there is no default one.`,
    );
  }
  const rpcUrl = input.rpcUrl;
  await assertX402PaymentRpc(STELLAR_PUBNET, rpcUrl);
  const lock = acquireMainnetRunLock(input.ledgerDir);
  return issueMainnetOptIn({
    frontEnd: input.frontEnd,
    environment: input.environment,
    payer,
    pin,
    rpcUrl,
    budget,
    ledgerDir: input.ledgerDir,
    lock,
  });
}

export interface MainnetCloseOptions {
  /** Waits `ms` between two reads of the latest ledger. Default: a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** One line when the wait starts. It holds nothing from the service. */
  readonly onProgress?: (line: string) => void;
}

export interface MainnetCloseResult {
  /** What the ledger says of the balances; undefined when the run opened no ledger. */
  readonly consistency?: LedgerConsistency;
  readonly ledgerPath?: string;
  /** The ledger that had to close before the balances after were read; undefined when nothing may have been signed. */
  readonly waitedUntil?: number;
  /** Why the balances after were not read, or the run was already closed. */
  readonly problem?: string;
}

/** Reads of the latest ledger that may fail in a row before the wait gives up. */
const MAX_FAILED_READS = 5;
/** Reads beyond the ledgers left to close, for a chain slower than its shortest unit. */
const SLACK_READS = 60;
/** The most reads in one wait, whatever is left to close. */
const MAX_READS = 400;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads `latest` until it is past `target`, sleeping `step` between reads. A
 * reading that is not a positive whole number counts as a failed read.
 * Returns false when it gives up: too many failed reads in a row, or the
 * ledger stopped moving for longer than the ledgers left to close allow.
 */
async function waitPast(
  latest: () => Promise<number>,
  target: number,
  sleep: (ms: number) => Promise<void>,
  step: number,
): Promise<boolean> {
  let failures = 0;
  let allowed: number | undefined;
  for (let reads = 0; allowed === undefined || reads < allowed; reads += 1) {
    let reading: unknown;
    try {
      reading = await latest();
    } catch {
      reading = undefined;
    }
    if (typeof reading === "number" && Number.isSafeInteger(reading) && reading > 0) {
      failures = 0;
      if (reading > target) return true;
      allowed ??= Math.min(MAX_READS, target - reading + SLACK_READS);
    } else {
      failures += 1;
      if (failures >= MAX_FAILED_READS) return false;
      allowed ??= MAX_READS;
    }
    await sleep(step);
  }
  return false;
}

/**
 * L4 of a mainnet run (spec B3, B5): reports, does not prevent. Waits until
 * every authorization the run signed, or may have signed, has expired: the
 * latest expiry its ledger holds and, for a signature whose expiry is not
 * known, the latest one the run's anchor allows a 300 s lifetime. Then waits
 * for public Horizon to have closed that ledger too, reads the payer's
 * balances after there (where the balances before were read), and closes the
 * ledger with them: consistent or not. A wait or a read that fails closes the
 * ledger without them, and `problem` says to wait and compare by hand.
 *
 * Always closes the opt-in, so its lock is released: nothing more is signed.
 *
 * @throws {ConfigurationError} When `optIn` is not an opt-in core made.
 */
export async function closeMainnetRun(optIn: MainnetOptIn, options: MainnetCloseOptions = {}): Promise<MainnetCloseResult> {
  if (!isMainnetOptIn(optIn)) throw new ConfigurationError("Not a mainnet opt-in.");
  if (optIn.closed) return { problem: "The mainnet run is already closed: its ledger was closed with it." };
  try {
    const ledger = optIn.ledger;
    const horizon = optIn.plan?.mainnet?.horizon;
    if (ledger === undefined || horizon === undefined) return {};
    const sleep = options.sleep ?? defaultSleep;
    const terms = paymentChainFor(optIn.network)?.signedTerms;
    const { latest, unknown } = openAuthorizationsUntil(ledger.entries);
    let target = latest;
    if (unknown > 0 && terms !== undefined) {
      const bound = anchorOfOptIn(optIn).maxExpiration(terms.unitSeconds, MAINNET_MAX_TIMEOUT_SECONDS);
      target = Math.max(target ?? 0, bound);
    }
    const unread = (what: string): MainnetCloseResult => ({
      consistency: ledger.close(),
      ledgerPath: ledger.path,
      ...(target === undefined ? {} : { waitedUntil: target }),
      problem:
        `The payer's balances after this run were not read: ${what} could not be confirmed. Read the ledger ` +
        `${basename(ledger.path)}, ${target === undefined ? "" : `wait until ledger ${target} has closed, `}then ` +
        `compare the payer's balances with it by hand.`,
    });
    if (unknown > 0 && terms === undefined) return unread("how long its signatures stay valid");
    if (target !== undefined) {
      if (terms === undefined) return unread("how long its signatures stay valid");
      const step = terms.unitSeconds * 1000;
      options.onProgress?.(
        `Waiting until ledger ${target} has closed: every authorization this run signed has expired by then. ` +
          `Then the payer's balances after are read on public Horizon.`,
      );
      const rpcUrl = optIn.rpcUrl;
      if (!(await waitPast(() => terms.latestUnit(optIn.network, rpcUrl), target, sleep, step))) {
        return unread(`that the RPC has closed ledger ${target}`);
      }
      if (!(await waitPast(() => readHorizonLatestLedger(horizon), target, sleep, step))) {
        return unread(`that public Horizon has closed ledger ${target}`);
      }
    }
    let after;
    try {
      after = await readHorizonAccount(horizon, optIn.payer);
    } catch {
      return unread("the payer's account on public Horizon");
    }
    const consistency = ledger.close({ after: { usdc: after.usdc, native: after.native }, source: `public Horizon (${horizon})` });
    return { consistency, ledgerPath: ledger.path, ...(target === undefined ? {} : { waitedUntil: target }) };
  } finally {
    optIn.close();
  }
}
