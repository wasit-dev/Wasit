import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Account, Asset, Keypair, Networks, type Transaction } from "@stellar/stellar-sdk";

import {
  TESTNET_SWAP_XLM,
  TESTNET_USDC_ISSUER,
  addTestnetUsdc,
  describeTransactionError,
  generateCommitmentKey,
  generateTestnetWallet,
  publicKeyFromSecret,
  sendUsdcFromDistributor,
  swapQuoteFrom,
  testnetUsdcAsset,
  usdcSetupTransaction,
  type SwapPathRecord,
} from "../../src/wallet.js";
import { ConfigurationError } from "../../src/errors.js";

// Only the local, network-free surface is covered here — Friendbot, Horizon
// lookups and trustline/payment submission all need a real testnet, same
// "no keys, no target, no network" rule the rest of this suite follows.

describe("generateTestnetWallet", () => {
  it("returns a keypair whose public key matches its own secret", () => {
    const wallet = generateTestnetWallet();
    assert.equal(Keypair.fromSecret(wallet.secretKey).publicKey(), wallet.publicKey);
  });

  it("never repeats a keypair across calls", () => {
    const first = generateTestnetWallet();
    const second = generateTestnetWallet();
    assert.notEqual(first.secretKey, second.secretKey);
  });
});

describe("publicKeyFromSecret", () => {
  it("derives the same public key generateTestnetWallet already returned", () => {
    const wallet = generateTestnetWallet();
    assert.equal(publicKeyFromSecret(wallet.secretKey), wallet.publicKey);
  });
});

describe("generateCommitmentKey", () => {
  it("returns a 64-character hex seed and a matching hex public key", () => {
    const key = generateCommitmentKey();
    assert.match(key.secretHex, /^[0-9a-f]{64}$/);
    assert.match(key.publicKeyHex, /^[0-9a-f]{64}$/);
  });

  it("never repeats a seed across calls", () => {
    const first = generateCommitmentKey();
    const second = generateCommitmentKey();
    assert.notEqual(first.secretHex, second.secretHex);
  });
});

describe("testnetUsdcAsset", () => {
  it("is Circle's documented testnet USDC issuer, not a pubnet address", () => {
    const asset = testnetUsdcAsset();
    assert.ok(asset.equals(new Asset("USDC", TESTNET_USDC_ISSUER)));
  });
});

describe("describeTransactionError", () => {
  it("falls back to the plain message for a non-Horizon error", () => {
    assert.equal(describeTransactionError(new Error("boom")), "boom");
  });

  it("stringifies a thrown non-Error value", () => {
    assert.equal(describeTransactionError("not an Error object"), "not an Error object");
  });
});

describe("publicKeyFromSecret on a malformed key", () => {
  // The three ways a .env key is actually wrong in practice: a truncated
  // paste, a public key in a secret's slot, and a raw hex commitment seed
  // in a role that wants a Stellar S... string.
  const BAD_SECRETS = [
    "SBROKEN",
    generateTestnetWallet().publicKey,
    generateCommitmentKey().secretHex,
  ];

  it("throws a ConfigurationError rather than the SDK's raw error", () => {
    for (const bad of BAD_SECRETS) {
      assert.throws(() => publicKeyFromSecret(bad), ConfigurationError);
    }
  });

  it("names the variable to fix when one is given", () => {
    assert.throws(
      () => publicKeyFromSecret("SBROKEN", "MPP_PAYER_SECRET"),
      (error: unknown) =>
        error instanceof ConfigurationError && error.message.includes("MPP_PAYER_SECRET"),
    );
  });

  it("never puts the rejected value in the message", () => {
    // This message reaches logs, saved JSON runs and terminal recordings, so
    // echoing the input back would turn a typo into a disclosure whenever
    // the value was a real key that merely failed validation.
    for (const bad of BAD_SECRETS) {
      assert.throws(
        () => publicKeyFromSecret(bad, "MPP_PAYER_SECRET"),
        (error: unknown) => error instanceof Error && !error.message.includes(bad),
      );
    }
  });
});

describe("sendUsdcFromDistributor argument validation", () => {
  const distributor = generateTestnetWallet();
  const destination = generateTestnetWallet().publicKey;

  it("rejects a malformed distributor key before touching the network", async () => {
    await assert.rejects(
      () => sendUsdcFromDistributor("SBROKEN", destination, "50"),
      ConfigurationError,
    );
  });

  it("rejects an unusable amount before touching the network", async () => {
    for (const amount of ["", "0", "-5", "abc", "1.12345678"]) {
      await assert.rejects(
        () => sendUsdcFromDistributor(distributor.secretKey, destination, amount),
        ConfigurationError,
        `expected "${amount}" to be rejected`,
      );
    }
  });
});

