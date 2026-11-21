/**
 * The two reads a mainnet run makes on public Horizon (spec B5 point 4,
 * B17.2, B17.12), each a second source beside the run's RPC:
 *
 * - the latest ledger, which the RPC's latest ledger (the anchor of every
 *   signature's expiration bound) must be near;
 * - the payer's balances, which the RPC's USDC balance must equal, and which
 *   the run ledger records before and after the run (USDC and XLM).
 *
 * Both fail closed: an error status, a redirect (never followed), a body that
 * is not JSON or is too large, a Horizon of another network, or an answer that
 * cannot be read plainly is a {@link MainnetPlanRefusedError}. A message names
 * Horizon by its origin only.
 *
 * Read-only: no key, nothing signed or sent but two GET requests. This version
 * has no mainnet opt-in (spec B12), and nothing calls these yet.
 */

import { Networks, StrKey } from "@stellar/stellar-sdk";

import { MAINNET_USDC, MainnetPlanRefusedError, horizonBalances, type HorizonBalances } from "./mainnet-plan.js";

const TIMEOUT_MS = 10_000;

/** A Horizon answer larger than this is not read. The root and one account are a few KiB. */
const MAX_BODY_BYTES = 1024 * 1024;

function originOf(base: string): string {
  try {
    const url = new URL(base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "Horizon";
  } catch {
    return "Horizon";
  }
}

function refuse(base: string, what: string): MainnetPlanRefusedError {
  return new MainnetPlanRefusedError("horizon", `${what} could not be read from public Horizon (${originOf(base)}).`);
}

/** GET `path` on Horizon at `base`, as JSON; throws the refusal on anything but a plain 200 JSON answer. */
async function getJson(base: string, path: string, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw refuse(base, what);
  }
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw refuse(base, what);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        await response.body.cancel().catch(() => undefined);
        throw refuse(base, what);
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
  } catch (error) {
    if (error instanceof MainnetPlanRefusedError) throw error;
    throw refuse(base, what);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The latest ledger Horizon at `base` has ingested, from its root, when it
 * says it serves Stellar mainnet.
 */
export async function readHorizonLatestLedger(base: string): Promise<number> {
  const what = "The latest ledger";
  const root = await getJson(base, "/", what);
  if (!isRecord(root) || root["network_passphrase"] !== Networks.PUBLIC) {
    throw new MainnetPlanRefusedError(
      "horizon",
      `Public Horizon (${originOf(base)}) does not say it serves Stellar mainnet, so its latest ledger is not used.`,
    );
  }
  const ledger = root["history_latest_ledger"];
  if (typeof ledger !== "number" || !Number.isSafeInteger(ledger) || ledger <= 0) throw refuse(base, what);
  return ledger;
}

/**
 * The USDC (mainnet USDC's trustline; 0 without one) and XLM balances of the
 * account `payer` on Horizon at `base`, in base units. An address that is not
 * a Stellar account is refused before any request; so is an account Horizon
 * does not have.
 */
export async function readHorizonAccount(base: string, payer: string): Promise<HorizonBalances> {
  const what = "The payer's balances";
  if (typeof payer !== "string" || !StrKey.isValidEd25519PublicKey(payer)) {
    throw new MainnetPlanRefusedError("horizon", "The payer is not a Stellar account address, so Horizon was not asked for its balances.");
  }
  const account = await getJson(base, `/accounts/${payer}`, what);
  if (!isRecord(account) || account["account_id"] !== payer) throw refuse(base, what);
  const balances = horizonBalances(account, MAINNET_USDC);
  if (balances === undefined) throw refuse(base, what);
  return balances;
}
