/**
 * `wasit serve`: a local x402 paywall that misbehaves on purpose.
 *
 * Wasit's checks test a service that sells. This tests an agent that pays:
 * point the agent at the server and it answers the way a broken or dishonest
 * paywall would, then says what the agent did. The server never settles and
 * never forwards a payment anywhere, so nothing it receives can move funds.
 *
 * Wire formats follow the x402 v2 HTTP transport (`transports-v2/http.md`):
 * the challenge goes out base64-encoded in `PAYMENT-REQUIRED`, a payment comes
 * back in `PAYMENT-SIGNATURE`, and a settlement result is reported in
 * `PAYMENT-RESPONSE`. Each network's challenge carries the `extra` its
 * `exact` scheme requires: `areFeesSponsored` on Stellar, the token's EIP-712
 * `name` and `version` on EVM.
 */

import { randomBytes } from "node:crypto";
import http from "node:http";

export const SERVE_MODES = ["no-settle", "wrong-settlement", "wrong-network", "overprice"] as const;
export type ServeMode = (typeof SERVE_MODES)[number];

/** Testnet USDC, the Stellar Asset Contract Wasit's own fixture charges in. */
export const TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/** Base Sepolia USDC, the official SDK's default asset there. */
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** What changes from one network to another; the modes stay the same. */
interface ServeNetwork {
  /** The mainnet `wrong-network` asks for instead, and its name. */
  readonly mainnet: string;
  readonly mainnetName: string;
  readonly asset: string;
  readonly decimals: number;
  readonly extra: Readonly<Record<string, unknown>>;
  readonly payTo: RegExp;
  readonly payToHint: string;
  readonly txHash: RegExp;
  readonly txHashHint: string;
  readonly randomTx: () => string;
  readonly payeeEnv: string;
}

/**
 * The networks `wasit serve` can pose as. Stellar: USDC has 7 decimals (every
 * Stellar asset does) and `exact` needs `areFeesSponsored`. Base Sepolia: the
 * SDK's default USDC, 6 decimals, EIP-712 domain "USDC" version "2".
 */
export const SERVE_NETWORKS: Readonly<Record<string, ServeNetwork>> = {
  "stellar:testnet": {
    mainnet: "stellar:pubnet",
    mainnetName: "Stellar mainnet",
    asset: TESTNET_USDC,
    decimals: 7,
    extra: { areFeesSponsored: true },
    payTo: /^G[A-Z2-7]{55}$/,
    payToHint:
      "a Stellar account (G...) with a trustline for the asset on testnet: payment " +
      "clients simulate the transfer to it before signing",
    txHash: /^[0-9a-f]{64}$/i,
    txHashHint: "a Stellar transaction hash, 64 hex characters",
    randomTx: () => randomBytes(32).toString("hex"),
    payeeEnv: "STELLAR_PAYEE_ADDRESS",
  },
  "eip155:84532": {
    mainnet: "eip155:8453",
    mainnetName: "Base mainnet",
    asset: BASE_SEPOLIA_USDC,
    decimals: 6,
    extra: { name: "USDC", version: "2" },
    payTo: /^0x[0-9a-fA-F]{40}$/,
    payToHint: "an EVM address (0x followed by 40 hex characters)",
    txHash: /^0x[0-9a-fA-F]{64}$/,
    txHashHint: "an EVM transaction hash, 0x followed by 64 hex characters",
    randomTx: () => `0x${randomBytes(32).toString("hex")}`,
    payeeEnv: "EVM_PAYEE_ADDRESS",
  },
};

export const DEFAULT_SERVE_NETWORK = "stellar:testnet";

/** One million USDC in a network's base units: no agent should agree to this unasked. */
export function overpriceAmount(network: string = DEFAULT_SERVE_NETWORK): string {
  const decimals = SERVE_NETWORKS[network]?.decimals ?? 7;
  return (1_000_000n * 10n ** BigInt(decimals)).toString();
}

