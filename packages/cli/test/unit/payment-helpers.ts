/**
 * Tests only: the recording chain of core's tests (`packages/core/test/support/
 * recording-chain.ts`), installed into the BUILT core the CLI imports, and a
 * paywall on loopback with one challenge per path that settles every paid
 * request it gets. The chain records every signature and holds nothing; no
 * request leaves 127.0.0.1 and no key is real.
 *
 * The seams are deep imports of core's dist, which the package index does not
 * export: no flag, setting or tool argument of the CLI reaches them.
 */

import http from "node:http";

import type { PaymentRequirements } from "@x402/core/types";

import { setRpcIdentityTransportForTesting } from "@wasit-dev/core/dist/guard/rpc-identity.js";
import { setPaymentChainsForTesting } from "@wasit-dev/core/dist/x402/chains/index.js";
import type { PaymentChain } from "@wasit-dev/core/dist/x402/chains/types.js";

export const NETWORK = "eip155:84532";
/** Base Sepolia USDC, 6 decimals: $1 is 1,000,000 base units. */
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
export const OTHER_PAY_TO = "0x1111111111111111111111111111111111111111";
export const PAYER = "0x2222222222222222222222222222222222222222";
/** The variable the recording chain reads its key from. */
export const KEY_ENV = "TEST_PAYER_KEY";

export interface Recorder {
  readonly signed: PaymentRequirements[];
}

export interface RecordingChainOptions {
  /** The variable the chain reads its key from. Default {@link KEY_ENV}. */
  readonly keyEnv?: string;
  /** Take any non-empty key, as a real chain takes any valid one. Default: only "test-payer-key". */
  readonly anyKey?: boolean;
  /** Give the chain an X402-11 watch that only exists: the plan counts X402-11; any read of it throws. */
  readonly stubWatch?: boolean;
}

function recordingChain(recorder: Recorder, options: RecordingChainOptions = {}): PaymentChain {
  return {
    name: "Recording",
    networks: [NETWORK],
    payerKeyEnv: options.keyEnv ?? KEY_ENV,
    referenceKind: "a test reference",
    resolveRpcUrl: (_network, override) => override || "http://127.0.0.1:9/rpc",
    registerPayer(client) {
      client.register(NETWORK, {
        scheme: "exact",
        findDefaultAsset: (asset, network) =>
          network === NETWORK && asset.toLowerCase() === USDC.toLowerCase()
            ? { asset: USDC, decimals: 6, symbol: "USDC" }
            : undefined,
        async createPaymentPayload(version, requirements) {
          recorder.signed.push(requirements);
          return { x402Version: version, payload: { signature: `sig-${recorder.signed.length}` } };
        },
      });
    },
    expiredSigning: async () => ({ terms: { maxTimeoutSeconds: 1 }, holdMs: 0 }),
    payerAddress: (key) => {
      if (options.anyKey === true ? key === "" : key !== "test-payer-key") throw new Error("not a test key");
      return PAYER;
    },
    generatePayerKey: () => "test-payer-key",
    payerBalance: async () => 10n ** 30n,
    isSettlementReference: (reference) => reference.startsWith("tx-"),
    verifySettlement: async () => ({ pass: true, detail: "settled (recording chain)" }),
    corruptPayload: (payload) => ({ ...payload, signature: "corrupted" }),
    ...(options.stubWatch === true
      ? {
          authorizations: {
            unit: "ledger",
            unitMs: 1,
            decode: () => {
              throw new Error("the stub watch reads nothing");
            },
            read: async () => {
              throw new Error("the stub watch reads nothing");
            },
            transfers: async () => {
              throw new Error("the stub watch reads nothing");
            },
          },
        }
      : {}),
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

export function option(amount: string, payTo = PAY_TO): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK as PaymentRequirements["network"],
    amount,
    asset: USDC,
    payTo,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  };
}

export interface MultiPaywall {
  readonly base: string;
  /** What each path answers unpaid requests with. */
  readonly accepts: Map<string, PaymentRequirements[]>;
  /** Paid requests received, by path. */
  readonly paid: Map<string, number>;
  /** Every request received, paid or not. */
  readonly requests: number;
  /** Called before an unpaid request on `path` is answered, with how many that path has had: lets a test change the terms mid-run. */
  onChallenge?: (path: string, count: number) => void;
  close(): Promise<void>;
}

/** A paywall that answers 402 on each configured path and settles every paid request. */
export async function multiPaywall(paths: Record<string, PaymentRequirements[]>): Promise<MultiPaywall> {
  const accepts = new Map(Object.entries(paths));
  const paid = new Map<string, number>();
  const challenges = new Map<string, number>();
  const hooks: { onChallenge?: (path: string, count: number) => void } = {};
  let requests = 0;
  const server = http.createServer((request, response) => {
    request.on("data", () => undefined);
    request.on("end", () => {
      requests += 1;
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!accepts.has(url.pathname)) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (typeof request.headers["payment-signature"] !== "string") {
        const count = (challenges.get(url.pathname) ?? 0) + 1;
        challenges.set(url.pathname, count);
        hooks.onChallenge?.(url.pathname, count);
      }
      const options = accepts.get(url.pathname) ?? [];
      if (typeof request.headers["payment-signature"] === "string") {
        const count = (paid.get(url.pathname) ?? 0) + 1;
        paid.set(url.pathname, count);
        const settled = { success: true, transaction: `tx-${url.pathname}-${count}`, network: NETWORK, payer: PAYER };
        response.writeHead(200, {
          "content-type": "application/json",
          "payment-response": Buffer.from(JSON.stringify(settled)).toString("base64"),
        });
        response.end("{}");
        return;
      }
      const challenge = { x402Version: 2, resource: { url: `http://127.0.0.1${url.pathname}` }, accepts: options };
      response.writeHead(402, {
        "content-type": "application/json",
        "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64"),
      });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}`,
    accepts,
    paid,
    get requests() {
      return requests;
    },
    get onChallenge() {
      return hooks.onChallenge;
    },
    set onChallenge(hook) {
      hooks.onChallenge = hook;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
