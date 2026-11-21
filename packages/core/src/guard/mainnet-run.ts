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

import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { DENIED_ENV_NAMES } from "../denied-env.js";
import { assertX402PaymentRpc } from "../x402/simulator.js";
import { RunBudget } from "./budget.js";
import { inGithubActions } from "./ci-event.js";
import { assertMainnetJob, type MainnetJob } from "./ci-mainnet.js";
import { assertMainnetPin } from "./mainnet-plan.js";
import { MainnetRunRefusedError, issueMainnetOptIn, type MainnetFrontEnd, type MainnetOptIn } from "./optin.js";
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
