/**
 * What `wasit init` reads from a route (spec C2, C7 row 4; W3-2 slice 3).
 *
 * One unpaid request with the method and body the route takes: no payment,
 * no signature, no key. A redirect is followed once inside the origin, and
 * only when it keeps the request, the rule of the unpaid request a payment
 * check reads (`fetchPaymentChallenge`, spec A8 row 5); any other redirect is
 * reported and nothing is sent to its Location. The answer is data: read,
 * never followed or run (rule 3). What a message takes from it passes through
 * the sanitiser (A8 row 6), on one line and bounded; what the config takes
 * from it is held to the config's own rules before it is written.
 *
 * Reading. A `PAYMENT-REQUIRED` header (or `X-Payment`, which the read checks
 * also accept) is x402, one offer per payment option. A `WWW-Authenticate`
 * header with `Payment` challenges is MPP: the intent tells charge from
 * channel, and a channel challenge names its channel. MPP's network is read
 * the way the Stellar MPP client reads it, so a challenge that names none is
 * stellar:testnet (`@stellar/mpp` 0.7.1 `resolveNetworkId`,
 * dist/shared/validation.js; the charge and the channel client both call it).
 * An x402 v1 challenge in the body is reported as v1.
 *
 * Choosing. init writes one protocol on one network per route, and only what
 * is certain (Najmi, 2026-11-15): with several ways to pay on test networks
 * and no flag to choose, it does not choose; a network that is mainnet or
 * that Wasit does not know is not written in this version.
 */

import { StrKey } from "@stellar/stellar-sdk";
import { Challenge } from "mppx";

import type { PinConfig } from "./config.js";
import { RedirectRefusedError, TargetUnreachableError, fetchPaymentChallenge } from "./errors.js";
import { RunBudget, formatUsd, shown, usdAsset } from "./guard/budget.js";
import { NETWORK_CLASSES, networkClass } from "./guard/networks.js";
import { isMppNetwork } from "./mpp/network.js";
import { sanitizeText } from "./sanitize.js";
import { acceptsOf } from "./x402/requirements.js";
import { buildInit, readV1BodyChallenge, type RequestShape } from "./x402/simulator.js";

/** How long init waits for the route's answer. */
export const ROUTE_READ_TIMEOUT_MS = 15_000;

/** The most of a body init reads: enough for an x402 v1 challenge. */
const BODY_LIMIT_BYTES = 64 * 1024;

/** The most notes a reading keeps: a hostile header cannot flood the terminal. */
const MAX_NOTES = 10;

/** The loader's rule for a pinned address (config.ts, ADDRESS). */
const PIN_ADDRESS = /^[A-Za-z0-9]{20,128}$/;

/** The loader refuses a file with a value of this shape anywhere (config.ts, STELLAR_SECRET). */
const STELLAR_SECRET_SHAPE = /S[A-Z2-7]{55}/;

export type RouteProtocol = "x402" | "mpp-charge" | "mpp-channel";

/** One way the route asks to be paid, as its challenge writes it. Every value is the service's: not trusted. */
export interface RouteOffer {
  readonly protocol: RouteProtocol;
  /** A CAIP-2 id, as the challenge names it; MPP: as the Stellar MPP client reads it. */
  readonly network: string;
  /** False for an MPP challenge that names no network (read as stellar:testnet). */
  readonly networkNamed: boolean;
  /** The price in base units. */
  readonly amount?: string;
  /** x402 `asset`; MPP charge `currency`. */
  readonly asset?: string;
  /** x402 `payTo`; MPP charge `recipient`. */
  readonly payTo?: string;
  /** MPP channel: the channel contract it bills through. */
  readonly channel?: string;
}

/** What the route answered. `url` is where the answer came from: the route's own URL, or the one redirect inside its origin. */
export type RouteReading =
  | { readonly kind: "challenge"; readonly url: string; readonly offers: readonly RouteOffer[]; readonly notes: readonly string[] }
  | { readonly kind: "x402-v1"; readonly url: string }
  | { readonly kind: "unreadable"; readonly url: string; readonly notes: readonly string[] }
  | { readonly kind: "status"; readonly url: string; readonly status: number }
  | { readonly kind: "unreachable"; readonly message: string }
  | { readonly kind: "redirect"; readonly message: string };

