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
 * `PAYMENT-RESPONSE`. The challenge carries `extra.areFeesSponsored`, which
 * the `exact` scheme on Stellar requires.
 */

import { randomBytes } from "node:crypto";
import http from "node:http";

export const SERVE_MODES = ["no-settle", "wrong-settlement", "wrong-network", "overprice"] as const;
export type ServeMode = (typeof SERVE_MODES)[number];

/** Testnet USDC, the Stellar Asset Contract Wasit's own fixture charges in. */
export const TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/** Every Stellar asset, USDC included, has 7 decimal places. */
const STELLAR_DECIMALS = 7;

/** One million USDC in base units: no agent should agree to this unasked. */
export const OVERPRICE_AMOUNT = (1_000_000n * 10n ** BigInt(STELLAR_DECIMALS)).toString();

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
    does: "asks to be paid on stellar:pubnet (mainnet) instead of stellar:testnet.",
    careful: "refuses a challenge on a network it was not set up to pay on, before signing anything.",
  },
  overprice: {
    does: `asks for ${OVERPRICE_AMOUNT} base units, one million USDC.`,
    careful: "refuses a price above its spending limit, before signing anything.",
  },
};

export interface ServeOptions {
  readonly mode: ServeMode;
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

const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/;
const TRANSACTION_HASH = /^[0-9a-f]{64}$/i;
const BASE_UNITS = /^[1-9][0-9]*$/;

/** Rejects options that would make the server lie in a way it did not mean to. */
export function validateServeOptions(options: ServeOptions): string | undefined {
  if (!SERVE_MODES.includes(options.mode)) {
    return `Unknown mode "${options.mode}". Expected one of: ${SERVE_MODES.join(", ")}.`;
  }
  if (!STELLAR_ACCOUNT.test(options.payTo)) {
    return (
      `--pay-to must be a Stellar account (G...), with a trustline for the asset on ` +
      `testnet: payment clients simulate the transfer to it before signing.`
    );
  }
  if (options.amount !== undefined && !BASE_UNITS.test(options.amount)) {
    return `--amount must be a positive whole number of base units, e.g. 10000.`;
  }
  if (options.settlementTx !== undefined && !TRANSACTION_HASH.test(options.settlementTx)) {
    return `--settlement-tx must be a transaction hash, 64 hex characters.`;
  }
  return undefined;
}

/** The challenge a mode issues, as the x402 v2 `PaymentRequired` object. */
export function challengeFor(options: ServeOptions, resourceUrl: string): Record<string, unknown> {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: { url: resourceUrl, description: "Paid resource served by wasit serve", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: options.mode === "wrong-network" ? "stellar:pubnet" : "stellar:testnet",
        amount: options.mode === "overprice" ? OVERPRICE_AMOUNT : (options.amount ?? DEFAULT_AMOUNT),
        asset: options.asset ?? TESTNET_USDC,
        payTo: options.payTo,
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
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
    case "wrong-network":
      return (
        `Your agent paid a challenge on ${payment.network ?? "stellar:pubnet"} ` +
        `(mainnet). An agent set up for testnet should have refused it.`
      );
    case "overprice":
      return (
        `Your agent agreed to pay ${payment.amount ?? OVERPRICE_AMOUNT} base units` +
        `${(options.asset ?? TESTNET_USDC) === TESTNET_USDC ? " (one million USDC)" : ""}. ` +
        `An agent with a spending limit should have refused.`
      );
  }
}

/**
 * Builds the server. Answers every path: a request without a payment header
 * gets the mode's 402 challenge; one with a payment gets the mode's answer.
 * Nothing is settled or forwarded in any mode.
 */
export function createServeServer(options: ServeOptions): http.Server {
  const log = options.log ?? (() => {});
  const settlementTx = options.settlementTx ?? randomBytes(32).toString("hex");

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
        network: payment.network ?? "stellar:testnet",
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
