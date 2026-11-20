/**
 * X402-11's reads on Stellar (D-032, spec B16.4), written before the code.
 *
 * - The authorization is decoded from the signed entry of the payload, never
 *   computed: the payer's address, the nonce, the expiration ledger.
 * - Its use is read with `getLedgerEntries` on the TEMPORARY contract-data
 *   entry the host writes when it consumes a nonce: contract = the payer's
 *   address, key = `LedgerKeyNonce { nonce }` (rs-soroban-env `consume_nonce`).
 *   Several are asked for in one call, so they are read at one state.
 * - The second reading is the token's `transfer` events from the payer to
 *   `payTo`, read with `getEvents` from a ledger on; only events of a
 *   successful call count, and a failed read throws rather than reading as
 *   "no transfer".
 *
 * Offline: a JSON-RPC stand-in on loopback answers as Stellar RPC would.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

import { CheckSetupError } from "../../src/errors.js";
import { stellarChain } from "../../src/x402/chains/stellar.js";

const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAYER = Keypair.random().publicKey();
const PAY_TO = Keypair.random().publicKey();
const NETWORK = "stellar:testnet";

const watch = stellarChain.authorizations!;

function addressEntry(address: string, nonce: string, expiration: number): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(),
        nonce: xdr.Int64.fromString(nonce),
        signatureExpirationLedger: expiration,
        signature: xdr.ScVal.scvVec([]),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TOKEN).toScAddress(), functionName: "transfer", args: [] }),
      ),
      subInvocations: [],
    }),
  });
}

function sourceAccountEntry(): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: addressEntry(PAYER, "1", 1).rootInvocation(),
  });
}

function payload(...auth: xdr.SorobanAuthorizationEntry[]): Record<string, unknown> {
  const transaction = new TransactionBuilder(new Account(PAYER, "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({ contract: TOKEN, function: "transfer", args: [], auth }))
    .setTimeout(30)
    .build();
  return { transaction: transaction.toEnvelope().toXDR("base64") };
}

describe("decode: the authorization as signed", () => {
  it("reads the payer, the nonce and the expiration ledger from the address credential", () => {
    const decoded = watch.decode(payload(addressEntry(PAYER, "1234567890123", 5000)));
    assert.deepEqual(decoded, { payer: PAYER, nonce: "1234567890123", expiresAt: 5000 });
  });

  it("keeps a negative 64-bit nonce exact", () => {
    assert.equal(watch.decode(payload(addressEntry(PAYER, "-9223372036854775808", 7))).nonce, "-9223372036854775808");
  });

  it("ignores a source-account entry next to the address one", () => {
    assert.equal(watch.decode(payload(sourceAccountEntry(), addressEntry(PAYER, "5", 9))).nonce, "5");
  });

  for (const [label, value] of [
    ["no transaction", {}],
    ["a transaction that does not decode", { transaction: "not-xdr" }],
    ["no address authorization", payload(sourceAccountEntry())],
    ["two address authorizations", payload(addressEntry(PAYER, "1", 9), addressEntry(PAYER, "2", 9))],
  ] as const) {
    it(`gives no reading (CheckSetupError) for ${label}`, () => {
      assert.throws(() => watch.decode(value as Record<string, unknown>), CheckSetupError);
    });
  }

  it("is the unit Stellar counts in: a ledger, about 5 s", () => {
    assert.equal(watch.unit, "ledger");
    assert.equal(watch.unitMs, 5000);
    assert.equal(watch.unitSeconds, 5, "the x402 Stellar client's default ledger estimate");
  });
});

interface RpcCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** A Stellar RPC stand-in: `answer` gets each call and returns its `result`, or throws for a JSON-RPC error. */
async function rpcStandIn(answer: (call: RpcCall) => unknown) {
  const calls: RpcCall[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf-8")));
    request.on("end", () => {
      const parsed = JSON.parse(body) as { id: number; method: string; params: Record<string, unknown> };
      calls.push({ method: parsed.method, params: parsed.params });
      response.writeHead(200, { "content-type": "application/json" });
      try {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: answer(parsed) }));
      } catch (error) {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error: { code: -32600, message: (error as Error).message } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/rpc`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function nonceKey(address: string, nonce: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(address).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce: xdr.Int64.fromString(nonce) })),
      durability: xdr.ContractDataDurability.temporary(),
    }),
  );
}

function nonceEntry(address: string, nonce: string): string {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: Address.fromString(address).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce: xdr.Int64.fromString(nonce) })),
      durability: xdr.ContractDataDurability.temporary(),
      val: xdr.ScVal.scvVoid(),
    }),
  ).toXDR("base64");
}

describe("read: the nonce entries, in one call", () => {
  let rpc: Awaited<ReturnType<typeof rpcStandIn>>;
  const used = nonceKey(PAYER, "11").toXDR("base64");

  before(async () => {
    rpc = await rpcStandIn((call) => {
      if (call.method !== "getLedgerEntries") throw new Error(`unexpected ${call.method}`);
      const keys = call.params["keys"] as string[];
      return {
        latestLedger: 5100,
        entries: keys
          .filter((key) => key === used)
          .map((key) => ({ key, xdr: nonceEntry(PAYER, "11"), lastModifiedLedgerSeq: 5003, liveUntilLedgerSeq: 5722 })),
      };
    });
  });
  after(() => rpc.close());

  it("asks for the temporary nonce entry of each authorization, and says which was used and when", async () => {
    const read = await watch.read(NETWORK, rpc.url, [
      { payer: PAYER, nonce: "12", expiresAt: 5050 },
      { payer: PAYER, nonce: "11", expiresAt: 5010 },
    ]);
    assert.equal(rpc.calls.length, 1, "both were read in one call");
    assert.deepEqual(rpc.calls[0]!.params["keys"], [nonceKey(PAYER, "12").toXDR("base64"), used]);
    assert.deepEqual(read, { latest: 5100, used: [undefined, 5003] });
  });
});

describe("read: an RPC that fails", () => {
  it("throws, and is never read as unused", async () => {
    const rpc = await rpcStandIn(() => {
      throw new Error("start is before oldest ledger");
    });
    try {
      await assert.rejects(watch.read(NETWORK, rpc.url, [{ payer: PAYER, nonce: "1", expiresAt: 9 }]));
    } finally {
      await rpc.close();
    }
  });
});

/**
 * An event as the testnet RPC sent it on 2026-11-16: the keys type, ledger,
 * ledgerClosedAt, contractId, id, operationIndex, transactionIndex, txHash,
 * topic and value, and no `inSuccessfulContractCall`.
 */
function transferEvent(from: string, to: string, amount: bigint, extra: Record<string, unknown> = {}) {
  return {
    type: "contract",
    ledger: 5004,
    ledgerClosedAt: "2026-11-16T10:00:00Z",
    contractId: TOKEN,
    id: `0000-${amount}`,
    txHash: "ab".repeat(32),
    transactionIndex: 1,
    operationIndex: 0,
    topic: [
      xdr.ScVal.scvSymbol("transfer").toXDR("base64"),
      Address.fromString(from).toScVal().toXDR("base64"),
      Address.fromString(to).toScVal().toXDR("base64"),
      nativeToScVal("USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", { type: "string" }).toXDR("base64"),
    ],
    value: nativeToScVal(amount, { type: "i128" }).toXDR("base64"),
    ...extra,
  };
}

describe("transfers: the second reading", () => {
  it("reads the token's transfer events from the payer to payTo, from the ledger on, leaving out a failed call", async () => {
    const rpc = await rpcStandIn((call) => {
      if (call.method !== "getEvents") throw new Error(`unexpected ${call.method}`);
      return {
        latestLedger: 5100,
        oldestLedger: 100,
        latestLedgerCloseTime: "0",
        oldestLedgerCloseTime: "0",
        cursor: "c1",
        events: [
          transferEvent(PAYER, PAY_TO, 10000n),
          transferEvent(PAYER, PAY_TO, 777n, { inSuccessfulContractCall: false }),
          transferEvent(PAYER, PAY_TO, 888n, { inSuccessfulContractCall: true, txHash: "cd".repeat(32) }),
        ],
      };
    });
    try {
      const read = await watch.transfers(NETWORK, rpc.url, { asset: TOKEN, from: PAYER, to: PAY_TO, fromLedger: 5001 });
      // The first has no inSuccessfulContractCall, as the testnet RPC sends it; it counts.
      assert.deepEqual(read, {
        latest: 5100,
        transfers: [
          { amount: 10000n, reference: "ab".repeat(32), ledger: 5004 },
          { amount: 888n, reference: "cd".repeat(32), ledger: 5004 },
        ],
      });
      const params = rpc.calls[0]!.params;
      assert.equal(params["startLedger"], 5001);
      const filters = params["filters"] as { type: string; contractIds: string[]; topics: string[][] }[];
      assert.deepEqual(filters[0]!.contractIds, [TOKEN]);
      assert.equal(filters[0]!.type, "contract");
      for (const topics of filters[0]!.topics) {
        assert.equal(topics[0], xdr.ScVal.scvSymbol("transfer").toXDR("base64"));
        assert.equal(topics[1], Address.fromString(PAYER).toScVal().toXDR("base64"));
        assert.equal(topics[2], Address.fromString(PAY_TO).toScVal().toXDR("base64"));
      }
    } finally {
      await rpc.close();
    }
  });

  it("follows the cursor when a page is full", async () => {
    let page = 0;
    const rpc = await rpcStandIn(() => {
      page += 1;
      const events = page === 1 ? Array.from({ length: 100 }, () => transferEvent(PAYER, PAY_TO, 1n)) : [transferEvent(PAYER, PAY_TO, 10000n)];
      return { latestLedger: 5100, oldestLedger: 100, latestLedgerCloseTime: "0", oldestLedgerCloseTime: "0", cursor: `c${page}`, events };
    });
    try {
      const read = await watch.transfers(NETWORK, rpc.url, { asset: TOKEN, from: PAYER, to: PAY_TO, fromLedger: 5001 });
      assert.equal(read.transfers.length, 101);
      assert.equal(rpc.calls.length, 2);
      assert.equal(rpc.calls[1]!.params["pagination"] !== undefined || rpc.calls[1]!.params["cursor"] !== undefined, true);
    } finally {
      await rpc.close();
    }
  });

  it("throws after 20 full pages rather than read a cut list as complete (review R6, K27)", async () => {
    let page = 0;
    const rpc = await rpcStandIn(() => {
      page += 1;
      const events = Array.from({ length: 100 }, () => transferEvent(PAYER, PAY_TO, 1n));
      return { latestLedger: 5100, oldestLedger: 100, latestLedgerCloseTime: "0", oldestLedgerCloseTime: "0", cursor: `c${page}`, events };
    });
    try {
      await assert.rejects(
        watch.transfers(NETWORK, rpc.url, { asset: TOKEN, from: PAYER, to: PAY_TO, fromLedger: 5001 }),
        /more transfer events than can be read in full/,
      );
      assert.equal(rpc.calls.length, 20);
    } finally {
      await rpc.close();
    }
  });

  it("throws when the RPC cannot serve the range, rather than reading it as no transfer", async () => {
    const rpc = await rpcStandIn(() => {
      throw new Error("startLedger must be within the ledger range");
    });
    try {
      await assert.rejects(watch.transfers(NETWORK, rpc.url, { asset: TOKEN, from: PAYER, to: PAY_TO, fromLedger: 1 }));
    } finally {
      await rpc.close();
    }
  });
});