/** The answer as received, for {@link interpretRouteAnswer}. */
export interface RouteAnswer {
  readonly status: number;
  readonly headers: Headers;
  /** The body, read only for a 402 without a payment header; otherwise "". */
  readonly body: string;
  readonly url: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A value of the service's for a line of output: sanitised, one line, bounded, unquoted. */
function brief(value: unknown): string {
  const line = sanitizeText(String(value)).replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** A message for a line of output: sanitised and on one line, not cut. */
function oneLine(message: string): string {
  return sanitizeText(message).replace(/\s+/g, " ").trim();
}

function capped(notes: readonly string[]): readonly string[] {
  return notes.length <= MAX_NOTES ? notes : [...notes.slice(0, MAX_NOTES), `... and ${notes.length - MAX_NOTES} more.`];
}

function offerFields(fields: Record<"amount" | "asset" | "payTo" | "channel", unknown>): Partial<RouteOffer> {
  const out: { amount?: string; asset?: string; payTo?: string; channel?: string } = {};
  for (const key of ["amount", "asset", "payTo", "channel"] as const) {
    const value = text(fields[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function x402Offers(header: string, notes: string[]): RouteOffer[] {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
  } catch {
    notes.push("The PAYMENT-REQUIRED header does not decode to JSON: x402 v2 sends the base64 of a JSON object.");
    return [];
  }
  const accepts = acceptsOf(payload);
  if (accepts === undefined || accepts.length === 0) {
    notes.push("The PAYMENT-REQUIRED header lists no payment options (accepts).");
    return [];
  }
  const offers: RouteOffer[] = [];
  accepts.forEach((option, index) => {
    const network = text(option?.["network"]);
    if (network === undefined) {
      notes.push(`Payment option ${index + 1} of the PAYMENT-REQUIRED header names no network.`);
      return;
    }
    offers.push({
      protocol: "x402",
      network,
      networkNamed: true,
      ...offerFields({ amount: option?.["amount"], asset: option?.["asset"], payTo: option?.["payTo"], channel: undefined }),
    });
  });
  return offers;
}

function mppOffers(header: string, notes: string[]): RouteOffer[] {
  let challenges: ReturnType<typeof Challenge.deserializeList>;
  try {
    challenges = Challenge.deserializeList(header);
  } catch (error) {
    notes.push(`The WWW-Authenticate header is not an MPP payment challenge Wasit can read (${brief((error as Error).message)}).`);
    return [];
  }
  const offers: RouteOffer[] = [];
  for (const challenge of challenges) {
    if (challenge.method !== "stellar") {
      notes.push(`An MPP challenge for the payment method ${shown(challenge.method)}: Wasit tests MPP on Stellar only.`);
      continue;
    }
    const request = asRecord(challenge.request) ?? {};
    const named = asRecord(request["methodDetails"])?.["network"];
    let network: string;
    if (named === undefined || named === null) network = "stellar:testnet";
    else if (typeof named === "string" && isMppNetwork(named)) network = named;
    else {
      notes.push(
        `An MPP ${brief(challenge.intent)} challenge names the network ${shown(named)}: a Stellar network is ` +
          "stellar:testnet or stellar:pubnet.",
      );
      continue;
    }
    const networkNamed = named !== undefined && named !== null;
    if (challenge.intent === "charge") {
      offers.push({
        protocol: "mpp-charge",
        network,
        networkNamed,
        ...offerFields({ amount: request["amount"], asset: request["currency"], payTo: request["recipient"], channel: undefined }),
      });
    } else if (challenge.intent === "channel") {
      const fields = offerFields({ amount: request["amount"], asset: undefined, payTo: undefined, channel: request["channel"] });
      if (fields.channel === undefined) {
        notes.push("An MPP channel challenge names no channel.");
        continue;
      }
      offers.push({ protocol: "mpp-channel", network, networkNamed, ...fields });
    } else {
      notes.push(`An MPP challenge with the intent ${shown(challenge.intent)}: Wasit tests the intents charge and channel.`);
    }
  }
  return offers;
}

/**
 * What an answer says, without a network: the recorded answers of the tests
 * go through the same reading as a live one.
 */
export function interpretRouteAnswer(answer: RouteAnswer): RouteReading {
  const { status, headers, body, url } = answer;
  if (status !== 402) return { kind: "status", url, status };

  const notes: string[] = [];
  const offers: RouteOffer[] = [];
  const x402 = headers.get("PAYMENT-REQUIRED") ?? headers.get("X-Payment");
  const mpp = headers.get("WWW-Authenticate");
  if (x402 !== null) offers.push(...x402Offers(x402, notes));
  if (mpp !== null) offers.push(...mppOffers(mpp, notes));
  if (offers.length > 0) return { kind: "challenge", url, offers, notes: capped(notes) };

  if (x402 === null && mpp === null) {
    if (readV1BodyChallenge(body) !== undefined) return { kind: "x402-v1", url };
    notes.push(
      "The 402 carries no PAYMENT-REQUIRED header (x402 v2), no WWW-Authenticate header (MPP) and no x402 v1 challenge in its body.",
    );
  }
  return { kind: "unreadable", url, notes: capped(notes) };
}

/** Reads at most `limit` bytes of a body, then lets the rest go. */
async function readBounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    // What was read is the body.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, limit).toString("utf-8");
}

export interface ReadRouteOptions {
  /** Default {@link ROUTE_READ_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Sends the route one unpaid request and reads its answer.
 *
 * @throws {ConfigurationError} For a URL or a request shape that cannot be sent (checked before anything is sent).
 */
export async function readRoute(url: string, shape: RequestShape, options: ReadRouteOptions = {}): Promise<RouteReading> {
  const timeoutMs = options.timeoutMs ?? ROUTE_READ_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const init: RequestInit = { ...buildInit(shape), signal };
  let answer: Awaited<ReturnType<typeof fetchPaymentChallenge>>;
  try {
    answer = await fetchPaymentChallenge(url, init);
  } catch (error) {
    // Wasit's own messages, which name the origins already sanitised: one line, not cut.
    if (error instanceof RedirectRefusedError) return { kind: "redirect", message: oneLine(error.message) };
    if (error instanceof TargetUnreachableError) {
      return {
        kind: "unreachable",
        message: signal.aborted ? `It did not answer within ${timeoutMs / 1000} s.` : oneLine(error.message),
      };
    }
    throw error;
  }
  const { response } = answer;
  const plain =
    response.status === 402 &&
    !response.headers.has("PAYMENT-REQUIRED") &&
    !response.headers.has("X-Payment") &&
    !response.headers.has("WWW-Authenticate");
  let body = "";
  if (plain) body = await readBounded(response, BODY_LIMIT_BYTES);
  else await response.body?.cancel().catch(() => undefined);
  return interpretRouteAnswer({ status: response.status, headers: response.headers, body, url: answer.url });
}

function testNetworks(): string {
  return [...NETWORK_CLASSES]
    .filter(([, kind]) => kind === "test")
    .map(([network]) => network)
    .join(", ");
}

const PROTOCOL_LABEL: Readonly<Record<RouteProtocol, string>> = {
  x402: "x402",
  "mpp-charge": "MPP charge",
  "mpp-channel": "MPP channel",
};

/** One offer for a line of output. Sanitised. */
export function describeOffer(offer: RouteOffer): string {
  const parts: string[] = [];
  if (offer.amount !== undefined) {
    const valued =
      /^\d{1,78}$/.test(offer.amount) && offer.asset !== undefined
        ? RunBudget.valueOf(offer.network, offer.asset, BigInt(offer.amount))
        : undefined;
    const symbol = offer.asset === undefined ? undefined : usdAsset(offer.network, offer.asset)?.symbol;
    parts.push(
      `price ${brief(offer.amount)} base units${offer.protocol === "mpp-channel" ? " a request" : ""}` +
        (valued !== undefined && symbol !== undefined ? ` (${formatUsd(valued)} in ${symbol})` : ""),
    );
  }
  if (offer.asset !== undefined) parts.push(`${offer.protocol === "x402" ? "asset" : "currency"} ${brief(offer.asset)}`);
  if (offer.payTo !== undefined) parts.push(`${offer.protocol === "x402" ? "payTo" : "recipient"} ${brief(offer.payTo)}`);
  if (offer.channel !== undefined) parts.push(`channel ${brief(offer.channel)}`);
  const where = `${PROTOCOL_LABEL[offer.protocol]} on ${brief(offer.network)}${
    offer.networkNamed ? "" : " (the challenge names no network; the Stellar MPP client reads that as stellar:testnet)"
  }`;
  return parts.length === 0 ? where : `${where}: ${parts.join(", ")}`;
}

/** What init may choose: a protocol, a network, or both (`--protocol`, `--network`). */
export interface OfferWanted {
  readonly protocol?: RouteProtocol;
  readonly network?: string;
}

export type OfferChoice =
  | {
      readonly ok: true;
      readonly protocol: RouteProtocol;
      readonly network: string;
      /** The offers of that protocol on that network. */
      readonly offers: readonly RouteOffer[];
      /** The other offers, not written. */
      readonly left: readonly RouteOffer[];
      /** x402 and MPP charge: the receiving address and asset, when the offers agree on one of each. */
      readonly pin?: PinConfig;
      /** Why there is no pin, when there could have been one. */
      readonly noPin?: string;
      /** MPP channel: the channel contract. */
      readonly channel?: string;
    }
  | { readonly ok: false; readonly reason: string };

function way(offer: RouteOffer): string {
  return `${PROTOCOL_LABEL[offer.protocol]} on ${brief(offer.network)}`;
}

function ways(offers: readonly RouteOffer[]): string[] {
  return [...new Set(offers.map(way))];
}

function wantedText(wanted: OfferWanted): string {
  return [
    ...(wanted.protocol === undefined ? [] : [PROTOCOL_LABEL[wanted.protocol]]),
    ...(wanted.network === undefined ? [] : [`on ${brief(wanted.network)}`]),
  ].join(" ");
}

/**
 * The one way to pay init writes for this route, or why it writes none.
 * Pure: the same offers and flags always give the same answer.
 */
export function chooseOffer(offers: readonly RouteOffer[], wanted: OfferWanted = {}): OfferChoice {
  const matching = offers.filter(
    (offer) =>
      (wanted.protocol === undefined || offer.protocol === wanted.protocol) &&
      (wanted.network === undefined || offer.network === wanted.network),
  );
  if (matching.length === 0) {
    return {
      ok: false,
      reason: `The route offers ${ways(offers).join("; ")}, and nothing as ${wantedText(wanted)}. Name one of those, or leave the flag out.`,
    };
  }

  const onTest = matching.filter((offer) => networkClass(offer.network) === "test");
  const testWays = ways(onTest);
  if (testWays.length > 1) {
    return {
      ok: false,
      reason:
        `The route offers more than one way to pay on a test network: ${testWays.join("; ")}. init writes one per ` +
        "route and does not choose: name it with --protocol, --network or both.",
    };
  }
  if (testWays.length === 0) {
    const mainnet = matching.every((offer) => networkClass(offer.network) === "mainnet-optin");
    return {
      ok: false,
      reason: mainnet
        ? `The route asks to be paid on stellar:pubnet (mainnet): ${ways(matching).join("; ")}. init writes test networks only in this version.`
        : `The route asks to be paid on ${ways(matching).join("; ")}, and none is a test network Wasit knows (${testNetworks()}).`,
    };
  }

  const first = onTest[0]!;
  const chosen = onTest.filter((offer) => offer.protocol === first.protocol && offer.network === first.network);
  const left = offers.filter((offer) => !chosen.includes(offer));
  const base = { ok: true as const, protocol: first.protocol, network: first.network, offers: chosen, left };

  if (first.protocol === "mpp-channel") {
    const channels = [...new Set(chosen.map((offer) => offer.channel ?? ""))];
    if (channels.length > 1) {
      return {
        ok: false,
        reason: `The route's channel challenges name ${channels.length} channels (${channels.map(brief).join(", ")}): init cannot tell which one it bills through.`,
      };
    }
    const channel = channels[0]!;
    if (!StrKey.isValidContract(channel)) {
      return { ok: false, reason: `The channel challenge names the channel ${shown(channel)}, which is not a Soroban contract address (C...).` };
    }
    return { ...base, channel };
  }

  const payTos = [...new Set(chosen.map((offer) => offer.payTo))];
  const assets = [...new Set(chosen.map((offer) => offer.asset))];
  const payTo = payTos[0];
  const asset = assets[0];
  if (payTos.length > 1 || assets.length > 1) {
    return { ...base, noPin: `the route offers more than one receiving address or asset on ${brief(first.network)}` };
  }
  if (payTo === undefined || asset === undefined || !PIN_ADDRESS.test(payTo) || !PIN_ADDRESS.test(asset)) {
    return { ...base, noPin: "the challenge's receiving address or asset is missing or is not an address" };
  }
  if (STELLAR_SECRET_SHAPE.test(payTo) || STELLAR_SECRET_SHAPE.test(asset)) {
    return {
      ...base,
      noPin:
        "the challenge's receiving address or asset is shaped like a Stellar secret key, so init does not write it " +
        "(if it is a real key, the service is giving it away: rotate it)",
    };
  }
  return { ...base, pin: { payTo, asset } };
}