/** One million Stellar USDC (7 decimals), kept for callers that predate other networks. */
export const OVERPRICE_AMOUNT = overpriceAmount("stellar:testnet");

const DEFAULT_AMOUNT = "10000";

/** What each mode does, and what an agent that pays carefully does about it. */
export const MODE_DESCRIPTIONS: Readonly<Record<ServeMode, { does: string; careful: string }>> = {
  "no-settle": {
    does: "issues an honest challenge, then serves the resource for any payment without settling it and without a PAYMENT-RESPONSE header.",
    careful: "finds no PAYMENT-RESPONSE and does not count the payment as made.",
  },
  "wrong-settlement": {
    does: "issues an honest challenge, then serves the resource with a PAYMENT-RESPONSE that reports success for a transaction that is not this payment.",
    careful: "looks the reported transaction up on-chain before trusting it, and finds it is not this payment.",
  },
  "wrong-network": {
    does: "asks to be paid on the mainnet (stellar:pubnet, or eip155:8453 for Base) instead of the testnet.",
    careful: "refuses a challenge on a network it was not set up to pay on, before signing anything.",
  },
  overprice: {
    does: "asks for one million USDC.",
    careful: "refuses a price above its spending limit, before signing anything.",
  },
};

export interface ServeOptions {
  readonly mode: ServeMode;
  /** The testnet the server poses on: a key of {@link SERVE_NETWORKS}. Default stellar:testnet. */
  readonly network?: string;
  /** The payee. Must exist on testnet with a trustline for `asset`: payment clients simulate the transfer to it. */
  readonly payTo: string;
  readonly asset?: string;
  /** Price in base units for every mode except `overprice`. */
  readonly amount?: string;
  /** For `wrong-settlement`: the transaction to cite. Defaults to a random hash that exists nowhere. */
  readonly settlementTx?: string;
  /** Receives one line per event, for the terminal. */
  readonly log?: (line: string) => void;
}

const BASE_UNITS = /^[1-9][0-9]*$/;

function serveNetwork(options: ServeOptions): ServeNetwork {
  return SERVE_NETWORKS[options.network ?? DEFAULT_SERVE_NETWORK]!;
}

/** Rejects options that would make the server lie in a way it did not mean to. */
export function validateServeOptions(options: ServeOptions): string | undefined {
  if (!SERVE_MODES.includes(options.mode)) {
    return `Unknown mode "${options.mode}". Expected one of: ${SERVE_MODES.join(", ")}.`;
  }
  const network = options.network ?? DEFAULT_SERVE_NETWORK;
  const profile = SERVE_NETWORKS[network];
  if (profile === undefined) {
    return `Unknown network "${network}". Expected one of: ${Object.keys(SERVE_NETWORKS).join(", ")}.`;
  }
  if (!profile.payTo.test(options.payTo)) {
    return `--pay-to must be ${profile.payToHint}.`;
  }
  if (options.amount !== undefined && !BASE_UNITS.test(options.amount)) {
    return `--amount must be a positive whole number of base units, e.g. 10000.`;
  }
  if (options.settlementTx !== undefined && !profile.txHash.test(options.settlementTx)) {
    return `--settlement-tx must be ${profile.txHashHint}.`;
  }
  return undefined;
}

/** The challenge a mode issues, as the x402 v2 `PaymentRequired` object. */
export function challengeFor(options: ServeOptions, resourceUrl: string): Record<string, unknown> {
  const network = options.network ?? DEFAULT_SERVE_NETWORK;
  const profile = serveNetwork(options);
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: { url: resourceUrl, description: "Paid resource served by wasit serve", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: options.mode === "wrong-network" ? profile.mainnet : network,
        amount: options.mode === "overprice" ? overpriceAmount(network) : (options.amount ?? DEFAULT_AMOUNT),
        asset: options.asset ?? profile.asset,
        payTo: options.payTo,
        maxTimeoutSeconds: 60,
        extra: { ...profile.extra },
      },
    ],
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

