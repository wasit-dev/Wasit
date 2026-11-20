/**
 * A channel commitment is signed only when its bytes commit to the run's channel,
 * amount and network.
 *
 * The bytes come from simulating `prepare_commitment` on an RPC the caller
 * chooses (`--rpc-url`, the MCP tool's `rpcUrl`), and the contract writes the
 * network it runs on into the commitment. The check keeps the signature on the
 * network the guard allowed, whatever the RPC returns. It mirrors
 * `assertCommitmentBinds` of @stellar/mpp 0.7.1 (dist/channel/commitment.js),
 * which the package does not export.
 *
 * Offline: the bytes are built here and the RPC step is replaced. Every key is
 * random; nothing is sent anywhere.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { Keypair, Networks, StrKey, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import {
  CommitmentBindingError,
  assertCommitmentBinds,
  signChannelCommitment,
} from "../../src/mpp/channel-commitment.js";
import { ConfigurationError } from "../../src/errors.js";

const CHANNEL = StrKey.encodeContract(Buffer.alloc(32, 7));
const OTHER_CHANNEL = StrKey.encodeContract(Buffer.alloc(32, 8));
const AMOUNT = 1_000_000n;

/** The bytes `prepare_commitment` returns: an XDR ScVal map of domain, network, channel and amount. */
function commitmentBytes(fields: { domain?: string; passphrase?: string; channel?: string; amount?: bigint } = {}): Buffer {
  return nativeToScVal(
    {
      amount: fields.amount ?? AMOUNT,
      channel: fields.channel ?? CHANNEL,
      domain: fields.domain ?? "chancmmt",
      network: hash(Buffer.from(fields.passphrase ?? Networks.TESTNET)),
    },
    {
      type: {
        amount: ["symbol", "i128"],
        channel: ["symbol", "address"],
        domain: ["symbol", "symbol"],
        network: ["symbol", "bytes"],
      },
    },
  ).toXDR();
}

const EXPECTED = { channelContract: CHANNEL, amount: AMOUNT, networkPassphrase: Networks.TESTNET };

describe("assertCommitmentBinds", () => {
  it("accepts a commitment for the run's channel, amount and network", () => {
    assert.doesNotThrow(() => assertCommitmentBinds(commitmentBytes(), EXPECTED));
  });

  it("refuses a commitment for stellar:pubnet when the run is on stellar:testnet", () => {
    assert.throws(
      () => assertCommitmentBinds(commitmentBytes({ passphrase: Networks.PUBLIC }), EXPECTED),
      (error: unknown) => error instanceof CommitmentBindingError && /network/.test(error.message),
    );
  });

  it("refuses any other network, the futurenet among them", () => {
    assert.throws(() => assertCommitmentBinds(commitmentBytes({ passphrase: Networks.FUTURENET }), EXPECTED), CommitmentBindingError);
  });

  it("refuses another channel, another amount and another domain", () => {
    assert.throws(() => assertCommitmentBinds(commitmentBytes({ channel: OTHER_CHANNEL }), EXPECTED), CommitmentBindingError);
    assert.throws(() => assertCommitmentBinds(commitmentBytes({ amount: AMOUNT + 1n }), EXPECTED), CommitmentBindingError);
    assert.throws(() => assertCommitmentBinds(commitmentBytes({ amount: AMOUNT * 1000n }), EXPECTED), CommitmentBindingError);
    assert.throws(() => assertCommitmentBinds(commitmentBytes({ domain: "chanclos" }), EXPECTED), CommitmentBindingError);
  });

  it("refuses bytes that are not a commitment: garbage, an empty value, a number, a list", () => {
    for (const bytes of [
      randomBytes(48),
      Buffer.alloc(0),
      nativeToScVal(5, { type: "u32" }).toXDR(),
      nativeToScVal(["chancmmt"], { type: ["symbol"] }).toXDR(),
      xdr.ScVal.scvVoid().toXDR(),
    ]) {
      assert.throws(() => assertCommitmentBinds(bytes, EXPECTED), CommitmentBindingError);
    }
  });

  it("is a configuration error: no verdict about the target, and nothing was signed", () => {
    try {
      assertCommitmentBinds(commitmentBytes({ passphrase: Networks.PUBLIC }), EXPECTED);
      assert.fail("expected a refusal");
    } catch (error) {
      assert.ok(error instanceof ConfigurationError);
      assert.match((error as Error).message, /nothing was signed/i);
    }
  });
});

describe("signChannelCommitment refuses before it signs", () => {
  const seed = randomBytes(32).toString("hex");
  const params = { ...EXPECTED, rpcUrl: "https://rpc.invalid", commitmentSecretHex: seed };

  it("signs a commitment that binds the run's network, and the signature verifies", async () => {
    const bytes = commitmentBytes();
    const signature = await signChannelCommitment(params, { prepare: async () => bytes });
    assert.equal(signature.length, 128);
    assert.ok(Keypair.fromRawEd25519Seed(Buffer.from(seed, "hex")).verify(bytes, Buffer.from(signature, "hex")));
  });

  it("does not sign what an RPC on stellar:pubnet returned for a run on stellar:testnet", async () => {
    await assert.rejects(
      signChannelCommitment(params, { prepare: async () => commitmentBytes({ passphrase: Networks.PUBLIC }) }),
      CommitmentBindingError,
    );
  });

  it("does not sign arbitrary bytes a hostile RPC returned", async () => {
    await assert.rejects(signChannelCommitment(params, { prepare: async () => randomBytes(64) }), CommitmentBindingError);
  });

  it("hands the RPC step exactly the run's channel, amount, passphrase and RPC url, and never the key", async () => {
    let seen: Record<string, unknown> | undefined;
    await signChannelCommitment(params, {
      prepare: async (given) => {
        seen = { ...given };
        return commitmentBytes();
      },
    });
    assert.deepEqual(seen, { channelContract: CHANNEL, amount: AMOUNT, networkPassphrase: Networks.TESTNET, rpcUrl: "https://rpc.invalid" });
  });
});
