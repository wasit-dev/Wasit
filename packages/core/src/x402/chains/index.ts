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

/** The adapter that pays on `network`, if Wasit has one. */
export function paymentChainFor(network: string): PaymentChain | undefined {
  return CHAINS.find((chain) => chain.networks.includes(network));
}

/** Every network the payment checks can pay on, in adapter order. */
export function paymentNetworks(): readonly string[] {
  return CHAINS.flatMap((chain) => chain.networks);
}