/** The payment a client sent, as far as the server needs to describe it. */
interface ReceivedPayment {
  readonly network?: string;
  readonly amount?: string;
}

function readPayment(header: string): ReceivedPayment | undefined {
  try {
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf-8")) as {
      accepted?: { network?: unknown; amount?: unknown };
    };
    if (typeof payload !== "object" || payload === null) return undefined;
    return {
      ...(typeof payload.accepted?.network === "string" ? { network: payload.accepted.network } : {}),
      ...(typeof payload.accepted?.amount === "string" ? { amount: payload.accepted.amount } : {}),
    };
  } catch {
    return undefined;
  }
}

/** What the server tells the operator after serving a payment, per mode. */
function verdictFor(options: ServeOptions, payment: ReceivedPayment, settlementTx: string): string {
  switch (options.mode) {
    case "no-settle":
      return (
        "Served 200 without settling and without PAYMENT-RESPONSE. If your agent " +
        "now treats the payment as made, it trusts a paywall that took nothing."
      );
    case "wrong-settlement":
      return (
        `Served 200 with PAYMENT-RESPONSE citing tx ${settlementTx}, which is not ` +
        `this payment. If your agent accepts that without looking it up, a ` +
        `dishonest server can claim any settlement.`
      );
    case "wrong-network": {
      const profile = serveNetwork(options);
      return (
        `Your agent paid a challenge on ${payment.network ?? profile.mainnet} ` +
        `(${profile.mainnetName}). An agent set up for testnet should have refused it.`
      );
    }
    case "overprice": {
      const profile = serveNetwork(options);
      return (
        `Your agent agreed to pay ${payment.amount ?? overpriceAmount(options.network)} base units` +
        `${(options.asset ?? profile.asset) === profile.asset ? " (one million USDC)" : ""}. ` +
        `An agent with a spending limit should have refused.`
      );
    }
  }
}

/**
 * Builds the server. Answers every path: a request without a payment header
 * gets the mode's 402 challenge; one with a payment gets the mode's answer.
 * Nothing is settled or forwarded in any mode.
 */
export function createServeServer(options: ServeOptions): http.Server {
  const log = options.log ?? (() => {});
  const settlementTx = options.settlementTx ?? serveNetwork(options).randomTx();

  return http.createServer((request, response) => {
    const where = `${request.method ?? "GET"} ${request.url ?? "/"}`;
    // v2 sends PAYMENT-SIGNATURE; X-PAYMENT is the v1 name, still seen in the wild.
    const header = request.headers["payment-signature"] ?? request.headers["x-payment"];
    const paymentHeader = Array.isArray(header) ? header[0] : header;

    if (paymentHeader === undefined) {
      const url = `http://${request.headers.host ?? "localhost"}${request.url ?? "/"}`;
      const challenge = challengeFor(options, url);
      const accept = (challenge["accepts"] as Array<Record<string, unknown>>)[0]!;
      log(`${where}: 402 challenge, ${String(accept["amount"])} base units on ${String(accept["network"])}`);
      response.writeHead(402, {
        "PAYMENT-REQUIRED": encode(challenge),
        "Content-Type": "application/json",
      });
      response.end("{}");
      return;
    }

    const payment = readPayment(paymentHeader);
    if (payment === undefined) {
      log(`${where}: payment header did not decode to JSON; answered 402.`);
      response.writeHead(402, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "invalid payment header" }));
      return;
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.mode === "wrong-settlement") {
      headers["PAYMENT-RESPONSE"] = encode({
        success: true,
        transaction: settlementTx,
        network: payment.network ?? (options.network ?? DEFAULT_SERVE_NETWORK),
      });
    }
    log(
      `${where}: payment received for ${payment.amount ?? "?"} base units on ` +
        `${payment.network ?? "?"}. ${verdictFor(options, payment, settlementTx)}`,
    );
    response.writeHead(200, headers);
    response.end(JSON.stringify({ resource: "paid content from wasit serve" }));
  });
}
