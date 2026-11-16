/**
 * Which RPC a run reads the chain through, as a result names it (D-023c,
 * option C), and the start-up setting that fixes it for the MCP server.
 *
 * The RPC identity check (rpc-identity.ts) refuses an RPC of another network.
 * What it cannot see is an RPC of the right network that lies about a
 * settlement: that is a false PASS, not a payment on another chain. So a result
 * says which RPC it read through, by origin only (a key often rides in the path
 * or the query), where that RPC came from, and when it is not Wasit's default
 * for the network: then every chain read of the run is that RPC's word.
 *
 * `WASIT_RPC_URL`, read once when the MCP server starts, fixes the RPC of every
 * tool call; the server then refuses the `rpcUrl` argument, so an agent cannot
 * point a run at another RPC.
 */

import { urlOrigin } from "../config.js";
import { resolveRpcUrl as resolveMppRpcUrl } from "../mpp/network.js";
import { paymentChainFor } from "../x402/chains/index.js";
import { networkClass } from "./networks.js";

/** Where the RPC of a run came from. */
export type RpcSource = "default" | "argument" | "start-up";

export interface RpcInUse {
  /** The origin only: scheme, host and port. */
  readonly origin: string;
  readonly source: RpcSource;
  /** True when it is Wasit's default RPC for the network. */
  readonly isDefault: boolean;
}

/** The variable that fixes the MCP server's RPC at start-up. */
export const RPC_LOCK_VARIABLE = "WASIT_RPC_URL";

function defaultRpc(protocol: "x402" | "mpp", network: string): string | undefined {
  try {
    return protocol === "x402" ? paymentChainFor(network)?.resolveRpcUrl(network) : resolveMppRpcUrl(network);
  } catch {
    return undefined;
  }
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/**
 * The RPC a run on `network` reads through: `given` when there is one, else
 * Wasit's default for the network. Undefined on a network that is not a test
 * network (nothing is read there: the guard refuses first), and when there is
 * neither.
 */
export function rpcInUse(
  protocol: "x402" | "mpp",
  network: string,
  given?: { readonly url: string; readonly source: "argument" | "start-up" },
): RpcInUse | undefined {
  if (networkClass(network) !== "test") return undefined;
  const fallback = defaultRpc(protocol, network);
  if (fallback === undefined) return undefined;
  if (given === undefined) return { origin: urlOrigin(fallback), source: "default", isDefault: true };
  return { origin: urlOrigin(given.url), source: given.source, isDefault: sameUrl(given.url, fallback) };
}

/** One line for a result: which RPC, from where, and a flag when it is not the default. */
export function describeRpcInUse(network: string, rpc: RpcInUse): string {
  if (rpc.source === "default") return `RPC: ${rpc.origin}, Wasit's default for ${network}.`;
  const from = rpc.source === "argument" ? "from the rpcUrl argument" : `fixed when this server started (${RPC_LOCK_VARIABLE})`;
  return rpc.isDefault
    ? `RPC: ${rpc.origin}, ${from} (Wasit's default for ${network}).`
    : `RPC: ${rpc.origin}, ${from}: not Wasit's default for ${network}, so every chain read of this run is this RPC's word.`;
}

/**
 * The MCP server's RPC lock: `WASIT_RPC_URL` when it holds a value. Off when it
 * is unset or blank. A value that is not an http(s) URL is a problem the server
 * refuses to start on; the message never quotes the value.
 */
export function readRpcLock(
  env: Readonly<Record<string, string | undefined>>,
): { readonly url: string } | { readonly problem: string } | undefined {
  const value = env[RPC_LOCK_VARIABLE];
  if (value === undefined || value.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { problem: `${RPC_LOCK_VARIABLE} is not a valid absolute URL; include the scheme, e.g. https://rpc.example.com` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { problem: `${RPC_LOCK_VARIABLE} must be an http or https URL` };
  if (url.hostname === "") return { problem: `${RPC_LOCK_VARIABLE} has no host` };
  return { url: value.trim() };
}