/** A strict-send path to testnet USDC as Horizon writes it. */
function usdcPath(destinationAmount: string, path: SwapPathRecord["path"] = []): SwapPathRecord {
  return {
    destination_amount: destinationAmount,
    destination_asset_type: "credit_alphanum4",
    destination_asset_code: "USDC",
    destination_asset_issuer: TESTNET_USDC_ISSUER,
    path,
  };
}

describe("swapQuoteFrom (the exchange's answer is not trusted)", () => {
  it("takes the path that gives the most USDC, and accepts no less than 80% of it, rounded down", () => {
    const quote = swapQuoteFrom([usdcPath("8.8000000"), usdcPath("9.1234567"), usdcPath("2.5")]);
    assert.equal(quote?.destMin, "7.2987653");
    assert.deepEqual(quote?.path, []);
  });

  it("keeps the path's own assets in order", () => {
    const other = Keypair.random().publicKey();
    const quote = swapQuoteFrom([
      usdcPath("5", [
        { asset_type: "credit_alphanum4", asset_code: "EURC", asset_issuer: other },
        { asset_type: "native" },
      ]),
    ]);
    assert.ok(quote?.path[0]?.equals(new Asset("EURC", other)));
    assert.ok(quote?.path[1]?.isNative());
    assert.equal(quote?.destMin, "4.0000000");
  });

  it("under one USDC is no usable price", () => {
    assert.equal(swapQuoteFrom([usdcPath("0.9999999")]), undefined);
    assert.equal(swapQuoteFrom([usdcPath("1")])?.destMin, "0.8000000");
    assert.equal(swapQuoteFrom([]), undefined);
  });

  it("ignores a path to another asset, another issuer, a bad amount or an asset that does not parse", () => {
    const fake = Keypair.random().publicKey();
    const records: SwapPathRecord[] = [
      { ...usdcPath("50"), destination_asset_issuer: fake },
      { ...usdcPath("50"), destination_asset_code: "USDT" },
      { ...usdcPath("50"), destination_asset_type: "native" },
      usdcPath("1e9"),
      usdcPath("-5"),
      usdcPath("5.12345678"),
      { ...usdcPath("50"), destination_amount: 50 },
      usdcPath("50", [{ asset_type: "credit_alphanum4", asset_code: "BAD CODE", asset_issuer: "nope" }]),
      { ...usdcPath("50"), path: "not a list" },
    ];
    assert.equal(swapQuoteFrom(records), undefined);
    assert.equal(swapQuoteFrom([...records, usdcPath("3")])?.destMin, "2.4000000");
  });
});

describe("usdcSetupTransaction (built and signed, never sent)", () => {
  const keypair = Keypair.random();
  const account = (): Account => new Account(keypair.publicKey(), "100");

  function operations(transaction: Transaction): Array<Record<string, unknown>> {
    return transaction.operations as unknown as Array<Record<string, unknown>>;
  }

  it("with a quote: the trustline and the swap to the account itself, in one transaction on testnet", () => {
    const transaction = usdcSetupTransaction(account(), keypair, { destMin: "7.0400000", path: [] });
    assert.equal(transaction.networkPassphrase, Networks.TESTNET);
    assert.equal(transaction.source, keypair.publicKey());
    const [trust, swap, ...rest] = operations(transaction);
    assert.deepEqual(rest, []);
    assert.equal(trust?.["type"], "changeTrust");
    assert.ok((trust?.["line"] as Asset).equals(testnetUsdcAsset()));
    assert.equal(swap?.["type"], "pathPaymentStrictSend");
    assert.ok((swap?.["sendAsset"] as Asset).isNative());
    assert.equal(swap?.["sendAmount"], "10.0000000");
    assert.equal(TESTNET_SWAP_XLM, "10");
    assert.equal(swap?.["destination"], keypair.publicKey());
    assert.ok((swap?.["destAsset"] as Asset).equals(testnetUsdcAsset()));
    assert.equal(swap?.["destMin"], "7.0400000");
    assert.equal(transaction.signatures.length, 1);
    assert.ok(keypair.verify(transaction.hash(), transaction.signatures[0]!.signature()));
  });

  it("without a quote: the trustline alone", () => {
    const transaction = usdcSetupTransaction(account(), keypair, undefined);
    assert.deepEqual(
      operations(transaction).map((operation) => operation["type"]),
      ["changeTrust"],
    );
  });
});

describe("addTestnetUsdc argument validation", () => {
  it("rejects a malformed key before touching the network, without echoing it", async () => {
    await assert.rejects(
      () => addTestnetUsdc("SBROKENKEY", "STELLAR_PRIVATE_KEY"),
      (error: unknown) => error instanceof ConfigurationError && /STELLAR_PRIVATE_KEY/.test(error.message) && !error.message.includes("SBROKENKEY"),
    );
  });
});
