/**
 * L1's rule on the mainnet payer's account (spec B3, B4, B17.5), written
 * before the code (B11). The caps hold one run to $5; two runs at once on one
 * account would each get their own $5. So on stellar:pubnet the payer's USDC
 * balance is read before anything is signed, and a run whose payer holds more
 * than $10, or whose balance cannot be read, does not start: with $10 or less
 * in it, the account itself is the limit. On a test network the rule does not
 * apply and nothing is read.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import { ConfigurationError } from "../../src/errors.js";
import {
  MAINNET_PAYER_MAX_BASE_UNITS,
  MAINNET_PAYER_MAX_USD,
  MainnetPayerRefusedError,
  assertMainnetPayerBalance,
} from "../../src/guard/mainnet-payer.js";
import { NETWORK_CLASSES } from "../../src/guard/networks.js";

const PUBNET = "stellar:pubnet";
const PAYER = Keypair.random().publicKey();

/** A reader that counts its calls and answers `value` (or throws it, with `throws`). */
function reader(value: unknown, options: { readonly throws?: boolean } = {}) {
  const calls = { count: 0 };
  const read = async (): Promise<bigint | undefined> => {
    calls.count += 1;
    if (options.throws === true) throw value;
    return value as bigint | undefined;
  };
  return { calls, read };
}

async function refusal(promise: Promise<unknown>): Promise<MainnetPayerRefusedError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof MainnetPayerRefusedError, `not a MainnetPayerRefusedError: ${String(error)}`);
    assert.ok(error instanceof ConfigurationError, "a payer refusal is a ConfigurationError: it says nothing about the target");
    return error;
  }
  assert.fail("the payer's balance was not refused");
}

describe("the mainnet payer's balance (L1, B17.5)", () => {
  it("is $10 at most, 100,000,000 base units of USDC at 7 decimals", () => {
    assert.equal(MAINNET_PAYER_MAX_USD, 10);
    assert.equal(MAINNET_PAYER_MAX_BASE_UNITS, 10n * 10n ** 7n);
  });

  it("is not read on a test network", async () => {
    for (const [network, kind] of NETWORK_CLASSES) {
      if (kind !== "test") continue;
      const { calls, read } = reader(10n ** 30n);
      assert.equal(await assertMainnetPayerBalance({ network, payer: PAYER, readBalance: read }), undefined, network);
      assert.equal(calls.count, 0, `${network}: the balance was read`);
    }
  });

  it("passes on stellar:pubnet at $10 or less, and returns the balance it read", async () => {
    for (const balance of [0n, 1n, 99_999_999n, MAINNET_PAYER_MAX_BASE_UNITS]) {
      const { calls, read } = reader(balance);
      assert.equal(await assertMainnetPayerBalance({ network: PUBNET, payer: PAYER, readBalance: read }), balance);
      assert.equal(calls.count, 1, "read once");
    }
  });

  it("refuses above $10, by one base unit too, naming the balance, the payer and the limit", async () => {
    const error = await refusal(
      assertMainnetPayerBalance({ network: PUBNET, payer: PAYER, readBalance: reader(MAINNET_PAYER_MAX_BASE_UNITS + 1n).read }),
    );
    assert.equal(error.reason, "above-max");
    assert.match(error.message, /\$10\.0000001/);
    assert.match(error.message, /100000001 base units/);
    assert.match(error.message, /above the \$10\.00 a mainnet payer may hold/);
    assert.ok(error.message.includes(PAYER), "the payer's address is named");
    assert.match(error.message, /Nothing was signed\./);
    assert.match(error.message, /\$5\.00/, "the message says what the cap does not bound");
  });

  it("refuses a balance far above $10", async () => {
    const error = await refusal(assertMainnetPayerBalance({ network: PUBNET, payer: PAYER, readBalance: reader(10n ** 30n).read }));
    assert.equal(error.reason, "above-max");
  });

  it("refuses when the balance cannot be read: no answer, a negative one, or not a whole number", async () => {
    for (const value of [undefined, -1n, 5, "100", null]) {
      const error = await refusal(assertMainnetPayerBalance({ network: PUBNET, payer: PAYER, readBalance: reader(value).read }));
      assert.equal(error.reason, "unreadable", String(value));
      assert.match(error.message, /could not be read on stellar:pubnet/);
      assert.match(error.message, /\$10\.00 or less/);
      assert.match(error.message, /Nothing was signed\./);
    }
  });

  it("refuses when the read throws, without echoing what it threw (an RPC URL may carry a key)", async () => {
    for (const thrown of [new Error("fetch failed: https://rpc.example.test/?apikey=sk-live-0123456789"), "sk-live-0123456789", undefined]) {
      const error = await refusal(
        assertMainnetPayerBalance({ network: PUBNET, payer: PAYER, readBalance: reader(thrown, { throws: true }).read }),
      );
      assert.equal(error.reason, "unreadable");
      assert.ok(!error.message.includes("sk-live"), "the thrown text reached the message");
      assert.ok(!error.message.includes("rpc.example.test"), "the RPC URL reached the message");
    }
  });

  it("refuses a network it has no rule for, without reading anything (fail closed)", async () => {
    for (const network of ["eip155:1", "stellar:futurenet", "", "STELLAR:PUBNET", undefined as unknown as string]) {
      const { calls, read } = reader(0n);
      const error = await refusal(assertMainnetPayerBalance({ network, payer: PAYER, readBalance: read }));
      assert.equal(error.reason, "network", String(network));
      assert.equal(calls.count, 0, `${String(network)}: the balance was read`);
      assert.match(error.message, /Nothing was signed\./);
    }
  });

  it("does not echo a payer that is not a Stellar address", async () => {
    const odd = "GXXX\u001b]0;title\u0007";
    for (const value of [MAINNET_PAYER_MAX_BASE_UNITS + 1n, undefined]) {
      const error = await refusal(assertMainnetPayerBalance({ network: PUBNET, payer: odd, readBalance: reader(value).read }));
      assert.ok(!error.message.includes("GXXX"), "an odd payer value reached the message");
      // eslint-disable-next-line no-control-regex
      assert.ok(!/[\u0000-\u001f\u007f]/.test(error.message), "a control character reached the message");
    }
  });
});
