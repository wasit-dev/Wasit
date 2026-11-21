/**
 * L0, the network guard: which networks a payment may be made on.
 *
 * A fixed table, not a pattern. A network is paid on only after someone adds
 * it here, so a new chain, a new mainnet or a typo is refused rather than
 * paid on (fail closed). The guard is called from inside every core entry
 * point that can sign, so the CLI, the MCP server, the dashboard and any
 * third party using @wasit-dev/core get the same refusals; a guard in each
 * front end would be three copies, and one forgotten copy is a hole.
 *
 * `stellar:pubnet` has its own class: an x402 run pays on it only with a live
 * mainnet opt-in (spec B5), which only core makes (`openMainnetOptIn`). MPP
 * never pays on it.
 */

import { ConfigurationError } from "../errors.js";
import { isLiveOptIn, whyNotLive, type MainnetOptIn } from "./optin.js";

/** How the guard treats a network. */
export type NetworkClass = "test" | "mainnet-optin" | "unknown";

/** The protocol that would sign. MPP has no mainnet path at all. */
export type PaymentProtocol = "x402" | "mpp-charge" | "mpp-channel";

/**
 * Every network the guard knows. Test networks are the four the payment
 * checks pay on; `stellar:pubnet` is the only mainnet listed. Anything absent
 * is `unknown`, and refused.
 */
export const NETWORK_CLASSES: ReadonlyMap<string, Exclude<NetworkClass, "unknown">> = new Map([
  ["stellar:testnet", "test"],
  ["eip155:84532", "test"], // Base Sepolia
  ["eip155:11155111", "test"], // Ethereum Sepolia
  ["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "test"], // Solana devnet
  ["stellar:pubnet", "mainnet-optin"],
]);

/** The class of `network`; anything not in the table, or not a string, is `unknown`. */
export function networkClass(network: unknown): NetworkClass {
  return (typeof network === "string" && NETWORK_CLASSES.get(network)) || "unknown";
}

/** The test networks, in table order, for messages. */
function testNetworks(): string {
  return [...NETWORK_CLASSES]
    .filter(([, kind]) => kind === "test")
    .map(([network]) => network)
    .join(", ");
}

/**
 * A payment was refused because of the network it would be made on.
 *
 * A `ConfigurationError`: it says nothing about the target, only that this run
 * asked for something Wasit will not do. Nothing was sent when it is thrown.
 */
export class PaymentNetworkRefusedError extends ConfigurationError {
  public readonly network: string;
  public readonly networkClass: NetworkClass;
  public readonly protocol: PaymentProtocol;

  public constructor(protocol: PaymentProtocol, network: unknown, kind: NetworkClass, message: string) {
    super(`${message} Nothing was sent and nothing was signed.`);
    this.name = "PaymentNetworkRefusedError";
    this.network = String(network);
    this.networkClass = kind;
    this.protocol = protocol;
  }
}

/**
 * Throws unless a payment by `protocol` may be made on `network`.
 *
 * Call it before any request is sent and before any key or signer is used.
 * Test networks pass. `stellar:pubnet` passes for x402 only with `mainnet`, a
 * live opt-in for it (made by core, neither stopped nor closed); MPP stays on
 * test networks for good. Anything else is refused.
 *
 * @throws {PaymentNetworkRefusedError} For any network that is not a test network, but x402 on a live opt-in's.
 */
export function assertPaymentNetworkAllowed(protocol: PaymentProtocol, network: string, mainnet?: MainnetOptIn): void {
  const kind = networkClass(network);
  if (kind === "test") return;

  if (kind === "mainnet-optin" && protocol === "x402") {
    if (isLiveOptIn(mainnet, network)) return;
    // An opt-in core made, that is no longer live: say why, not that there is none.
    const why = whyNotLive(mainnet, network);
    if (why !== undefined) throw new PaymentNetworkRefusedError(protocol, network, kind, `${network} is Stellar mainnet, and ${why}.`);
  }

  if (kind === "mainnet-optin") {
    throw new PaymentNetworkRefusedError(
      protocol,
      network,
      kind,
      protocol === "x402"
        ? `${network} is Stellar mainnet. This version of Wasit pays on test networks ` +
            `only (${testNetworks()}); the mainnet opt-in is not part of this version.`
        : `${network} is Stellar mainnet, and MPP stays on test networks: the MPP ` +
            `checks pay on stellar:testnet only.`,
    );
  }

  throw new PaymentNetworkRefusedError(
    protocol,
    network,
    kind,
    `${JSON.stringify(network) ?? String(network)} is not on Wasit's list of test networks ` +
      `(${testNetworks()}), so no payment is made on it.`,
  );
}

