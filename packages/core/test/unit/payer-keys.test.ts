/**
 * Each payment adapter generates payer keys in the form its own key check
 * takes, so `wasit wallet create` never hands out a key the payment checks
 * would refuse at preflight.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";

import { paymentChainFor, paymentNetworks } from "../../src/x402/chains/index.js";

describe("generatePayerKey", () => {
  for (const network of paymentNetworks()) {
    it(`${network}: a fresh key the adapter reads back, different every time`, () => {
      const chain = paymentChainFor(network)!;
      const one = chain.generatePayerKey();
      const two = chain.generatePayerKey();
      assert.notEqual(one, two);
      assert.ok(chain.payerAddress(one).length > 0);
      assert.notEqual(chain.payerAddress(one), chain.payerAddress(two));
    });
  }

  it("gives Solana keys whose address is the one kit derives from the keypair", async () => {
    const chain = paymentChainFor("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")!;
    const key = chain.generatePayerKey();
    const signer = await createKeyPairSignerFromBytes(new Uint8Array(getBase58Encoder().encode(key)));
    assert.equal(chain.payerAddress(key), signer.address);
  });

  it("gives Stellar secrets and EVM private keys in their usual form", () => {
    assert.match(paymentChainFor("stellar:testnet")!.generatePayerKey(), /^S[A-Z2-7]{55}$/);
    assert.match(paymentChainFor("eip155:84532")!.generatePayerKey(), /^0x[0-9a-f]{64}$/);
  });
});
