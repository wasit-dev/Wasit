/**
 * The Solana adapter: X402-06 and X402-07 on Solana devnet, offline.
 *
 * Settlement is held to the confirmed transaction's token balances by the
 * same rules the other adapters apply to the token's transfer record; X402-07
 * forges only the payer's signature in the partially signed transaction.
 * Spec: `scheme_exact_svm.md` (DECISIONS.md, Verified facts, 2026-10-05).
 * Transactions here are built, not fetched.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";

import { CheckSetupError, ConfigurationError } from "../../src/errors.js";
import { paymentChainFor } from "../../src/x402/chains/index.js";
import {
  corruptSvmSignature,
  svmChain,
  verifySvmTransaction,
  type SvmTokenBalance,
  type SvmTransaction,
} from "../../src/x402/chains/svm.js";

const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PAYER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const PAY_TO = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";
const OTHER = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";
const FEE_PAYER = "BENGEso6uSrcCYyRsanYgmDwLi34QSpihU2FX2xvpN5Q";
const TX =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const EXPECTED = { amount: 10000n, token: USDC, recipient: PAY_TO, payer: PAYER };

/** A fresh Solana keypair as wallets export it: base58 of seed then public key. */
function keypair(): { secret: string; publicKey: string; bytes: Uint8Array } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const seed = Buffer.from(jwk.d!, "base64url");
  const pub = Buffer.from(jwk.x!, "base64url");
  const bytes = new Uint8Array(Buffer.concat([seed, pub]));
  const b58 = getBase58Decoder();
  return { secret: b58.decode(bytes), publicKey: b58.decode(pub), bytes };
}

function balance(accountIndex: number, owner: string | undefined, amount: bigint, mint = USDC): SvmTokenBalance {
  return { accountIndex, mint, ...(owner === undefined ? {} : { owner }), uiTokenAmount: { amount: String(amount) } };
}

/** A confirmed payment: the payer's account (1) to the payee's (2). */
function payment(
  overrides: { pre?: SvmTokenBalance[]; post?: SvmTokenBalance[]; err?: unknown } = {},
): SvmTransaction {
  return {
    meta: {
      err: overrides.err ?? null,
      preTokenBalances: overrides.pre ?? [balance(1, PAYER, 20_000_000n), balance(2, PAY_TO, 5_000_000n)],
      postTokenBalances: overrides.post ?? [balance(1, PAYER, 19_990_000n), balance(2, PAY_TO, 5_010_000n)],
    },
  };
}

