/**
 * `wasit wallet --network`: testnets only, the MPP roles on Stellar only,
 * and a generated key in the form the payment checks read.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { paymentChainFor } from "@wasit-dev/core";

import {
  WALLET_NETWORKS,
  formatUnits,
  generatedKeyLines,
  walletNetworkProblem,
} from "../../src/wallet-command.js";

const BASE = "eip155:84532";
const SOLANA = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

describe("walletNetworkProblem", () => {
  it("takes the testnets, for x402", () => {
    for (const network of WALLET_NETWORKS) assert.equal(walletNetworkProblem(network, "x402"), undefined, network);
    assert.ok(WALLET_NETWORKS.includes(BASE) && WALLET_NETWORKS.includes(SOLANA));
  });

  it("refuses a mainnet or an unknown network", () => {
    for (const network of ["stellar:pubnet", "eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "base"]) {
      assert.match(walletNetworkProblem(network, "x402") ?? "", /Expected a testnet/, network);
    }
  });

  it("keeps the MPP roles on Stellar", () => {
    assert.equal(walletNetworkProblem("stellar:testnet", "mpp-charge"), undefined);
    assert.match(walletNetworkProblem(BASE, "mpp-charge") ?? "", /Stellar only/);
    assert.match(walletNetworkProblem(SOLANA, "mpp-channel") ?? "", /Stellar only/);
  });
});

describe("generatedKeyLines", () => {
  for (const [network, env, faucet, native] of [
    [BASE, "EVM_PRIVATE_KEY", "Base Sepolia", "ETH"],
    [SOLANA, "SVM_PRIVATE_KEY", "Solana Devnet", "SOL"],
  ] as const) {
    it(`${network}: the .env line, the address it pays from, and where to get USDC`, () => {
      const chain = paymentChainFor(network)!;
      const secret = chain.generatePayerKey();
      const text = generatedKeyLines(network, secret).join("\n");
      assert.ok(text.includes(`${env}=${secret}`));
      assert.ok(text.includes(`Address: ${chain.payerAddress(secret)}`));
      assert.ok(text.includes(`network ${faucet}`));
      assert.ok(text.includes(`needs no ${native}`));
    });
  }
});

describe("formatUnits", () => {
  it("writes base units as a decimal amount", () => {
    assert.equal(formatUnits(19_970_000n, 6), "19.97");
    assert.equal(formatUnits(20_000_000n, 6), "20");
    assert.equal(formatUnits(5n, 6), "0.000005");
    assert.equal(formatUnits(0n, 6), "0");
  });
});
