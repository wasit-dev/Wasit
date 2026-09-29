/**
 * MPP-01 looks up the transaction a target says it settled.
 *
 * It used to give RPC twelve seconds and then report the transaction as
 * missing, blaming the target for an RPC that was merely behind. The wait is
 * now measured in ledgers RPC closes: missing only once RPC has closed enough
 * ledgers without it, and no verdict at all when RPC stops advancing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rpc } from "@stellar/stellar-sdk";

import { waitForTransaction } from "../../src/settlement.js";

const NOT_FOUND = rpc.Api.GetTransactionStatus.NOT_FOUND;
const SUCCESS = rpc.Api.GetTransactionStatus.SUCCESS;

/** A fake RPC that answers from a script, one response per lookup. */
function scriptedRpc(ledgers: number[], foundAt?: number) {
  let call = 0;
  return async (): Promise<rpc.Api.GetTransactionResponse> => {
    const index = Math.min(call, ledgers.length - 1);
    call += 1;
    const status = foundAt !== undefined && index >= foundAt ? SUCCESS : NOT_FOUND;
    return { status, latestLedger: ledgers[index]! } as rpc.Api.GetTransactionResponse;
  };
}

/** A clock that advances one second per sleep, so tests run instantly. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("waitForTransaction", () => {
  it("returns the transaction as soon as RPC has it", async () => {
    const clock = fakeClock();
    const lookup = await waitForTransaction(scriptedRpc([100, 101, 102], 2), clock);
    assert.equal(lookup.kind, "found");
  });

  it("reports missing only after RPC has closed enough ledgers without it", async () => {
    const clock = fakeClock();
    const advancing = Array.from({ length: 20 }, (_, i) => 100 + i);
    const lookup = await waitForTransaction(scriptedRpc(advancing), { ...clock, ledgers: 10 });
    assert.deepEqual(lookup, { kind: "missing", ledgersWatched: 10 });
  });

  it("does not report missing while RPC is behind but still advancing", async () => {
    const clock = fakeClock();
    // One new ledger every five lookups: slow, but moving.
    const slow = Array.from({ length: 200 }, (_, i) => 100 + Math.floor(i / 5));
    const lookup = await waitForTransaction(scriptedRpc(slow, 30), { ...clock, ledgers: 10 });
    assert.equal(lookup.kind, "found");
  });

  it("gives no verdict when RPC stops advancing", async () => {
    const clock = fakeClock();
    const stuck = Array.from({ length: 200 }, () => 100);
    const lookup = await waitForTransaction(scriptedRpc(stuck), {
      ...clock,
      ledgers: 10,
      maxWaitMs: 30_000,
    });
    assert.equal(lookup.kind, "stalled");
    assert.equal(lookup.kind === "stalled" && lookup.ledgersWatched, 0);
  });
});
