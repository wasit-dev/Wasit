/**
 * The EVM adapter: X402-06 and X402-07 on Base Sepolia, offline.
 *
 * Settlement is held to the token contract's ERC-20 Transfer log by the same
 * rules the Stellar adapter applies to the transfer event; X402-07 forges
 * only the EIP-3009 signature. Spec: `scheme_exact_evm.md` (DECISIONS.md,
 * Verified facts, 2026-10-05). Receipts here are built, not fetched.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeAbiParameters, pad, toEventSelector, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { CheckSetupError, ConfigurationError } from "../../src/errors.js";
import {
  corruptEvmSignature,
  evmChain,
  evmTransfers,
  verifyEvmReceipt,
  type EvmLog,
} from "../../src/x402/chains/evm.js";
import { paymentChainFor } from "../../src/x402/chains/index.js";
import { waitForReceipt } from "../../src/x402/chains/wait.js";
import { readSettlementReference } from "../../src/x402/simulator.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const OTHER = "0x1111111111111111111111111111111111111111";
const TX = `0x${"ab".repeat(32)}`;
const TRANSFER = toEventSelector("Transfer(address,address,uint256)");

function transferLog(token: string, from: string, to: string, value: bigint): EvmLog {
  return {
    address: token,
    topics: [TRANSFER, pad(from as Hex, { size: 32 }), pad(to as Hex, { size: 32 })],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

const EXPECTED = { amount: 10000n, token: USDC, recipient: PAY_TO, payer: PAYER };

describe("evmTransfers", () => {
  it("reads token, from, to and value from a Transfer log", () => {
    const [transfer] = evmTransfers([transferLog(USDC, PAYER, PAY_TO, 10000n)]);
    assert.equal(transfer?.token, USDC);
    assert.equal(transfer?.from.toLowerCase(), PAYER.toLowerCase());
    assert.equal(transfer?.to.toLowerCase(), PAY_TO.toLowerCase());
    assert.equal(transfer?.value, 10000n);
  });

  it("ignores other events and ERC-721 transfers", () => {
    const erc721 = { ...transferLog(USDC, PAYER, PAY_TO, 1n), topics: [TRANSFER, pad(PAYER), pad(PAY_TO), pad("0x01")] };
    const approval = { ...transferLog(USDC, PAYER, PAY_TO, 1n), topics: [toEventSelector("Approval(address,address,uint256)"), pad(PAYER), pad(PAY_TO)] };
    assert.deepEqual(evmTransfers([erc721, approval]), []);
  });
});

describe("verifyEvmReceipt", () => {
  const receipt = (logs: EvmLog[], status = "success") => ({ status, logs });

  it("passes the advertised transfer, comparing addresses case-insensitively", () => {
    const verdict = verifyEvmReceipt(
      receipt([transferLog(USDC.toLowerCase(), PAYER, PAY_TO.toLowerCase(), 10000n)]),
      TX,
      EXPECTED,
    );
    assert.equal(verdict.pass, true);
    assert.match(verdict.detail, /exactly the advertised 10000 base units .* verified from the Transfer log/);
  });

  it("fails a reverted transaction", () => {
    const verdict = verifyEvmReceipt(receipt([transferLog(USDC, PAYER, PAY_TO, 10000n)], "reverted"), TX, EXPECTED);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /reverted/);
  });

  it("fails a transaction that moved no token, or more than one transfer", () => {
    assert.match(verifyEvmReceipt(receipt([]), TX, EXPECTED).detail, /no ERC-20 Transfer/);
    const two = verifyEvmReceipt(
      receipt([transferLog(USDC, PAYER, PAY_TO, 10000n), transferLog(USDC, PAYER, OTHER, 1n)]),
      TX,
      EXPECTED,
    );
    assert.match(two.detail, /2 ERC-20 Transfers; exactly one was expected/);
  });

  it("names every way the transfer misses the terms", () => {
    const verdict = verifyEvmReceipt(receipt([transferLog(OTHER, OTHER, OTHER, 1n)]), TX, EXPECTED);
    assert.equal(verdict.pass, false);
    for (const part of ["amount: advertised 10000 base units, moved 1", "recipient:", "token:", "payer:"]) {
      assert.ok(verdict.detail.includes(part), part);
    }
  });

  // Without the payer rule, a target could cite any earlier transfer that
  // happens to match amount, token and recipient, and take nothing.
  it("fails a matching transfer that came from someone else", () => {
    const verdict = verifyEvmReceipt(receipt([transferLog(USDC, OTHER, PAY_TO, 10000n)]), TX, EXPECTED);
    assert.equal(verdict.pass, false);
    assert.match(verdict.detail, /^Settlement does not match .*payer: this run paid from/);
    assert.equal(verdict.detail.includes("amount:"), false);
  });
});

describe("waitForReceipt", () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it("returns the receipt once it appears", async () => {
    let calls = 0;
    const lookup = await waitForReceipt(
      async () => (++calls >= 3 ? "receipt" : undefined),
      async () => 100n,
      { blocks: 30n, ...clock() },
    );
    assert.deepEqual(lookup, { kind: "found", receipt: "receipt" });
  });

  it("calls a transaction missing once enough blocks pass without it", async () => {
    let block = 100n;
    const lookup = await waitForReceipt(async () => undefined, async () => (block += 5n), {
      blocks: 30n,
      ...clock(),
    });
    assert.equal(lookup.kind, "missing");
  });

  it("gives no verdict when the RPC stops advancing", async () => {
    const lookup = await waitForReceipt(async () => undefined, async () => 100n, {
      blocks: 30n,
      maxWaitMs: 10_000,
      ...clock(),
    });
    assert.equal(lookup.kind, "stalled");
  });

  it("lets an RPC failure through, as a harness problem", async () => {
    await assert.rejects(
      waitForReceipt(async () => {
        throw new Error("rpc down");
      }, async () => 1n, { blocks: 30n }),
      /rpc down/,
    );
  });
});

describe("corruptEvmSignature", () => {
  const signature = `0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c`;
  const authorization = { from: PAYER, to: PAY_TO, value: "10000" };

  it("flips the first byte of the signature and nothing else", () => {
    const corrupted = corruptEvmSignature({ signature, authorization });
    const forged = corrupted["signature"] as string;
    assert.equal(forged.length, signature.length);
    assert.equal(forged.slice(0, 4), "0xd2");
    assert.equal(forged.slice(4), signature.slice(4));
    assert.deepEqual(corrupted["authorization"], authorization);
  });

  it("reports no verdict when there is no signature to corrupt", () => {
    assert.throws(() => corruptEvmSignature({ authorization }), CheckSetupError);
    assert.throws(() => corruptEvmSignature({ signature: "0x1234" }), CheckSetupError);
  });
});

describe("the EVM adapter", () => {
  it("pays on Base Sepolia and Ethereum Sepolia, and Stellar still pays on Stellar", () => {
    assert.equal(paymentChainFor("eip155:84532")?.name, "EVM");
    assert.equal(paymentChainFor("eip155:11155111")?.name, "EVM");
    assert.equal(paymentChainFor("stellar:testnet")?.name, "Stellar");
    // BNB Smart Chain testnet: read-only only.
    assert.equal(paymentChainFor("eip155:97"), undefined);
  });

  it("defaults to the chain's public RPC and honours an override", () => {
    assert.equal(evmChain.resolveRpcUrl("eip155:84532"), "https://sepolia.base.org");
    assert.equal(evmChain.resolveRpcUrl("eip155:84532", "https://rpc.internal"), "https://rpc.internal");
    // viem's default for Ethereum Sepolia; the docs name it.
    assert.equal(evmChain.resolveRpcUrl("eip155:11155111"), "https://11155111.rpc.thirdweb.com");
  });

  it("derives the payer address, and rejects a malformed key without echoing it", () => {
    const key = generatePrivateKey();
    assert.equal(evmChain.payerAddress(key), privateKeyToAccount(key).address);
    const bad = key.slice(0, -1);
    assert.throws(
      () => evmChain.payerAddress(bad),
      (error: unknown) => error instanceof ConfigurationError && !String((error as Error).message).includes(bad),
    );
  });

  it("accepts an EVM transaction hash as a settlement reference, and only that", () => {
    assert.deepEqual(
      readSettlementReference(200, () => ({ success: true, transaction: TX }), evmChain),
      { reference: TX },
    );
    const stellarShaped = readSettlementReference(200, () => ({ success: true, transaction: "ab".repeat(32) }), evmChain);
    assert.ok("failure" in stellarShaped);
    assert.match("failure" in stellarShaped ? stellarShaped.failure : "", /not an EVM transaction hash/);
  });
});
