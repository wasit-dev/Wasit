/**
 * Tests only: X402-11's stand-ins (spec B7, D-032).
 *
 * A ledger that holds what a chain would record (used nonces, transfers, the
 * payer's balance) and advances one ledger on every read; a recording chain
 * whose payloads carry a nonce and an expiration ledger, with an
 * `authorizations` watch that reads that ledger; and a paywall with the three
 * modes of B7 for a request the config declares invalid: it refuses without
 * settling, it settles and then refuses, or it serves it.
 *
 * The paywall settles a valid payment the way a facilitator would: only when
 * the signature is good, the amount is the price, the lifetime is not the
 * one-second one of X402-10 and the nonce was not used before. So X402-06
 * passes and X402-07 to X402-10 are refused, as on a conformant service.
 */

import http from "node:http";

import type { PaymentRequirements } from "@x402/core/types";

import type { AuthorizationWatch, PaymentChain, RecordedTransfer } from "../../src/x402/chains/types.js";
import { NETWORK, PAYER, USDC, recordingChain, type Recorder } from "./recording-chain.js";

export interface LedgerTransfer extends RecordedTransfer {
  readonly asset: string;
  readonly from: string;
  readonly to: string;
}

export interface FakeLedger {
  /** The latest closed ledger. Each read of the watch closes one more. */
  latest: number;
  /** nonce -> the ledger its use was recorded in. */
  readonly used: Map<string, number>;
  readonly transfers: LedgerTransfer[];
  balance: bigint;
  /** Reads of `read`, for "read before signing" assertions. */
  reads: number;
  /** Nonces the chain will not return (an RPC that answers without them). */
  readonly hidden: Set<string>;
  /** When set, `read` throws this. */
  readError?: Error;
  /** When set, `transfers` throws this. */
  transferError?: Error;
  /** When set, the payer's balance cannot be read. */
  balanceUnreadable?: boolean;
  /** Ledgers each read moves on by. Default 1. */
  step: number;
  /** A settlement marks the nonce used and lowers the balance, but records no transfer event. */
  dropTransfers?: boolean;
  /** Called on every read of the watch, with how many there have been. */
  onRead?: (reads: number) => void;
}

export function fakeLedger(start = 1000): FakeLedger {
  return { latest: start, used: new Map(), transfers: [], balance: 10_000_000n, reads: 0, hidden: new Set(), step: 1 };
}

/** What the recording chain's payload holds: enough for the paywall to judge it, and for the watch. */
export interface FakePayload {
  readonly signature: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly payer: string;
  readonly amount: string;
  readonly maxTimeoutSeconds: number;
}

/** Records a use of `payload`'s nonce at the next ledger, and the transfer it makes. */
export function settle(ledger: FakeLedger, payload: FakePayload, payTo: string): string {
  const at = ledger.latest + 1;
  const reference = `tx-${payload.nonce}`;
  ledger.used.set(payload.nonce, at);
  if (ledger.dropTransfers !== true) ledger.transfers.push({ amount: BigInt(payload.amount), reference, ledger: at, asset: USDC, from: payload.payer, to: payTo });
  ledger.balance -= BigInt(payload.amount);
  return reference;
}

export function watchOf(ledger: FakeLedger): AuthorizationWatch {
  return {
    unit: "ledger",
    unitMs: 1,
    decode(payload) {
      const nonce = payload["nonce"];
      const expiresAt = payload["expiresAt"];
      const payer = payload["payer"];
      if (typeof nonce !== "string" || typeof expiresAt !== "number" || typeof payer !== "string") {
        throw new Error("the stand-in payload carries no authorization");
      }
      return { nonce, expiresAt, payer };
    },
    async read(_network, _rpcUrl, authorizations) {
      ledger.reads += 1;
      ledger.onRead?.(ledger.reads);
      if (ledger.readError !== undefined) throw ledger.readError;
      ledger.latest += ledger.step;
      return {
        latest: ledger.latest,
        used: authorizations.map((item) => (ledger.hidden.has(item.nonce) ? undefined : ledger.used.get(item.nonce))),
      };
    },
    async transfers(_network, _rpcUrl, query) {
      if (ledger.transferError !== undefined) throw ledger.transferError;
      return {
        latest: ledger.latest,
        transfers: ledger.transfers.filter(
          (item) => item.asset === query.asset && item.from === query.from && item.to === query.to && item.ledger >= query.fromLedger,
        ),
      };
    },
  };
}

export interface LedgerChainOptions {
  /** Leave the watch out: a chain X402-11 cannot read. */
  readonly withoutWatch?: boolean;
  /** X402-06's settlement does not hold up on chain: X402-06 fails. */
  readonly settlementFails?: boolean;
}

