/**
 * The RPC identity check (D-032, D-023a+b): before a run signs anything or
 * reads a settlement, the RPC it was given must say which network it serves,
 * and it must be the run's.
 *
 * L0 judges the network the run is labelled with. The RPC is a separate input
 * (`--rpc-url`, the MCP tool argument `rpcUrl`, the config), and nothing tied
 * the two together: a `stellar:testnet` run pointed at a mainnet RPC signed a
 * mainnet-valid channel commitment in 0.7.0, and every settlement read of such
 * a run comes from another chain. So each entry point that signs or reads a
 * settlement asks the RPC first:
 *
 * - Stellar: `getNetwork`, whose `passphrase` must be the run's network's;
 * - EVM: `eth_chainId`, which must equal the CAIP-2 reference;
 * - Solana: `getGenesisHash`, whose first characters are the CAIP-2 reference.
 *
 * A mismatch, no answer, or an answer that cannot be read refuses the run
 * before any request reaches the target (fail closed). This guards against a
 * mistake or a wrong default, not against an RPC that lies: an RPC that answers
 * the right identity and then serves another chain is outside what any client
 * check can see.
 */

import { Networks } from "@stellar/stellar-sdk";

import { ConfigurationError } from "../errors.js";
import { sanitizeText } from "../sanitize.js";

/** The RPC does not serve the run's network, or would not say which one it serves. Nothing was sent or signed. */
export class RpcIdentityError extends ConfigurationError {
  public constructor(message: string) {
    super(message);
    this.name = "RpcIdentityError";
  }
}

/** One JSON-RPC call: the `result`, or a throw. */
export type RpcIdentityTransport = (rpcUrl: string, method: string) => Promise<unknown>;

const TIMEOUT_MS = 10_000;

/** The origin of the RPC for a message: its path or query may hold an API key. */
function origin(rpcUrl: string): string {
  try {
    const parsed = new URL(rpcUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : "an RPC that is not an http URL";
  } catch {
    return "an RPC that is not a URL";
  }
}

const jsonRpc: RpcIdentityTransport = async (rpcUrl, method) => {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
    // An RPC that redirects is not followed: the identity must come from the
    // URL the run will use.
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${response.status}`);
  }
  const body = (await response.json()) as { result?: unknown; error?: { message?: unknown } };
  if (body.error !== undefined) {
    throw new Error(typeof body.error.message === "string" ? body.error.message : "a JSON-RPC error");
  }
  return body.result;
};

let transport: RpcIdentityTransport = jsonRpc;

/**
 * Tests only: replaces the JSON-RPC call (an SDK that accepts only https RPCs
 * cannot be given a loopback stand-in). `undefined` restores the real one. Not
 * exported from the package index, and reachable from no flag, setting or tool
 * argument.
 */
export function setRpcIdentityTransportForTesting(replacement: RpcIdentityTransport | undefined): void {
  transport = replacement ?? jsonRpc;
}

const STELLAR_PASSPHRASES: ReadonlyMap<string, string> = new Map([
  ["stellar:testnet", Networks.TESTNET],
  ["stellar:pubnet", Networks.PUBLIC],
]);

/** The network a Stellar passphrase belongs to, for the message. */
function stellarNetworkOf(passphrase: string): string {
  for (const [network, known] of STELLAR_PASSPHRASES) if (known === passphrase) return network;
  return `a network with the passphrase "${sanitizeText(passphrase).slice(0, 80)}"`;
}

/** The method to ask, and how to read the answer into the CAIP-2 id it shows (or `undefined` when unreadable). */
function ruleFor(network: string): { method: string; served: (result: unknown) => string | undefined } | undefined {
  const [namespace, reference] = network.split(":", 2);
  if (reference === undefined || reference === "") return undefined;
  if (namespace === "stellar" && STELLAR_PASSPHRASES.has(network)) {
    return {
      method: "getNetwork",
      served: (result) => {
        const passphrase = (result as { passphrase?: unknown } | null)?.passphrase;
        return typeof passphrase === "string" ? stellarNetworkOf(passphrase) : undefined;
      },
    };
  }
  if (namespace === "eip155" && /^[1-9][0-9]*$/.test(reference)) {
    return {
      method: "eth_chainId",
      served: (result) => {
        if (typeof result !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(result)) return undefined;
        return `eip155:${BigInt(result).toString()}`;
      },
    };
  }
  if (namespace === "solana" && /^[1-9A-HJ-NP-Za-km-z]{32}$/.test(reference)) {
    return {
      method: "getGenesisHash",
      served: (result) => {
        if (typeof result !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(result)) return undefined;
        return `solana:${result.slice(0, 32)}`;
      },
    };
  }
  return undefined;
}

/**
 * Refuses unless the RPC at `rpcUrl` says it serves `network`.
 *
 * @throws {RpcIdentityError} The RPC serves another network, did not answer, or
 *   answered something that does not name a network; or Wasit has no rule to
 *   tell which network an RPC for `network` serves. Nothing was sent to the
 *   target and nothing was signed.
 */
export async function assertRpcServesNetwork(network: string, rpcUrl: string): Promise<void> {
  const label = sanitizeText(network);
  const at = sanitizeText(origin(rpcUrl));
  const rule = ruleFor(network);
  if (rule === undefined) {
    throw new RpcIdentityError(
      `Wasit cannot tell which network an RPC for ${label} serves, so it does not pay or read ` +
        `settlements through ${at}; nothing was signed.`,
    );
  }

  let result: unknown;
  try {
    result = await transport(rpcUrl, rule.method);
  } catch (error) {
    const reason = sanitizeText(error instanceof Error ? error.message : String(error)).slice(0, 160);
    throw new RpcIdentityError(
      `The RPC at ${at} did not say which network it serves (${rule.method}: ${reason}), so Wasit ` +
        `could not confirm it is ${label}. No payment was sent and nothing was signed.`,
    );
  }

  const served = rule.served(result);
  if (served === undefined) {
    throw new RpcIdentityError(
      `The RPC at ${at} answered ${rule.method} with something that does not name a network, so ` +
        `Wasit could not confirm it is ${label}. No payment was sent and nothing was signed.`,
    );
  }
  if (served !== network) {
    throw new RpcIdentityError(
      `The RPC at ${at} serves ${served}, and this run is on ${label}. Wasit pays and reads ` +
        `settlements only through an RPC of the run's own network, so no payment was sent and ` +
        `nothing was signed. Point the run at an RPC for ${label}.`,
    );
  }
}
