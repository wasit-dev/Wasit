/**
 * The payer balance X402-06 reads before paying, offline.
 *
 * The rule itself (a balance below the price is ERROR (setup), an unreadable
 * one pays as before) is in payment-negatives.test.ts. These are the chain
 * readings it rests on: a Stellar Asset Contract is recognised only by its
 * own contract id, and a Solana payer's balance is every token account it
 * holds for the mint, or nothing when RPC answers in a shape it does not
 * know. The Stellar `balance` read and the trustline lookup were run live
 * against testnet (docs/evidence/2026-10-05-0.7.0-verification-runs.md, part 4).
 */

import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";

import { Networks } from "@stellar/stellar-sdk";

import { sacAssetFromName } from "../../src/x402/chains/stellar.js";
import { svmChain } from "../../src/x402/chains/svm.js";

const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const USDC_NAME = "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

describe("sacAssetFromName", () => {
  it("recognises testnet USDC's Stellar Asset Contract by its name and id", () => {
    const asset = sacAssetFromName(USDC_NAME, USDC_SAC, Networks.TESTNET);
    assert.equal(asset?.getCode(), "USDC");
    assert.equal(asset?.getIssuer(), "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
  });

  it("refuses a name the contract's id does not belong to", () => {
    // The same name on mainnet's passphrase is another contract: a lookalike
    // token returning a SAC-style name is not taken for the SAC.
    assert.equal(sacAssetFromName(USDC_NAME, USDC_SAC, Networks.PUBLIC), undefined);
    for (const name of ["native", "USD Coin", "USDC:not-an-issuer", 7n, undefined]) {
      assert.equal(sacAssetFromName(name, USDC_SAC, Networks.TESTNET), undefined, String(name));
    }
  });
});

/** A Solana JSON-RPC endpoint answering getTokenAccountsByOwner with `amounts`. */
async function solanaRpc(amounts: readonly unknown[]): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { id } = JSON.parse(body) as { id: unknown };
      const value = amounts.map((amount, index) => ({
        pubkey: `Acct${index}111111111111111111111111111111111111`,
        account: {
          data: { program: "spl-token", parsed: { type: "account", info: { tokenAmount: { amount } } }, space: 165 },
          executable: false,
          lamports: 2039280,
          owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          rentEpoch: 0,
        },
      }));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

describe("the Solana payer balance", () => {
  const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
  const PAYER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

  it("sums every token account for the mint, and reads none as zero", async () => {
    for (const [amounts, expected] of [
      [["5000", "7000"], 12_000n],
      [[], 0n],
    ] as const) {
      const rpc = await solanaRpc(amounts);
      try {
        assert.equal(await svmChain.payerBalance(DEVNET, rpc.url, PAYER, MINT), expected);
      } finally {
        await rpc.close();
      }
    }
  });

  it("gives no reading when an amount is not a whole number of base units", async () => {
    const rpc = await solanaRpc(["5000", 12]);
    try {
      assert.equal(await svmChain.payerBalance(DEVNET, rpc.url, PAYER, MINT), undefined);
    } finally {
      await rpc.close();
    }
  });
});
