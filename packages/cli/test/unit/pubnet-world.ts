/**
 * Tests only: core's pubnet stand-in (`packages/core/test/support/
 * pubnet-chain.ts`), installed into the BUILT core the CLI imports, for
 * `wasit run --mainnet` (spec B5, B18 O2). Nothing here holds funds or reaches
 * a real network: the chain records what its scheme is asked to sign and signs
 * nothing real, the RPC identity check answers through its seam, public
 * Horizon is a loopback server, and the paywall settles every paid request.
 *
 * The seams are deep imports of core's dist, which the package index does not
 * export: no flag, setting or tool argument of the CLI reaches them.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import { Keypair, Networks } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";

import { setRpcIdentityTransportForTesting } from "@wasit-dev/core/dist/guard/rpc-identity.js";
import { setPaymentChainsForTesting } from "@wasit-dev/core/dist/x402/chains/index.js";
import type { PaymentChain } from "@wasit-dev/core/dist/x402/chains/types.js";
import { setPubnetHorizonForTesting } from "@wasit-dev/core/dist/x402/plan.js";

export const PUBNET = "stellar:pubnet";
export const TESTNET = "stellar:testnet";
export const PUBNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
export const PUBNET_USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
export const TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const PUBNET_RPC = "https://rpc.example/stellar:pubnet";

export interface PubnetState {
  rpcUsdc: bigint | undefined;
  horizonUsdc: bigint | undefined;
  horizonNative: bigint;
  decimals: unknown;
  rpcLatest: number;
  horizonLatest: number;
}

export interface PubnetWorld {
  readonly state: PubnetState;
  readonly signed: PaymentRequirements[];
  /** Calls the chain's reads received, by name. */
  readonly reads: string[];
  readonly horizonRequests: string[];
  readonly identityCalls: string[];
  /** A sleep for the run's L4 wait: each call closes `ledgers` ledgers on the stand-in RPC and Horizon. */
  sleep(ledgers?: number): (ms: number) => Promise<void>;
  close(): Promise<void>;
}

function stellarAmount(units: bigint): string {
  return `${units / 10_000_000n}.${(units % 10_000_000n).toString().padStart(7, "0")}`;
}

