/**
 * MPP-01 reads the token contract's `transfer` event to verify settlement.
 *
 * CAP-46 made the event's data a bare `i128` amount. CAP-67 keeps that when no
 * muxed information is emitted, and otherwise makes it a map
 * `{ amount, to_muxed_id }`, with the destination's base address in the topic.
 * Before this, only the bare form was read, so a payment to a muxed recipient
 * was dropped and MPP-01 reported a settlement that happened as one that did
 * not. The events below are built as RPC's `getTransaction` returns them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Account, Address, Keypair, MuxedAccount, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import {
  collectTransferEvents,
  transferReachedRecipient,
} from "../../src/settlement.js";

const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAYER = Keypair.random().publicKey();
const RECIPIENT = Keypair.random().publicKey();
const MUXED_RECIPIENT = new MuxedAccount(new Account(RECIPIENT, "0"), "42").accountId();

const symbol = (value: string): xdr.ScVal => nativeToScVal(value, { type: "symbol" });
const i128 = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: "i128" });

function transferEvent(data: xdr.ScVal, to = RECIPIENT): xdr.ContractEvent {
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: Address.fromString(TOKEN).toScAddress().contractId(),
    type: xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(
      0,
      new xdr.ContractEventV0({
        topics: [
          symbol("transfer"),
          Address.fromString(PAYER).toScVal(),
          Address.fromString(to).toScVal(),
          nativeToScVal("USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
        ],
        data,
      }),
    ),
  });
}

function mapData(amount: bigint, toMuxedId: xdr.ScVal): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: symbol("amount"), val: i128(amount) }),
    new xdr.ScMapEntry({ key: symbol("to_muxed_id"), val: toMuxedId }),
  ]);
}

describe("collectTransferEvents", () => {
  it("reads the CAP-46 form, a bare i128 amount", () => {
    const [transfer] = collectTransferEvents([[transferEvent(i128(10000n))]]);
    assert.deepEqual(transfer, {
      from: PAYER,
      to: RECIPIENT,
      amount: 10000n,
      contract: TOKEN,
    });
  });

  it("reads the CAP-67 form, a map with a u64 muxed id", () => {
    const events = collectTransferEvents([
      [transferEvent(mapData(10000n, nativeToScVal(42n, { type: "u64" })))],
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.amount, 10000n);
    assert.equal(events[0]?.to, RECIPIENT);
    assert.equal(events[0]?.toMuxedId, "42");
  });

  it("reads a memo-derived muxed id given as a string or as bytes", () => {
    const [text] = collectTransferEvents([
      [transferEvent(mapData(5n, nativeToScVal("invoice-7", { type: "string" })))],
    ]);
    assert.equal(text?.toMuxedId, "invoice-7");

    const [bytes] = collectTransferEvents([
      [transferEvent(mapData(5n, xdr.ScVal.scvBytes(Buffer.from([0xab, 0xcd]))))],
    ]);
    assert.equal(bytes?.toMuxedId, "abcd");
  });

  it("reads a map with no muxed id as a plain transfer", () => {
    const [transfer] = collectTransferEvents([
      [transferEvent(xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: symbol("amount"), val: i128(9n) })]))],
    ]);
    assert.equal(transfer?.amount, 9n);
    assert.equal(transfer?.toMuxedId, undefined);
  });

  it("ignores data that carries no amount", () => {
    assert.deepEqual(collectTransferEvents([[transferEvent(nativeToScVal("nope"))]]), []);
  });
});

describe("transferReachedRecipient", () => {
  const plain = { from: PAYER, to: RECIPIENT, amount: 1n, contract: TOKEN };
  const muxed = { ...plain, toMuxedId: "42" };

  it("matches an ordinary recipient by address", () => {
    assert.equal(transferReachedRecipient(RECIPIENT, plain), true);
    assert.equal(transferReachedRecipient(Keypair.random().publicKey(), plain), false);
  });

  it("matches a muxed recipient only when both the base account and the id match", () => {
    assert.equal(transferReachedRecipient(MUXED_RECIPIENT, muxed), true);
    assert.equal(transferReachedRecipient(MUXED_RECIPIENT, { ...muxed, toMuxedId: "43" }), false);
    assert.equal(transferReachedRecipient(MUXED_RECIPIENT, plain), false);
  });
});