/** The recording chain, with payloads that carry a nonce and an expiration, and a watch on `ledger`. */
export function ledgerChain(recorder: Recorder, ledger: FakeLedger, options: LedgerChainOptions = {}): PaymentChain {
  const base = recordingChain(recorder);
  let count = 0;
  return {
    ...base,
    registerPayer(client) {
      client.register(NETWORK, {
        scheme: "exact",
        findDefaultAsset: (asset, network) =>
          network === NETWORK && asset.toLowerCase() === USDC.toLowerCase() ? { asset: USDC, decimals: 6, symbol: "USDC" } : undefined,
        async createPaymentPayload(version, requirements) {
          recorder.signed.push(requirements);
          count += 1;
          // As the Stellar client does: the expiration ledger from maxTimeoutSeconds, 5 s a ledger.
          const payload: FakePayload = {
            signature: `sig-${count}`,
            nonce: `nonce-${count}`,
            expiresAt: ledger.latest + Math.ceil(requirements.maxTimeoutSeconds / 5),
            payer: PAYER,
            amount: requirements.amount,
            maxTimeoutSeconds: requirements.maxTimeoutSeconds,
          };
          return { x402Version: version, payload: { ...payload } };
        },
      });
    },
    payerBalance: async () => (ledger.balanceUnreadable === true ? undefined : ledger.balance),
    ...(options.settlementFails === true
      ? { verifySettlement: async () => ({ pass: false, detail: "the stand-in chain holds no such transfer" }) }
      : {}),
    corruptPayload: (payload) => ({ ...payload, signature: "corrupted" }),
    ...(options.withoutWatch === true ? {} : { authorizations: watchOf(ledger) }),
  };
}

/** What the paywall does with a paid request the config declares invalid. */
export type InvalidMode = "refuse" | "settle-then-refuse" | "serve";

export interface RejectPaywallOptions {
  readonly mode: InvalidMode;
  /** The header that marks the invalid request. Default `x-invalid`. */
  readonly marker?: string;
  /** Refuse the invalid request with 400 before asking for payment. */
  readonly refuseUnpaidInvalid?: boolean;
  /** Answer the paid invalid request with this status instead of 400 (refusing modes). */
  readonly refusalStatus?: number;
}

export interface RejectPaywall {
  readonly url: string;
  accepts: PaymentRequirements[];
  /** Paid invalid requests received, with what they carried. */
  readonly invalid: { method: string; headers: http.IncomingHttpHeaders; body: string }[];
  close(): Promise<void>;
}

function decodePayment(header: string): { payload: FakePayload; accepted?: PaymentRequirements } | undefined {
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf-8")) as { payload: FakePayload };
  } catch {
    return undefined;
  }
}

export async function rejectPaywall(
  ledger: FakeLedger,
  accepts: PaymentRequirements[],
  options: RejectPaywallOptions,
): Promise<RejectPaywall> {
  const marker = options.marker ?? "x-invalid";
  const state = { accepts };
  const invalid: RejectPaywall["invalid"] = [];

  const challenge = (response: http.ServerResponse, error?: string): void => {
    const body = { x402Version: 2, resource: { url: "http://127.0.0.1/paid" }, accepts: state.accepts, ...(error === undefined ? {} : { error }) };
    response.writeHead(402, {
      "content-type": "application/json",
      "payment-required": Buffer.from(JSON.stringify(body)).toString("base64"),
    });
    response.end("{}");
  };

  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf-8")));
    request.on("end", () => {
      const isInvalid = request.headers[marker] !== undefined;
      const header = request.headers["payment-signature"];
      if (typeof header !== "string") {
        if (isInvalid && options.refuseUnpaidInvalid === true) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid request" }));
          return;
        }
        challenge(response);
        return;
      }
      const decoded = decodePayment(header);
      const payload = decoded?.payload;
      const price = state.accepts[0]?.amount;
      const payTo = state.accepts[0]?.payTo ?? "";
      const valid =
        payload !== undefined &&
        payload.signature !== "corrupted" &&
        payload.amount === price &&
        payload.maxTimeoutSeconds !== 1 &&
        !ledger.used.has(payload.nonce);

      if (isInvalid) {
        invalid.push({ method: request.method ?? "", headers: request.headers, body });
        if (!valid) return challenge(response, "invalid_payment");
        if (options.mode === "refuse") {
          response.writeHead(options.refusalStatus ?? 400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid request" }));
          return;
        }
        const reference = settle(ledger, payload, payTo);
        const settled = { success: true, transaction: reference, network: NETWORK, payer: PAYER };
        if (options.mode === "settle-then-refuse") {
          response.writeHead(options.refusalStatus ?? 400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid request" }));
          return;
        }
        response.writeHead(200, {
          "content-type": "application/json",
          "payment-response": Buffer.from(JSON.stringify(settled)).toString("base64"),
        });
        response.end("{}");
        return;
      }

      if (!valid) return challenge(response, "invalid_payment");
      const reference = settle(ledger, payload, payTo);
      const settled = { success: true, transaction: reference, network: NETWORK, payer: PAYER };
      response.writeHead(200, {
        "content-type": "application/json",
        "payment-response": Buffer.from(JSON.stringify(settled)).toString("base64"),
      });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/paid`,
    get accepts() {
      return state.accepts;
    },
    set accepts(next: PaymentRequirements[]) {
      state.accepts = next;
    },
    invalid,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
