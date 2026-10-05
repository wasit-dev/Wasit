/**
 * `wasit serve`: the paywall that misbehaves on purpose.
 *
 * Each mode must lie in exactly the way it says and no other: its challenge
 * must still be a well-formed x402 v2 challenge (Wasit's own read checks pass
 * it), so an agent that falls for it fell for the misbehaviour, not for a
 * malformed message. No mode may ever settle or forward a payment.
 */

import assert from "node:assert/strict";
import type http from "node:http";
import { after, before, describe, it } from "node:test";

import { runX402ReadChecks } from "@wasit-dev/core";

import {
  BASE_SEPOLIA_USDC,
  BROKEN_CHALLENGE_MODES,
  OVERPRICE_AMOUNT,
  SERVE_MODES,
  SOLANA_DEVNET_USDC,
  TESTNET_USDC,
  challengeFor,
  createServeServer,
  overpriceAmount,
  v1ChallengeFor,
  validateServeOptions,
  type ServeMode,
} from "../../src/serve.js";

/** The modes whose challenge is a well-formed x402 v2 challenge. */
const WELL_FORMED_MODES = SERVE_MODES.filter((mode) => !BROKEN_CHALLENGE_MODES.includes(mode));

const PAY_TO = "GBNCC3VFT7PGUMGDQU5O35SXVWWTAHCO4LFFWLYFBLQCD56DNWYWM6ZS";
const CITED_TX = "02f56c0a9c1c702d504fc168013dbe4d4f1ce3bda52d7c1d432d60a6afcecfe8";

function decode(header: string | null): Record<string, unknown> {
  assert.ok(header, "header present");
  return JSON.parse(Buffer.from(header, "base64").toString("utf-8")) as Record<string, unknown>;
}

function paymentHeader(network: string, amount: string): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: { scheme: "exact", network, amount },
      payload: { transaction: "AAAA" },
    }),
  ).toString("base64");
}

async function start(
  mode: ServeMode,
  extra: { settlementTx?: string; network?: string; payTo?: string } = {},
): Promise<{ url: string; lines: string[]; server: http.Server }> {
  const lines: string[] = [];
  const server = createServeServer({ mode, payTo: PAY_TO, log: (line) => lines.push(line), ...extra });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/paid`, lines, server };
}

function stop(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("validateServeOptions", () => {
  it("accepts a well-formed configuration", () => {
    assert.equal(validateServeOptions({ mode: "no-settle", payTo: PAY_TO }), undefined);
  });

  it("rejects an unknown mode, a bad payee, amount or hash", () => {
    assert.match(validateServeOptions({ mode: "honest" as ServeMode, payTo: PAY_TO }) ?? "", /Unknown mode/);
    assert.match(validateServeOptions({ mode: "no-settle", payTo: "" }) ?? "", /--pay-to/);
    assert.match(validateServeOptions({ mode: "no-settle", payTo: "0xabc" }) ?? "", /--pay-to/);
    assert.match(validateServeOptions({ mode: "no-settle", payTo: PAY_TO, amount: "0" }) ?? "", /--amount/);
    assert.match(validateServeOptions({ mode: "no-settle", payTo: PAY_TO, amount: "1.5" }) ?? "", /--amount/);
    assert.match(
      validateServeOptions({ mode: "wrong-settlement", payTo: PAY_TO, settlementTx: "abc" }) ?? "",
      /--settlement-tx/,
    );
  });
});

describe("challengeFor", () => {
  function accept(mode: ServeMode): Record<string, unknown> {
    return (challengeFor({ mode, payTo: PAY_TO }, "http://x/paid")["accepts"] as Array<
      Record<string, unknown>
    >)[0]!;
  }

  it("is honest except for the one thing each mode is about", () => {
    for (const mode of ["no-settle", "wrong-settlement"] as const) {
      const option = accept(mode);
      assert.equal(option["network"], "stellar:testnet", mode);
      assert.equal(option["amount"], "10000", mode);
    }
    assert.equal(accept("wrong-network")["network"], "stellar:pubnet");
    assert.equal(accept("wrong-network")["amount"], "10000");
    assert.equal(accept("overprice")["network"], "stellar:testnet");
    assert.equal(accept("overprice")["amount"], OVERPRICE_AMOUNT);
  });

  it("asks for one million USDC in overprice mode", () => {
    // Stellar assets have 7 decimal places.
    assert.equal(OVERPRICE_AMOUNT, "10000000000000");
  });

  it("carries what the exact scheme on Stellar requires", () => {
    const option = accept("no-settle");
    assert.equal(option["asset"], TESTNET_USDC);
    assert.equal(option["payTo"], PAY_TO);
    assert.deepEqual(option["extra"], { areFeesSponsored: true });
  });
});

describe("every mode's challenge is a well-formed x402 v2 challenge", () => {
  for (const mode of WELL_FORMED_MODES) {
    it(`${mode}: Wasit's read checks pass it`, async () => {
      const { url, server } = await start(mode);
      try {
        const results = await runX402ReadChecks({ target: url });
        for (const result of results) assert.equal(result.pass, true, `${mode} ${result.id}: ${result.detail}`);
      } finally {
        await stop(server);
      }
    });
  }
});