export async function installPubnetWorld(): Promise<PubnetWorld> {
  const state: PubnetState = {
    rpcUsdc: 50_000_000n,
    horizonUsdc: 50_000_000n,
    horizonNative: 25_000_000n,
    decimals: 7,
    rpcLatest: 61_000_000,
    horizonLatest: 61_000_002,
  };
  const signed: PaymentRequirements[] = [];
  const reads: string[] = [];
  const horizonRequests: string[] = [];
  const identityCalls: string[] = [];
  const asset = (network: string): string => (network === PUBNET ? PUBNET_USDC : TESTNET_USDC);

  const chain: PaymentChain = {
    name: "Stand-in Stellar",
    networks: [TESTNET, PUBNET],
    payerKeyEnv: "STELLAR_PRIVATE_KEY",
    referenceKind: "a test reference",
    resolveRpcUrl: (network, override) => {
      if (override) return override;
      if (network === TESTNET) return "https://rpc.example/stellar:testnet";
      throw new Error("No default RPC endpoint for stellar:pubnet.");
    },
    httpsRpcOnly: true,
    registerPayer(client) {
      for (const on of [TESTNET, PUBNET] as const) {
        client.register(on, {
          scheme: "exact",
          findDefaultAsset: (wanted, where) => (where === on && wanted === asset(on) ? { asset: wanted, decimals: 7, symbol: "USDC" } : undefined),
          async createPaymentPayload(version, requirements) {
            signed.push(requirements);
            return { x402Version: version, payload: { signature: `sig-${signed.length}` } };
          },
        });
      }
    },
    signedTerms: {
      unitSeconds: 5,
      async latestUnit() {
        reads.push("latestUnit");
        return state.rpcLatest;
      },
      bind() {
        // The stand-in scheme does not sign through the gate: nothing to bind.
      },
    },
    async assetDecimals() {
      reads.push("assetDecimals");
      return state.decimals as number;
    },
    expiredSigning: async () => ({ terms: { maxTimeoutSeconds: 1 }, holdMs: 0 }),
    payerAddress: (key) => Keypair.fromSecret(key).publicKey(),
    generatePayerKey: () => Keypair.random().secret(),
    async payerBalance() {
      reads.push("payerBalance");
      return state.rpcUsdc;
    },
    isSettlementReference: (reference) => reference.startsWith("tx-"),
    verifySettlement: async () => ({ pass: true, detail: "settled (stand-in chain)" }),
    corruptPayload: (payload) => ({ ...payload, signature: "corrupted" }),
  };
  setPaymentChainsForTesting([chain]);
  setRpcIdentityTransportForTesting(async (url, method) => {
    identityCalls.push(`${url} ${method}`);
    if (method !== "getNetwork") return undefined;
    const network = decodeURIComponent(new URL(url).pathname.slice(1));
    return { passphrase: network === TESTNET ? Networks.TESTNET : Networks.PUBLIC };
  });

  const server = http.createServer((request, response) => {
    const url = request.url ?? "";
    horizonRequests.push(url);
    let body: unknown;
    if (url === "/") {
      body = { history_latest_ledger: state.horizonLatest, network_passphrase: Networks.PUBLIC };
    } else if (url.startsWith("/accounts/")) {
      const balances: unknown[] = [{ asset_type: "native", balance: stellarAmount(state.horizonNative) }];
      if (state.horizonUsdc !== undefined) {
        balances.unshift({ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: PUBNET_USDC_ISSUER, balance: stellarAmount(state.horizonUsdc) });
      }
      body = { account_id: url.slice("/accounts/".length), balances };
    } else {
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  setPubnetHorizonForTesting(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);

  return {
    state,
    signed,
    reads,
    horizonRequests,
    identityCalls,
    sleep: (ledgers = 10) => async () => {
      state.rpcLatest += ledgers;
      state.horizonLatest = state.rpcLatest;
    },
    close: async () => {
      setPaymentChainsForTesting(undefined);
      setRpcIdentityTransportForTesting(undefined);
      setPubnetHorizonForTesting(undefined);
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

export function pubnetOption(payTo: string, amount: bigint, overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: PUBNET as PaymentRequirements["network"],
    amount: amount.toString(),
    asset: PUBNET_USDC,
    payTo,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
    ...overrides,
  };
}

export interface PubnetWall {
  readonly base: string;
  /** What each path answers unpaid requests with; a test may change it mid-run. */
  readonly accepts: Map<string, PaymentRequirements[]>;
  /** Paid requests received, by path. */
  readonly paid: Map<string, number>;
  /** Every request received, paid or not. */
  readonly requests: number;
  /** Unpaid requests received, by path: lets a test change the terms after the plan. */
  onChallenge?: (path: string, count: number) => void;
  close(): Promise<void>;
}

/** A paywall on loopback that answers 402 on each configured path and settles every paid request on pubnet. */
export async function pubnetWall(paths: Record<string, PaymentRequirements[]>): Promise<PubnetWall> {
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
      const options = accepts.get(url.pathname);
      if (options === undefined) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (typeof request.headers["payment-signature"] === "string") {
        const count = (paid.get(url.pathname) ?? 0) + 1;
        paid.set(url.pathname, count);
        const settled = { success: true, transaction: `tx-${url.pathname.slice(1)}-${count}`, network: PUBNET };
        response.writeHead(200, { "content-type": "application/json", "payment-response": Buffer.from(JSON.stringify(settled)).toString("base64") });
        response.end("{}");
        return;
      }
      const count = (challenges.get(url.pathname) ?? 0) + 1;
      challenges.set(url.pathname, count);
      hooks.onChallenge?.(url.pathname, count);
      const challenge = { x402Version: 2, resource: { url: `http://127.0.0.1${url.pathname}` }, accepts: accepts.get(url.pathname) ?? [] };
      response.writeHead(402, { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") });
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
