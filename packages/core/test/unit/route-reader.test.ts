/**
 * What `wasit init` reads from a route (spec C2, C6, C7 row 4; W3-2 slice 3):
 * recorded answers through the same reading as a live one, the one unpaid
 * request against paywalls on 127.0.0.1 (its redirect rule, its timeout, what
 * it sends), and the choice of the one way to pay init writes. Every key and
 * address is made up; nothing leaves 127.0.0.1.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";
import { Challenge } from "mppx";

import {
  chooseOffer,
  describeOffer,
  interpretRouteAnswer,
  readRoute,
  type RouteOffer,
  type RouteReading,
} from "../../src/route-reader.js";

const TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PUBNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const CHANNEL = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const PAY_TO = Keypair.random().publicKey();

function x402Header(accepts: unknown[], version = 2): string {
  return Buffer.from(JSON.stringify({ x402Version: version, resource: { url: "http://127.0.0.1/paid" }, accepts })).toString("base64");
}

function option(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { scheme: "exact", network: "stellar:testnet", amount: "10000", asset: TESTNET_USDC, payTo: PAY_TO, maxTimeoutSeconds: 60, ...overrides };
}

function mppHeader(intent: string, request: Record<string, unknown>, method = "stellar"): string {
  return Challenge.serialize(Challenge.from({ id: `challenge-${intent}`, realm: "127.0.0.1", method, intent, request }));
}

function answer(status: number, headers: Record<string, string> = {}, body = ""): RouteReading {
  return interpretRouteAnswer({ status, headers: new Headers(headers), body, url: "http://127.0.0.1:4402/paid" });
}

function offersOf(reading: RouteReading): readonly RouteOffer[] {
  assert.equal(reading.kind, "challenge", JSON.stringify(reading));
  return reading.kind === "challenge" ? reading.offers : [];
}

describe("interpretRouteAnswer: recorded answers", () => {
  it("x402 v2: one offer per payment option, with network, price, asset and payTo", () => {
    const offers = offersOf(answer(402, { "payment-required": x402Header([option(), option({ network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" })]) }));
    assert.deepEqual(offers[0], { protocol: "x402", network: "stellar:testnet", networkNamed: true, amount: "10000", asset: TESTNET_USDC, payTo: PAY_TO });
    assert.equal(offers[1]?.network, "eip155:84532");
    assert.equal(offers.length, 2);
  });

  it("x402: the X-Payment header the read checks also accept", () => {
    assert.equal(offersOf(answer(402, { "x-payment": x402Header([option()]) })).length, 1);
  });

  it("x402: an option without a network is a note, not an offer; one without payTo is still an offer", () => {
    const reading = answer(402, { "payment-required": x402Header([{ scheme: "exact" }, option({ payTo: undefined })]) });
    const offers = offersOf(reading);
    assert.equal(offers.length, 1);
    assert.equal(offers[0]?.payTo, undefined);
    assert.ok(reading.kind === "challenge" && reading.notes[0] === "Payment option 1 of the PAYMENT-REQUIRED header names no network.");
  });

  it("x402: a header that does not decode is unreadable, and says why", () => {
    const reading = answer(402, { "payment-required": "not base64 json" });
    assert.equal(reading.kind, "unreadable");
    assert.ok(reading.kind === "unreadable" && /does not decode to JSON/.test(reading.notes[0] ?? ""));
  });

  it("x402 v1: a challenge in the body is v1", () => {
    const body = JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "stellar-testnet" }] });
    assert.deepEqual(answer(402, { "content-type": "application/json" }, body), { kind: "x402-v1", url: "http://127.0.0.1:4402/paid" });
  });

  it("MPP charge: amount, currency and recipient, and the network the challenge names", () => {
    const header = mppHeader("charge", { amount: "10000", currency: TESTNET_USDC, recipient: PAY_TO, methodDetails: { network: "stellar:testnet" } });
    assert.deepEqual(offersOf(answer(402, { "www-authenticate": header })), [
      { protocol: "mpp-charge", network: "stellar:testnet", networkNamed: true, amount: "10000", asset: TESTNET_USDC, payTo: PAY_TO },
    ]);
  });

  it("MPP: a challenge that names no network is stellar:testnet, as the Stellar MPP client reads it", () => {
    const offers = offersOf(answer(402, { "www-authenticate": mppHeader("charge", { amount: "1", currency: TESTNET_USDC, recipient: PAY_TO }) }));
    assert.equal(offers[0]?.network, "stellar:testnet");
    assert.equal(offers[0]?.networkNamed, false);
    assert.match(describeOffer(offers[0]!), /names no network; the Stellar MPP client reads that as stellar:testnet/);
  });

  it("MPP channel: the channel it names, and its price a request", () => {
    const offers = offersOf(answer(402, { "www-authenticate": mppHeader("channel", { amount: "100", channel: CHANNEL, methodDetails: { network: "stellar:testnet" } }) }));
    assert.deepEqual(offers, [{ protocol: "mpp-channel", network: "stellar:testnet", networkNamed: true, amount: "100", channel: CHANNEL }]);
  });

  it("MPP: several challenges in one header, and the ones Wasit does not test as notes", () => {
    const header = [
      mppHeader("charge", { amount: "1", currency: TESTNET_USDC, recipient: PAY_TO }),
      mppHeader("channel", { amount: "1", channel: CHANNEL }),
      mppHeader("charge", { amount: "1" }, "tempo"),
      mppHeader("session", { amount: "1" }),
      mppHeader("charge", { amount: "1", methodDetails: { network: "stellar:futurenet" } }),
      mppHeader("channel", { amount: "1" }),
    ].join(", ");
    const reading = answer(402, { "www-authenticate": header });
    assert.deepEqual(offersOf(reading).map((offer) => offer.protocol), ["mpp-charge", "mpp-channel"]);
    assert.ok(reading.kind === "challenge");
    assert.deepEqual(reading.notes, [
      'An MPP challenge for the payment method "tempo": Wasit tests MPP on Stellar only.',
      'An MPP challenge with the intent "session": Wasit tests the intents charge and channel.',
      'An MPP charge challenge names the network "stellar:futurenet": a Stellar network is stellar:testnet or stellar:pubnet.',
      "An MPP channel challenge names no channel.",
    ]);
  });

  it("MPP: a WWW-Authenticate that is not a Payment challenge is unreadable", () => {
    const reading = answer(402, { "www-authenticate": 'Bearer realm="api"' });
    assert.equal(reading.kind, "unreadable");
    assert.ok(reading.kind === "unreadable" && /not an MPP payment challenge Wasit can read/.test(reading.notes[0] ?? ""));
  });

  it("x402 and MPP on the same 402: both are offered", () => {
    const reading = answer(402, {
      "payment-required": x402Header([option()]),
      "www-authenticate": mppHeader("charge", { amount: "1", currency: TESTNET_USDC, recipient: PAY_TO }),
    });
    assert.deepEqual(offersOf(reading).map((offer) => offer.protocol), ["x402", "mpp-charge"]);
  });

  it("a 402 with nothing to read says what it looked for", () => {
    const reading = answer(402, {}, "pay me");
    assert.ok(reading.kind === "unreadable" && /no PAYMENT-REQUIRED header \(x402 v2\), no WWW-Authenticate header \(MPP\)/.test(reading.notes[0] ?? ""));
  });

  for (const status of [200, 500, 503, 404]) {
    it(`a ${status} is its status, nothing more`, () => {
      assert.deepEqual(answer(status, { "payment-required": x402Header([option()]) }), { kind: "status", url: "http://127.0.0.1:4402/paid", status });
    });
  }

  it("keeps at most ten notes", () => {
    const reading = answer(402, { "payment-required": x402Header([...Array.from({ length: 30 }, (): unknown => ({ scheme: "exact" })), option()]) });
    assert.ok(reading.kind === "challenge");
    assert.equal(reading.notes.length, 11);
    assert.equal(reading.notes[10], "... and 20 more.");
  });
});

describe("describeOffer: what init prints of the service's values", () => {
  it("prices a known dollar asset, and says the rest as given", () => {
    const [x402] = offersOf(answer(402, { "payment-required": x402Header([option()]) }));
    assert.equal(describeOffer(x402!), `x402 on stellar:testnet: price 10000 base units ($0.001 in USDC), asset ${TESTNET_USDC}, payTo ${PAY_TO}`);
    const unknown = describeOffer({ protocol: "x402", network: "stellar:testnet", networkNamed: true, amount: "5", asset: "CUNKNOWN" });
    assert.equal(unknown, "x402 on stellar:testnet: price 5 base units, asset CUNKNOWN");
  });

  it("strips control characters, keeps one line, bounds the length, and breaks no workflow command at a line start", () => {
    const hostile = option({ network: "stellar:testnet\n::error::x", payTo: `\u001b[31m${"G".repeat(200)}`, amount: "1\r\n::warning::y" });
    const [offer] = offersOf(answer(402, { "payment-required": x402Header([hostile]) }));
    const line = describeOffer(offer!);
    assert.ok(!line.includes("\n") && !line.includes("\r") && !line.includes("\u001b"), line);
    assert.ok(!line.includes("G".repeat(81)));
    assert.ok(!/^\s*::/.test(line));
  });
});

describe("chooseOffer: the one way to pay init writes", () => {
  const x402 = (network: string, more: Partial<RouteOffer> = {}): RouteOffer => ({
    protocol: "x402",
    network,
    networkNamed: true,
    amount: "10000",
    asset: network === "stellar:pubnet" ? PUBNET_USDC : TESTNET_USDC,
    payTo: PAY_TO,
    ...more,
  });
  const charge: RouteOffer = { protocol: "mpp-charge", network: "stellar:testnet", networkNamed: false, amount: "1", asset: TESTNET_USDC, payTo: PAY_TO };
  const channel = (address: string): RouteOffer => ({ protocol: "mpp-channel", network: "stellar:testnet", networkNamed: true, amount: "1", channel: address });

  it("one offer on a test network: it, with its pin", () => {
    const choice = chooseOffer([x402("stellar:testnet")]);
    assert.ok(choice.ok);
    assert.equal(choice.protocol, "x402");
    assert.equal(choice.network, "stellar:testnet");
    assert.deepEqual(choice.pin, { payTo: PAY_TO, asset: TESTNET_USDC });
  });

  it("a test network beside mainnet: the test network, the other left out", () => {
    const choice = chooseOffer([x402("stellar:pubnet"), x402("stellar:testnet")]);
    assert.ok(choice.ok);
    assert.equal(choice.network, "stellar:testnet");
    assert.deepEqual(choice.left.map((offer) => offer.network), ["stellar:pubnet"]);
  });

  it("mainnet only: not written in this version", () => {
    const choice = chooseOffer([x402("stellar:pubnet")]);
    assert.ok(!choice.ok);
    assert.match(choice.reason, /stellar:pubnet \(mainnet\).*init writes test networks only in this version/);
  });

  it("a network Wasit does not know: not written", () => {
    const choice = chooseOffer([x402("stellar:futurenet")]);
    assert.ok(!choice.ok);
    assert.match(choice.reason, /none is a test network Wasit knows \(stellar:testnet, eip155:84532/);
  });

  it("two ways to pay on test networks: it does not choose, and names the flags", () => {
    for (const offers of [[x402("stellar:testnet"), x402("eip155:84532")], [x402("stellar:testnet"), charge]]) {
      const choice = chooseOffer(offers);
      assert.ok(!choice.ok);
      assert.match(choice.reason, /more than one way to pay on a test network.*--protocol, --network or both/);
    }
  });

  it("--protocol and --network choose, and a choice the route does not offer is refused", () => {
    const offers = [x402("stellar:testnet"), x402("eip155:84532", { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }), charge];
    const byNetwork = chooseOffer(offers, { network: "eip155:84532" });
    assert.ok(byNetwork.ok && byNetwork.network === "eip155:84532" && byNetwork.protocol === "x402");
    const byProtocol = chooseOffer(offers, { protocol: "mpp-charge" });
    assert.ok(byProtocol.ok && byProtocol.protocol === "mpp-charge");
    const absent = chooseOffer(offers, { protocol: "mpp-channel" });
    assert.ok(!absent.ok);
    assert.match(absent.reason, /^The route offers x402 on stellar:testnet; x402 on eip155:84532; MPP charge on stellar:testnet, and nothing as MPP channel\./);
  });

  it("a pin only when the offers agree on one valid receiving address and asset", () => {
    const two = chooseOffer([x402("stellar:testnet"), x402("stellar:testnet", { asset: "CSECONDASSETADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" })]);
    assert.ok(two.ok && two.pin === undefined);
    assert.ok(two.ok && /more than one receiving address or asset/.test(two.noPin ?? ""));
    const missing = chooseOffer([x402("stellar:testnet", { payTo: undefined })]);
    assert.ok(missing.ok && missing.pin === undefined && /missing or is not an address/.test(missing.noPin ?? ""));
    const notAddress = chooseOffer([x402("stellar:testnet", { payTo: "G-not an address" })]);
    assert.ok(notAddress.ok && notAddress.pin === undefined);
    const secret = chooseOffer([x402("stellar:testnet", { payTo: Keypair.random().secret() })]);
    assert.ok(secret.ok && secret.pin === undefined && /shaped like a Stellar secret key/.test(secret.noPin ?? ""));
    const mppCharge = chooseOffer([charge]);
    assert.ok(mppCharge.ok && mppCharge.pin?.payTo === PAY_TO && mppCharge.pin.asset === TESTNET_USDC);
  });

  it("MPP channel: the channel, no pin; two channels or one that is not a contract are refused", () => {
    const one = chooseOffer([channel(CHANNEL)]);
    assert.ok(one.ok && one.channel === CHANNEL && one.pin === undefined && one.noPin === undefined);
    const two = chooseOffer([channel(CHANNEL), channel(TESTNET_USDC)]);
    assert.ok(!two.ok && /name 2 channels/.test(two.reason));
    const bad = chooseOffer([channel("not-a-contract")]);
    assert.ok(!bad.ok && /not a Soroban contract address/.test(bad.reason));
  });
});

describe("readRoute: the one unpaid request", () => {
  type Handler = (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void;
  interface Server {
    readonly base: string;
    readonly received: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>;
    readonly close: () => Promise<void>;
  }
  const servers: Server[] = [];

  async function serve(handler: Handler): Promise<Server> {
    const received: Server["received"] = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        received.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
        handler(request, response, body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const entry: Server = {
      base: `http://127.0.0.1:${port}`,
      received,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
    servers.push(entry);
    return entry;
  }

  after(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  it("sends the method, the body and its content type, once, and reads the challenge", async () => {
    const wall = await serve((_request, response) => {
      response.writeHead(402, { "payment-required": x402Header([option()]) });
      response.end("{}");
    });
    const reading = await readRoute(`${wall.base}/api/chat`, { method: "POST", body: '{"prompt":"hi"}' });
    assert.equal(reading.kind, "challenge");
    assert.equal(wall.received.length, 1);
    assert.equal(wall.received[0]?.method, "POST");
    assert.equal(wall.received[0]?.body, '{"prompt":"hi"}');
    assert.equal(wall.received[0]?.headers["content-type"], "application/json");
    assert.equal(wall.received[0]?.headers["payment-signature"], undefined);
    assert.equal(wall.received[0]?.headers["authorization"], undefined);
  });

  it("reads an x402 v1 body", async () => {
    const wall = await serve((_request, response) => {
      response.writeHead(402, { "content-type": "application/json" });
      response.end(JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "stellar-testnet" }] }));
    });
    assert.equal((await readRoute(`${wall.base}/paid`, {})).kind, "x402-v1");
  });

  it("follows one redirect inside the origin, and says where the answer came from", async () => {
    const wall = await serve((request, response) => {
      if (request.url === "/paid") {
        response.writeHead(307, { location: "/paid/" });
        response.end();
        return;
      }
      response.writeHead(402, { "payment-required": x402Header([option()]) });
      response.end();
    });
    const reading = await readRoute(`${wall.base}/paid`, {});
    assert.equal(reading.kind, "challenge");
    assert.ok(reading.kind === "challenge" && reading.url === `${wall.base}/paid/`);
  });

  it("never follows a redirect to another origin: nothing is sent there", async () => {
    const elsewhere = await serve((_request, response) => {
      response.writeHead(402, { "payment-required": x402Header([option()]) });
      response.end();
    });
    const wall = await serve((_request, response) => {
      response.writeHead(302, { location: `${elsewhere.base}/paid` });
      response.end();
    });
    const reading = await readRoute(`${wall.base}/paid`, {});
    assert.equal(reading.kind, "redirect");
    assert.ok(reading.kind === "redirect" && /is not the origin/.test(reading.message));
    assert.equal(elsewhere.received.length, 0);
  });

  it("refuses a redirect that would turn the POST into a GET", async () => {
    const wall = await serve((request, response) => {
      response.writeHead(303, { location: "/other" });
      response.end();
    });
    const reading = await readRoute(`${wall.base}/paid`, { method: "POST", body: "{}" });
    assert.equal(reading.kind, "redirect");
    assert.equal(wall.received.length, 1);
  });

  it("a route that does not answer in time", async () => {
    const wall = await serve(() => undefined);
    const reading = await readRoute(`${wall.base}/paid`, {}, { timeoutMs: 200 });
    assert.deepEqual(reading, { kind: "unreachable", message: "It did not answer within 0.2 s." });
  });

  it("a route nothing listens on", async () => {
    const wall = await serve(() => undefined);
    const base = wall.base;
    await wall.close();
    const reading = await readRoute(`${base}/paid`, {});
    assert.equal(reading.kind, "unreachable");
    assert.ok(reading.kind === "unreachable" && /Could not connect to .*ECONNREFUSED/.test(reading.message));
  });

  it("reads at most 64 KiB of a body", async () => {
    const wall = await serve((_request, response) => {
      response.writeHead(402, { "content-type": "application/json" });
      response.end(JSON.stringify({ x402Version: 1, accepts: [], padding: "x".repeat(200 * 1024) }));
    });
    // Cut at 64 KiB the v1 body is no longer JSON: the reading says it found nothing.
    assert.equal((await readRoute(`${wall.base}/paid`, {})).kind, "unreadable");
  });
});