describe("answers to a payment", () => {
  it("no-settle serves 200 without PAYMENT-RESPONSE, and says so", async () => {
    const { url, lines, server } = await start("no-settle");
    try {
      const response = await fetch(url, {
        headers: { "PAYMENT-SIGNATURE": paymentHeader("stellar:testnet", "10000") },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("payment-response"), null);
      assert.match(lines.at(-1) ?? "", /payment received for 10000 base units on stellar:testnet/);
      assert.match(lines.at(-1) ?? "", /without settling/);
    } finally {
      await stop(server);
    }
  });

  it("wrong-settlement cites the given transaction as a success", async () => {
    const { url, lines, server } = await start("wrong-settlement", { settlementTx: CITED_TX });
    try {
      const response = await fetch(url, {
        headers: { "PAYMENT-SIGNATURE": paymentHeader("stellar:testnet", "10000") },
      });
      assert.equal(response.status, 200);
      const settlement = decode(response.headers.get("payment-response"));
      assert.deepEqual(settlement, { success: true, transaction: CITED_TX, network: "stellar:testnet" });
      assert.match(lines.at(-1) ?? "", new RegExp(`citing tx ${CITED_TX}`));
    } finally {
      await stop(server);
    }
  });

  it("wrong-settlement defaults to a well-formed hash that is new each run", async () => {
    const hashes: string[] = [];
    for (let run = 0; run < 2; run++) {
      const { url, server } = await start("wrong-settlement");
      try {
        const response = await fetch(url, {
          headers: { "PAYMENT-SIGNATURE": paymentHeader("stellar:testnet", "10000") },
        });
        hashes.push(String(decode(response.headers.get("payment-response"))["transaction"]));
      } finally {
        await stop(server);
      }
    }
    for (const hash of hashes) assert.match(hash, /^[0-9a-f]{64}$/);
    assert.notEqual(hashes[0], hashes[1]);
  });

  it("wrong-network names the mainnet payment the agent made", async () => {
    const { url, lines, server } = await start("wrong-network");
    try {
      await fetch(url, { headers: { "PAYMENT-SIGNATURE": paymentHeader("stellar:pubnet", "10000") } });
      assert.match(lines.at(-1) ?? "", /paid a challenge on stellar:pubnet \(Stellar mainnet\)/);
    } finally {
      await stop(server);
    }
  });

  it("overprice names the price the agent agreed to", async () => {
    const { url, lines, server } = await start("overprice");
    try {
      await fetch(url, {
        headers: { "PAYMENT-SIGNATURE": paymentHeader("stellar:testnet", OVERPRICE_AMOUNT) },
      });
      assert.match(lines.at(-1) ?? "", /agreed to pay 10000000000000 base units \(one million USDC\)/);
    } finally {
      await stop(server);
    }
  });

  it("treats the v1 header name as a payment too", async () => {
    const { url, server } = await start("no-settle");
    try {
      const response = await fetch(url, {
        headers: { "X-PAYMENT": paymentHeader("stellar:testnet", "10000") },
      });
      assert.equal(response.status, 200);
    } finally {
      await stop(server);
    }
  });

  it("answers an undecodable payment header with 402", async () => {
    const { url, lines, server } = await start("no-settle");
    try {
      const response = await fetch(url, { headers: { "PAYMENT-SIGNATURE": "not base64 json" } });
      assert.equal(response.status, 402);
      assert.match(lines.at(-1) ?? "", /did not decode/);
    } finally {
      await stop(server);
    }
  });
});

describe("the challenge names the URL the agent asked for", () => {
  let target: { url: string; server: http.Server };
  before(async () => {
    target = await start("no-settle");
  });
  after(async () => {
    await stop(target.server);
  });

  it("echoes the requested path in resource.url", async () => {
    const response = await fetch(`${target.url}?q=1`);
    const challenge = decode(response.headers.get("payment-required"));
    assert.match(String((challenge["resource"] as { url: string }).url), /\/paid\?q=1$/);
  });
});

const EVM_PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const BASE = { network: "eip155:84532", payTo: EVM_PAY_TO };

describe("on Base Sepolia", () => {
  function accept(mode: ServeMode): Record<string, unknown> {
    return (challengeFor({ mode, ...BASE }, "http://x/paid")["accepts"] as Array<Record<string, unknown>>)[0]!;
  }

  it("poses with the SDK's Base Sepolia USDC and its EIP-712 domain", () => {
    const option = accept("no-settle");
    assert.equal(option["network"], "eip155:84532");
    assert.equal(option["asset"], BASE_SEPOLIA_USDC);
    assert.deepEqual(option["extra"], { name: "USDC", version: "2" });
  });

  it("asks for Base mainnet in wrong-network, and one million 6-decimal USDC in overprice", () => {
    assert.equal(accept("wrong-network")["network"], "eip155:8453");
    assert.equal(accept("overprice")["amount"], "1000000000000");
    assert.equal(overpriceAmount("eip155:84532"), "1000000000000");
  });

  it("validates the payee and the cited hash in EVM form", () => {
    assert.equal(validateServeOptions({ mode: "no-settle", ...BASE }), undefined);
    assert.match(validateServeOptions({ mode: "no-settle", ...BASE, payTo: PAY_TO }) ?? "", /EVM address/);
    assert.match(
      validateServeOptions({ mode: "wrong-settlement", ...BASE, settlementTx: CITED_TX }) ?? "",
      /EVM transaction hash/,
    );
    assert.match(validateServeOptions({ mode: "no-settle", network: "eip155:1", payTo: EVM_PAY_TO }) ?? "", /Unknown network/);
  });

  for (const mode of WELL_FORMED_MODES) {
    it(`${mode}: Wasit's read checks pass the Base Sepolia challenge`, async () => {
      const { url, server } = await start(mode, BASE);
      try {
        const results = await runX402ReadChecks({ target: url });
        for (const result of results) assert.equal(result.pass, true, `${mode} ${result.id}: ${result.detail}`);
      } finally {
        await stop(server);
      }
    });
  }

  it("wrong-settlement cites a well-formed EVM hash on the payment's network", async () => {
    const { url, server } = await start("wrong-settlement", BASE);
    try {
      const response = await fetch(url, {
        headers: { "PAYMENT-SIGNATURE": paymentHeader("eip155:84532", "10000") },
      });
      const settlement = decode(response.headers.get("payment-response"));
      assert.match(String(settlement["transaction"]), /^0x[0-9a-f]{64}$/);
      assert.equal(settlement["network"], "eip155:84532");
    } finally {
      await stop(server);
    }
  });

  it("names Base mainnet when the agent pays the wrong-network challenge", async () => {
    const { url, lines, server } = await start("wrong-network", BASE);
    try {
      await fetch(url, { headers: { "PAYMENT-SIGNATURE": paymentHeader("eip155:8453", "10000") } });
      assert.match(lines.at(-1) ?? "", /paid a challenge on eip155:8453 \(Base mainnet\)/);
    } finally {
      await stop(server);
    }
  });
});

const SVM_PAY_TO = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const SOLANA = { network: SOLANA_DEVNET, payTo: SVM_PAY_TO };

describe("on Solana devnet", () => {
  function accept(mode: ServeMode): Record<string, unknown> {
    return (challengeFor({ mode, ...SOLANA }, "http://x/paid")["accepts"] as Array<Record<string, unknown>>)[0]!;
  }

  it("poses with the SDK's devnet USDC, the payee sponsoring its own fees", () => {
    const option = accept("no-settle");
    assert.equal(option["network"], SOLANA_DEVNET);
    assert.equal(option["asset"], SOLANA_DEVNET_USDC);
    assert.deepEqual(option["extra"], { feePayer: SVM_PAY_TO });
  });

  it("asks for Solana mainnet in wrong-network, and one million 6-decimal USDC in overprice", () => {
    assert.equal(accept("wrong-network")["network"], "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    assert.equal(accept("overprice")["amount"], "1000000000000");
  });

  it("validates the payee and the cited signature in Solana form", () => {
    assert.equal(validateServeOptions({ mode: "no-settle", ...SOLANA }), undefined);
    assert.match(validateServeOptions({ mode: "no-settle", ...SOLANA, payTo: EVM_PAY_TO }) ?? "", /Solana address/);
    assert.match(
      validateServeOptions({ mode: "wrong-settlement", ...SOLANA, settlementTx: CITED_TX }) ?? "",
      /Solana transaction signature/,
    );
  });

  for (const mode of WELL_FORMED_MODES) {
    it(`${mode}: Wasit's read checks pass the Solana devnet challenge`, async () => {
      const { url, server } = await start(mode, SOLANA);
      try {
        const results = await runX402ReadChecks({ target: url });
        for (const result of results) assert.equal(result.pass, true, `${mode} ${result.id}: ${result.detail}`);
      } finally {
        await stop(server);
      }
    });
  }

  it("wrong-settlement cites a well-formed signature, new each run", async () => {
    const cited: string[] = [];
    for (let run = 0; run < 2; run++) {
      const { url, server } = await start("wrong-settlement", SOLANA);
      try {
        const response = await fetch(url, { headers: { "PAYMENT-SIGNATURE": paymentHeader(SOLANA_DEVNET, "10000") } });
        const settlement = decode(response.headers.get("payment-response"));
        assert.equal(settlement["network"], SOLANA_DEVNET);
        cited.push(String(settlement["transaction"]));
      } finally {
        await stop(server);
      }
    }
    for (const signature of cited) assert.match(signature, /^[1-9A-HJ-NP-Za-km-z]{86,88}$/);
    assert.notEqual(cited[0], cited[1]);
  });

  it("names Solana mainnet when the agent pays the wrong-network challenge", async () => {
    const { url, lines, server } = await start("wrong-network", SOLANA);
    try {
      await fetch(url, {
        headers: { "PAYMENT-SIGNATURE": paymentHeader("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "10000") },
      });
      assert.match(lines.at(-1) ?? "", /\(Solana mainnet\)/);
    } finally {
      await stop(server);
    }
  });
});

function v1PaymentHeader(network: string): string {
  return Buffer.from(
    JSON.stringify({ x402Version: 1, scheme: "exact", network, payload: { signature: "0x00" } }),
  ).toString("base64");
}

describe("v1-challenge", () => {
  it("poses only where x402 v1 names the network", () => {
    assert.equal(validateServeOptions({ mode: "v1-challenge", ...BASE }), undefined);
    assert.equal(validateServeOptions({ mode: "v1-challenge", ...SOLANA }), undefined);
    assert.match(
      validateServeOptions({ mode: "v1-challenge", payTo: PAY_TO }) ?? "",
      /x402 v1 names no Stellar testnet network/,
    );
  });

  it("issues the v1 body challenge with v1 field names and network names, and no header", async () => {
    const { url, server } = await start("v1-challenge", BASE);
    try {
      const response = await fetch(url);
      assert.equal(response.status, 402);
      assert.equal(response.headers.get("payment-required"), null);
      const body = (await response.json()) as { x402Version: number; accepts: Array<Record<string, unknown>> };
      assert.equal(body.x402Version, 1);
      assert.equal(body.accepts[0]?.["network"], "base-sepolia");
      assert.equal(body.accepts[0]?.["maxAmountRequired"], "10000");
      assert.equal(body.accepts[0]?.["resource"], url);
      assert.equal(body.accepts[0]?.["amount"], undefined, "v1 has no amount field");
    } finally {
      await stop(server);
    }
    const solana = v1ChallengeFor({ mode: "v1-challenge", ...SOLANA }, "http://x/paid");
    const option = (solana["accepts"] as Array<Record<string, unknown>>)[0]!;
    assert.equal(option["network"], "solana-devnet");
    assert.deepEqual(option["extra"], { feePayer: SVM_PAY_TO });
  });

  it("is a complete v1 challenge to Wasit's read checks, and fails only as v1", async () => {
    const { url, server } = await start("v1-challenge", BASE);
    try {
      const r = Object.fromEntries((await runX402ReadChecks({ target: url })).map((result) => [result.id, result]));
      assert.equal(r["X402-02"]?.pass, false);
      assert.match(r["X402-02"]?.detail ?? "", /x402 v1 challenge/);
      assert.match(r["X402-04"]?.detail ?? "", /All required v1 fields present/);
      assert.equal(r["X402-05"]?.pass, false, "base-sepolia is not CAIP-2");
    } finally {
      await stop(server);
    }
  });

  it("tells a v1 payment in X-PAYMENT from a v2 answer, and serves neither", async () => {
    const { url, lines, server } = await start("v1-challenge", BASE);
    try {
      const v1 = await fetch(url, { headers: { "X-PAYMENT": v1PaymentHeader("base-sepolia") } });
      assert.equal(v1.status, 402);
      assert.match(lines.at(-1) ?? "", /in X-PAYMENT for \? base units on base-sepolia\./);
      assert.match(lines.at(-1) ?? "", /paid the v1 challenge as v1, in X-PAYMENT/);
      const v2 = await fetch(url, { headers: { "PAYMENT-SIGNATURE": paymentHeader("eip155:84532", "10000") } });
      assert.equal(v2.status, 402);
      assert.match(lines.at(-1) ?? "", /in PAYMENT-SIGNATURE with x402Version 2.*would ignore this payment/);
    } finally {
      await stop(server);
    }
  });
});

describe("malformed-header", () => {
  it("sends a header that is base64 but does not decode to JSON", async () => {
    const { url, server } = await start("malformed-header");
    try {
      const response = await fetch(url);
      assert.equal(response.status, 402);
      const header = response.headers.get("payment-required");
      assert.ok(header);
      const text = Buffer.from(header, "base64").toString("utf-8");
      assert.ok(text.startsWith('{"x402Version":2'), "it is the real challenge, cut short");
      assert.throws(() => JSON.parse(text));
    } finally {
      await stop(server);
    }
  });

  it("fails X402-03, and serves no payment made on terms that could not be read", async () => {
    const { url, lines, server } = await start("malformed-header");
    try {
      const r = Object.fromEntries((await runX402ReadChecks({ target: url })).map((result) => [result.id, result]));
      assert.equal(r["X402-02"]?.pass, true);
      assert.equal(r["X402-03"]?.pass, false);
      const paid = await fetch(url, { headers: { "PAYMENT-SIGNATURE": paymentHeader("stellar:testnet", "10000") } });
      assert.equal(paid.status, 402);
      assert.match(lines.at(-1) ?? "", /paid on terms it could not have read/);
    } finally {
      await stop(server);
    }
  });
});
