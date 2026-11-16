/**
 * The chains the x402 payment checks can pay on. Adding one is adding an
 * adapter here; the checks do not change.
 */

import { evmChain } from "./evm.js";
import { stellarChain } from "./stellar.js";
import { svmChain } from "./svm.js";
import type { PaymentChain } from "./types.js";

export type { PaymentChain } from "./types.js";

// Stellar first: it is the default network, and the only chain with MPP.
const CHAINS: readonly PaymentChain[] = [stellarChain, evmChain, svmChain];

let chains: readonly PaymentChain[] = CHAINS;

/**
 * Tests only: replaces the adapters, so a recording chain can stand in for a
 * real one (spec B11, the worst-case property test). `undefined` restores the
 * real ones. Not exported from the package index, and reachable from no flag,
 * setting or tool argument. The network guard still applies: a replacement
 * pays only on a test network.
 */
export function setPaymentChainsForTesting(replacement: readonly PaymentChain[] | undefined): void {
  chains = replacement ?? CHAINS;
}

/** The adapter that pays on `network`, if Wasit has one. */
export function paymentChainFor(network: string): PaymentChain | undefined {
  return chains.find((chain) => chain.networks.includes(network));
}

/** Every network the payment checks can pay on, in adapter order. */
export function paymentNetworks(): readonly string[] {
  return chains.flatMap((chain) => chain.networks);
}
