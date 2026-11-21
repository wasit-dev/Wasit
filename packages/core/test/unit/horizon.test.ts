/**
 * The two reads a mainnet run makes on public Horizon (spec B5 point 4,
 * B17.2, B17.12), written before the code (B11): the latest ledger, which the
 * RPC's anchor is held to, and the payer's balances, which the RPC's USDC
 * balance is held to. Both fail closed: anything but a plain, readable answer
 * from Stellar mainnet's Horizon is a refusal, and a redirect is not followed.
 * Offline: a loopback stand-in answers.
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { Keypair, Networks } from "@stellar/stellar-sdk";

import { ConfigurationError } from "../../src/errors.js";
import { readHorizonAccount, readHorizonLatestLedger } from "../../src/guard/horizon.js";
import { MAINNET_USDC, MainnetPlanRefusedError } from "../../src/guard/mainnet-plan.js";

const PAYER = Keypair.random().publicKey();

interface Answer {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

const seen: string[] = [];
let answer: (path: string) => Answer = () => ({ status: 500 });
let base = "";

const server = http.createServer((request, response) => {
  seen.push(request.url ?? "");
  const { status = 200, body = "", headers = {} } = answer(request.url ?? "");
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(body);
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function root(fields: Record<string, unknown>): Answer {
  return { body: JSON.stringify({ history_latest_ledger: 65_594_567, network_passphrase: Networks.PUBLIC, ...fields }) };
}

async function refused(promise: Promise<unknown>): Promise<MainnetPlanRefusedError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof MainnetPlanRefusedError, `not a MainnetPlanRefusedError: ${String(error)}`);
    assert.ok(error instanceof ConfigurationError);
    assert.equal(error.reason, "horizon", error.message);
    assert.match(error.message, /Nothing was signed\.$/);
    return error;
  }
  assert.fail("Horizon's answer was not refused");
}

describe("Horizon's latest ledger", () => {
  it("is read from the root of a Horizon that serves Stellar mainnet", async () => {
    seen.length = 0;
    answer = () => root({});
    assert.equal(await readHorizonLatestLedger(base), 65_594_567);
    assert.deepEqual(seen, ["/"]);
  });

  it("is refused from a Horizon of another network", async () => {
    answer = () => root({ network_passphrase: Networks.TESTNET });
    await refused(readHorizonLatestLedger(base));
    answer = () => root({ network_passphrase: undefined });
    await refused(readHorizonLatestLedger(base));
  });

  it("is refused when it is not a positive whole number", async () => {
    for (const history_latest_ledger of [0, -1, 1.5, "65594567", null, undefined]) {
      answer = () => root({ history_latest_ledger });
      await refused(readHorizonLatestLedger(base));
    }
  });

  it("is refused on an error status, a redirect (not followed), a body that is not JSON, or one that is too large", async () => {
    for (const bad of [
      { status: 500, body: "{}" },
      { status: 404, body: "{}" },
      { status: 301, body: "", headers: { location: `${base}/elsewhere` } },
      { status: 200, body: "not json" },
      { status: 200, body: JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024), history_latest_ledger: 1, network_passphrase: Networks.PUBLIC }) },
    ] satisfies Answer[]) {
      seen.length = 0;
      answer = () => bad;
      await refused(readHorizonLatestLedger(base));
      assert.ok(!seen.includes("/elsewhere"), "a redirect is never followed");
    }
  });

  it("is refused on any status but 200, even with a body that would read", async () => {
    for (const status of [201, 203, 206, 404, 410, 429]) {
      answer = () => ({ ...root({}), status });
      await refused(readHorizonLatestLedger(base));
    }
  });

  it("is refused when Horizon cannot be reached, and the message does not quote the URL's path", async () => {
    const error = await refused(readHorizonLatestLedger("http://127.0.0.1:1/secret-path"));
    assert.doesNotMatch(error.message, /secret-path/);
  });
});

describe("the payer's balances on Horizon", () => {
  const account = (balances: unknown[]): Answer => ({ body: JSON.stringify({ account_id: PAYER, balances }) });

  it("are read from /accounts/<payer>, USDC and XLM in base units", async () => {
    seen.length = 0;
    answer = () =>
      account([
        { balance: "9.5000000", asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: MAINNET_USDC.issuer },
        { balance: "3.0000000", asset_type: "native" },
      ]);
    assert.deepEqual(await readHorizonAccount(base, PAYER), { usdc: 95_000_000n, native: 30_000_000n });
    assert.deepEqual(seen, [`/accounts/${PAYER}`]);
  });

  it("are not asked for an address that is not a Stellar account", async () => {
    seen.length = 0;
    for (const payer of ["", "../ledgers", `${PAYER}?x=1`, PAYER.toLowerCase(), MAINNET_USDC.asset]) {
      await refused(readHorizonAccount(base, payer));
    }
    assert.deepEqual(seen, []);
  });

  it("are refused for an account Horizon does not have, or an answer that cannot be read", async () => {
    for (const bad of [
      { status: 404, body: JSON.stringify({ status: 404 }) },
      account([]),
      account([{ balance: "x", asset_type: "native" }]),
      { status: 200, body: JSON.stringify({ account_id: Keypair.random().publicKey(), balances: [{ balance: "1.0000000", asset_type: "native" }] }) },
    ] satisfies Answer[]) {
      answer = () => bad;
      await refused(readHorizonAccount(base, PAYER));
    }
  });
});