describe("the Solana adapter", () => {
  it("pays on Solana devnet, through the SDK's devnet RPC unless told otherwise", () => {
    assert.equal(paymentChainFor(DEVNET), svmChain);
    assert.equal(svmChain.resolveRpcUrl(DEVNET), "https://api.devnet.solana.com");
    assert.equal(svmChain.resolveRpcUrl(DEVNET, "http://127.0.0.1:8899"), "http://127.0.0.1:8899");
    assert.throws(() => svmChain.resolveRpcUrl("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), ConfigurationError);
    assert.equal(paymentChainFor("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), undefined);
  });

  it("takes a settlement reference only in the shape of a transaction signature", () => {
    assert.equal(svmChain.isSettlementReference(TX), true);
    assert.equal(
      svmChain.isSettlementReference("0xb182df33ee676ac15ec9137717027a61432fc24af4761d9fa89fddb23cbf7e91"),
      false,
    );
    assert.equal(svmChain.isSettlementReference(PAY_TO), false);
  });
});

describe("the Solana payer key", () => {
  it("reads the payer's address from a wallet-exported keypair", async () => {
    const key = keypair();
    assert.equal(svmChain.payerAddress(key.secret), key.publicKey);
    assert.equal((await createKeyPairSignerFromBytes(key.bytes)).address, key.publicKey);
  });

  it("refuses a keypair whose public half is not its seed's, without echoing it", () => {
    const one = keypair();
    const two = keypair();
    const spliced = getBase58Decoder().decode(new Uint8Array([...one.bytes.subarray(0, 32), ...two.bytes.subarray(32)]));
    for (const bad of [spliced, one.secret.slice(0, -4), "3yZe7d", "0x" + "ab".repeat(32), "not base58 0OIl"]) {
      assert.throws(
        () => svmChain.payerAddress(bad),
        (error: Error) => error instanceof ConfigurationError && !error.message.includes(bad),
      );
    }
  });
});

describe("verifySvmTransaction", () => {
  it("passes the advertised transfer from this run's payer", () => {
    const verdict = verifySvmTransaction(payment(), TX, EXPECTED);
    assert.equal(verdict.pass, true);
    assert.match(verdict.detail, /exactly the advertised 10000 base units .* token balances \(tx 5VERv8/);
  });

  it("counts a token account created in the transaction from zero", () => {
    const verdict = verifySvmTransaction(
      payment({ pre: [balance(1, PAYER, 20_000_000n)], post: [balance(1, PAYER, 19_990_000n), balance(2, PAY_TO, 10_000n)] }),
      TX,
      EXPECTED,
    );
    assert.equal(verdict.pass, true);
  });

  it("fails a transaction that failed on-chain", () => {
    const verdict = verifySvmTransaction(payment({ err: { InstructionError: [2, "Custom"] } }), TX, EXPECTED);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /exists on-chain but failed/);
  });

  it("fails a transaction that moved no tokens", () => {
    const flat = [balance(1, PAYER, 20_000_000n), balance(2, PAY_TO, 5_000_000n)];
    const verdict = verifySvmTransaction(payment({ pre: flat, post: flat }), TX, EXPECTED);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /changed no token balance/);
  });

  it("fails a transaction that moved more than one transfer", () => {
    // The advertised transfer, and a second one beside it.
    const verdict = verifySvmTransaction(
      payment({
        pre: [balance(1, PAYER, 20_000_000n), balance(2, PAY_TO, 0n), balance(3, PAYER, 7n), balance(4, OTHER, 0n)],
        post: [balance(1, PAYER, 19_990_000n), balance(2, PAY_TO, 10_000n), balance(3, PAYER, 2n), balance(4, OTHER, 5n)],
      }),
      TX,
      EXPECTED,
    );
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /changed 4 token balances .* not one transfer/);
  });

  it("fails balance changes that do not net to one transfer", () => {
    const verdict = verifySvmTransaction(
      payment({ post: [balance(1, PAYER, 19_995_000n), balance(2, PAY_TO, 5_010_000n)] }),
      TX,
      EXPECTED,
    );
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /not one transfer/);
  });

  it("names each term the transfer does not match", () => {
    const cases: Array<[string, SvmTransaction, RegExp]> = [
      [
        "amount",
        payment({ post: [balance(1, PAYER, 19_995_000n), balance(2, PAY_TO, 5_005_000n)] }),
        /amount: advertised 10000 base units, moved 5000/,
      ],
      [
        "recipient",
        payment({
          pre: [balance(1, PAYER, 20_000_000n), balance(2, OTHER, 0n)],
          post: [balance(1, PAYER, 19_990_000n), balance(2, OTHER, 10_000n)],
        }),
        new RegExp(`recipient: advertised ${PAY_TO}, paid ${OTHER}`),
      ],
      [
        "token",
        payment({
          pre: [balance(1, PAYER, 20_000_000n, OTHER), balance(2, PAY_TO, 0n, OTHER)],
          post: [balance(1, PAYER, 19_990_000n, OTHER), balance(2, PAY_TO, 10_000n, OTHER)],
        }),
        new RegExp(`token: advertised ${USDC}, moved ${OTHER}`),
      ],
      [
        "payer",
        payment({
          pre: [balance(1, OTHER, 20_000_000n), balance(2, PAY_TO, 0n)],
          post: [balance(1, OTHER, 19_990_000n), balance(2, PAY_TO, 10_000n)],
        }),
        new RegExp(`payer: this run paid from ${PAYER}, but the referenced transfer came from ${OTHER}`),
      ],
    ];
    for (const [term, transaction, detail] of cases) {
      const verdict = verifySvmTransaction(transaction, TX, EXPECTED);
      assert.equal(verdict.pass, false, term);
      assert.match(verdict.detail, /^Settlement does not match what the target advertised/, term);
      assert.match(verdict.detail, detail, term);
      for (const other of ["amount:", "recipient:", "token:", "payer:"].filter((t) => t !== `${term}:`)) {
        assert.equal(verdict.detail.includes(other), false, `${term} names only itself, not ${other}`);
      }
    }
  });

  it("gives no verdict when RPC leaves out the status or an owner", () => {
    assert.throws(() => verifySvmTransaction({ meta: null }, TX, EXPECTED), /without its status/);
    assert.throws(
      () =>
        verifySvmTransaction(
          payment({
            pre: [balance(1, PAYER, 20_000_000n), balance(2, undefined, 0n)],
            post: [balance(1, PAYER, 19_990_000n), balance(2, undefined, 10_000n)],
          }),
          TX,
          EXPECTED,
        ),
      /without the account's owner/,
    );
  });
});

describe("corruptSvmSignature", () => {
  /** A transaction the payer has signed and the fee payer has not, as the SDK client sends it. */
  async function partiallySigned(): Promise<string> {
    const signer = await createKeyPairSignerFromBytes(keypair().bytes);
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayer(address(FEE_PAYER), tx),
      (tx) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash("EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k"), lastValidBlockHeight: 0n },
          tx,
        ),
      (tx) =>
        appendTransactionMessageInstruction(
          {
            programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
            accounts: [{ address: signer.address, role: AccountRole.READONLY_SIGNER, signer }],
            data: new TextEncoder().encode("wasit"),
          },
          tx,
        ),
    );
    return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
  }

  const decode = (wire: string) => getTransactionDecoder().decode(getBase64Encoder().encode(wire));

  it("flips the first byte of the payer's signature and nothing else", async () => {
    const wire = await partiallySigned();
    const before = decode(wire);
    const after = decode(corruptSvmSignature({ transaction: wire })["transaction"] as string);

    assert.deepEqual(after.messageBytes, before.messageBytes);
    assert.equal(after.signatures[address(FEE_PAYER)], null, "the fee payer's slot stays empty");
    const [payer] = Object.keys(before.signatures).filter((signer) => signer !== FEE_PAYER);
    const original = before.signatures[payer as keyof typeof before.signatures]!;
    const forged = after.signatures[payer as keyof typeof after.signatures]!;
    assert.equal(forged[0], original[0]! ^ 0xff);
    assert.deepEqual(forged.subarray(1), original.subarray(1));
  });

  it("has no verdict to give when there is no payer signature to corrupt", () => {
    assert.throws(() => corruptSvmSignature({}), CheckSetupError);
    assert.throws(() => corruptSvmSignature({ transaction: "not a transaction" }), CheckSetupError);
  });

  it("will not guess which of two signatures is the payer's", async () => {
    const payer = await createKeyPairSignerFromBytes(keypair().bytes);
    const sponsor = await createKeyPairSignerFromBytes(keypair().bytes);
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(sponsor, tx),
      (tx) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash("EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k"), lastValidBlockHeight: 0n },
          tx,
        ),
      (tx) =>
        appendTransactionMessageInstruction(
          {
            programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
            accounts: [{ address: payer.address, role: AccountRole.READONLY_SIGNER, signer: payer }],
            data: new TextEncoder().encode("wasit"),
          },
          tx,
        ),
    );
    const wire = getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
    assert.throws(() => corruptSvmSignature({ transaction: wire }), CheckSetupError);
  });
});
