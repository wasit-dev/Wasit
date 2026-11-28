/**
 * Tests only: Stellar's two networks with every gate that is not Wasit's own
 * stood in, for the mainnet opt-in (spec B5, B18 O1). Nothing here holds
 * funds or reaches a real network.
 *
 * - The chain records every option its scheme is asked to sign and every
 *   `registerPayer` call (network, RPC, opt-in), and reads balances, decimals
 *   and the latest ledger from `state`, which a test changes.
 * - The RPC identity check answers through its own seam: the passphrase of
 *   the network the URL's path names (`https://rpc.example/stellar:pubnet`).
 * - Public Horizon is a loopback server answering from `state`, installed
 *   through the plan's seam.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import { Keypair, Networks } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";

import { setRpcIdentityTransportForTesting } from "../../src/guard/rpc-identity.js";
import { setPaymentChainsForTesting } from "../../src/x402/chains/index.js";
import type { PaymentChain } from "../../src/x402/chains/types.js";
import { setPubnetHorizonForTesting } from "../../src/x402/plan.js";

export const PUBNET = "stellar:pubnet";
export const TESTNET = "stellar:testnet";
/** Circle's USDC on Stellar mainnet (guard/mainnet-plan.ts). */
export const PUBNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
export const PUBNET_USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
export const TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const PUBNET_RPC = "https://rpc.example/stellar:pubnet";

export interface PubnetState {
  /** What the RPC reads as the payer's USDC, base units; undefined = no reading. */
  rpcUsdc: bigint | undefined;
  /** What Horizon lists for the payer, base units; undefined = no trustline. */
  horizonUsdc: bigint | undefined;
  horizonNative: bigint;
  /** The token's decimals as the RPC reads them. */
  decimals: unknown;
  rpcLatest: number;
  horizonLatest: number;
  /** HTTP status Horizon answers with. */
  horizonStatus: number;
  /** The passphrase Horizon's root states. */
  horizonPassphrase: string;
}

export function defaultState(): PubnetState {
  return {
    rpcUsdc: 50_000_000n,
    horizonUsdc: 50_000_000n,
    horizonNative: 25_000_000n,
    decimals: 7,
    rpcLatest: 61_000_000,
    horizonLatest: 61_000_002,
    horizonStatus: 200,
    horizonPassphrase: Networks.PUBLIC,
  };
}

export interface RegisteredPayer {
  readonly network: string;
  readonly rpcUrl: string;
  readonly mainnet: unknown;
}

export interface PubnetWorld {
  readonly state: PubnetState;
  /** Every option the scheme was asked to sign. */
  readonly signed: PaymentRequirements[];
  readonly registered: RegisteredPayer[];
  /** Calls the chain's reads received, by name. */
  readonly reads: string[];
  /** Requests public Horizon received. */
  readonly horizonRequests: string[];
  /** RPC identity calls, as `url method`. */
  readonly identityCalls: string[];
  close(): Promise<void>;
}

function asset(network: string): string {
  return network === PUBNET ? PUBNET_USDC : TESTNET_USDC;
}

function stellarAmount(units: bigint): string {
  const whole = units / 10_000_000n;
  const fraction = (units % 10_000_000n).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}

/** Installs the stand-in chain, the identity seam and the Horizon stand-in. */
export async function installPubnetWorld(): Promise<PubnetWorld> {
  const state = defaultState();
  const signed: PaymentRequirements[] = [];
  const registered: RegisteredPayer[] = [];
  const reads: string[] = [];
  const horizonRequests: string[] = [];
  const identityCalls: string[] = [];

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
    registerPayer(client, network, _payerKey, rpcUrl, _gate, mainnet) {
      registered.push({ network, rpcUrl, mainnet });
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
    if (state.horizonStatus !== 200) {
      response.writeHead(state.horizonStatus, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    let body: unknown;
    if (url === "/") {
      body = { history_latest_ledger: state.horizonLatest, network_passphrase: state.horizonPassphrase };
    } else if (url.startsWith("/accounts/")) {
      const account = url.slice("/accounts/".length);
      const balances: unknown[] = [{ asset_type: "native", balance: stellarAmount(state.horizonNative) }];
      if (state.horizonUsdc !== undefined) {
        balances.unshift({
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: PUBNET_USDC_ISSUER,
          balance: stellarAmount(state.horizonUsdc),
        });
      }
      body = { account_id: account, balances };
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
    registered,
    reads,
    horizonRequests,
    identityCalls,
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

/** An `exact` option on `network` in its USDC, valid for `maxTimeoutSeconds`. */
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
