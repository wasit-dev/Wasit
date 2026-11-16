/**
 * Tests only: a payment chain that records every signature and holds nothing,
 * and a paywall on loopback that settles everything it is sent (spec B11: "a
 * recording signer and a facilitator that settles everything signed").
 *
 * The chain stands in for Base Sepolia's adapter through
 * `setPaymentChainsForTesting`, so the guard, the budget and the SDK client
 * run as they do in a real run; only the signing and the chain reads are
 * replaced. The RPC identity check answers through its own test seam.
 */

import http from "node:http";

import type { PaymentRequirements } from "@x402/core/types";

import { setRpcIdentityTransportForTesting } from "../../src/guard/rpc-identity.js";
import { setPaymentChainsForTesting } from "../../src/x402/chains/index.js";
import type { PaymentChain } from "../../src/x402/chains/types.js";

export const NETWORK = "eip155:84532";
/** Base Sepolia USDC, 6 decimals: $1 is 1,000,000 base units. */
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
export const OTHER_PAY_TO = "0x1111111111111111111111111111111111111111";
export const PAYER = "0x2222222222222222222222222222222222222222";

export interface Recorder {
  /** Every option the scheme was asked to sign, in order. */
  readonly signed: PaymentRequirements[];
}

export interface RecordingChainOptions {
  /** A policy the "SDK" applies after Wasit's: it signs for another payee (B-A02). */
  readonly swapPayTo?: string;
}

export function recordingChain(recorder: Recorder, options: RecordingChainOptions = {}): PaymentChain {
  return {
    name: "Recording",
    networks: [NETWORK],
    payerKeyEnv: "TEST_PAYER_KEY",
    referenceKind: "a test reference",
    resolveRpcUrl: (_network, override) => override || "http://127.0.0.1:9/rpc",
    registerPayer(client) {
      client.register(NETWORK, {
        scheme: "exact",
        // As the real EVM scheme does: the SDK's own $1 cap applies to USDC.
        findDefaultAsset: (asset, network) =>
          network === NETWORK && asset.toLowerCase() === USDC.toLowerCase()
            ? { asset: USDC, decimals: 6, symbol: "USDC" }
            : undefined,
        async createPaymentPayload(version, requirements) {
          recorder.signed.push(requirements);
          return { x402Version: version, payload: { signature: `sig-${recorder.signed.length}` } };
        },
      });
      const swap = options.swapPayTo;
      if (swap !== undefined) {
        client.registerPolicy((_version, requirements) =>
          requirements.map((requirement) => ({ ...requirement, payTo: swap })),
        );
      }
    },
    expiredSigning: async () => ({ terms: { maxTimeoutSeconds: 1 }, holdMs: 0 }),
    payerAddress: () => PAYER,
    generatePayerKey: () => "test-payer-key",
    payerBalance: async () => 10n ** 30n,
    isSettlementReference: (reference) => reference.startsWith("tx-"),
    verifySettlement: async () => ({ pass: true, detail: "settled (recording chain)" }),
    corruptPayload: (payload) => ({ ...payload, signature: "corrupted" }),
  };
}

/** Installs the recording chain and an RPC that serves Base Sepolia. Returns the undo. */
export function installRecordingChain(recorder: Recorder, options: RecordingChainOptions = {}): () => void {
  setPaymentChainsForTesting([recordingChain(recorder, options)]);
  setRpcIdentityTransportForTesting(async (_url, method) => (method === "eth_chainId" ? "0x14a34" : undefined));
  return () => {
    setPaymentChainsForTesting(undefined);
    setRpcIdentityTransportForTesting(undefined);
  };
}

export interface ChallengeOption {
  readonly amount: string;
  readonly payTo?: string;
  readonly asset?: string;
  readonly network?: string;
  readonly scheme?: string;
  readonly extra?: Record<string, unknown>;
}

export function option(spec: ChallengeOption): PaymentRequirements {
  return {
    scheme: spec.scheme ?? "exact",
    network: (spec.network ?? NETWORK) as PaymentRequirements["network"],
    amount: spec.amount,
    asset: spec.asset ?? USDC,
    payTo: spec.payTo ?? PAY_TO,
    maxTimeoutSeconds: 60,
    extra: spec.extra ?? { name: "USDC", version: "2" },
  };
}

export interface Paywall {
  readonly url: string;
  /** What the next unpaid request is answered with. */
  accepts: PaymentRequirements[];
  /** Paid requests received. */
  readonly paid: number;
  /** Called on every unpaid request, before it is answered: lets a test change the terms mid-run. */
  onChallenge?: (count: number) => void;
  close(): Promise<void>;
}

/** A paywall that answers 402 with `accepts`, and settles every paid request it gets. */
export async function paywall(accepts: PaymentRequirements[], path = "/paid"): Promise<Paywall> {
  let paid = 0;
  let challenges = 0;
  const state: { accepts: PaymentRequirements[]; onChallenge?: (count: number) => void } = { accepts };
  const server = http.createServer((request, response) => {
    request.on("data", () => undefined);
    request.on("end", () => {
      if (typeof request.headers["payment-signature"] === "string") {
        paid += 1;
        const settled = { success: true, transaction: `tx-${paid}`, network: NETWORK, payer: PAYER };
        response.writeHead(200, {
          "content-type": "application/json",
          "payment-response": Buffer.from(JSON.stringify(settled)).toString("base64"),
        });
        response.end("{}");
        return;
      }
      challenges += 1;
      state.onChallenge?.(challenges);
      const challenge = { x402Version: 2, resource: { url: `http://127.0.0.1${path}` }, accepts: state.accepts };
      response.writeHead(402, {
        "content-type": "application/json",
        "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64"),
      });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}${path}`,
    get accepts() {
      return state.accepts;
    },
    set accepts(next: PaymentRequirements[]) {
      state.accepts = next;
    },
    get paid() {
      return paid;
    },
    get onChallenge() {
      return state.onChallenge;
    },
    set onChallenge(next: ((count: number) => void) | undefined) {
      if (next === undefined) delete state.onChallenge;
      else state.onChallenge = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Sum of what was signed, in base units. */
export function signedTotal(recorder: Recorder): bigint {
  return recorder.signed.reduce((sum, requirement) => sum + BigInt(requirement.amount), 0n);
}
