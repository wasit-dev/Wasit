/**
 * X402-11, "Rejected Request Not Settled" (spec B7 as D-032 changed it, with
 * Najmi's reading of the 300 s limit, 2026-11-16). Written before the code
 * (CONTEXT rule 3).
 *
 * Wasit sends a valid payment with a request the config declares invalid, then
 * reads the chain: the nonce of that payment's authorization must still be
 * unused after its expiration ledger has passed, read in the same call as
 * X402-06's nonce, which must be found (the control). The payer's balance and
 * the transfer events are second readings; when they disagree with the nonce,
 * there is no verdict. Nothing is signed when the check cannot reach a
 * verdict anyway: no reject case, a service that refuses before asking for
 * payment, a lifetime above 300 s, a chain it cannot read, a control it cannot
 * find.
 *
 * Offline: a recording chain whose payloads carry a nonce and an expiration
 * ledger, a ledger that advances one ledger a read, and a paywall with the
 * three modes of B7.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { CheckResult } from "../../src/check.js";
import { setRpcIdentityTransportForTesting } from "../../src/guard/rpc-identity.js";
import { setPaymentChainsForTesting } from "../../src/x402/chains/index.js";
import { planX402Run } from "../../src/x402/plan.js";
import {
  REJECTED_REQUEST_HARD_STOP_MS,
  REJECTED_REQUEST_MAX_LIFETIME_SECONDS,
  REJECTED_REQUEST_MIN_LIFETIME_SECONDS,
  rejectRequestShape,
  rejectedRequestHardStopMs,
  rejectedRequestVerdict,
  setRejectedRequestHardStopForTesting,
  watchAuthorization,
} from "../../src/x402/rejected-request.js";
import { X402_PAYMENT_CHECK_IDS, runX402PaymentChecks } from "../../src/x402/simulator.js";
import {
  fakeLedger,
  ledgerChain,
  rejectPaywall,
  type FakeLedger,
  type InvalidMode,
  type LedgerChainOptions,
  type RejectPaywall,
  type RejectPaywallOptions,
} from "../support/authorization-ledger.js";
import { NETWORK, PAY_TO, option, type Recorder } from "../support/recording-chain.js";

const REJECT = { headers: { "x-invalid": "1" }, note: "the marker header must be refused" };

let recorder: Recorder;
let ledger: FakeLedger;
const walls: RejectPaywall[] = [];

function install(options: LedgerChainOptions = {}): void {
  setPaymentChainsForTesting([ledgerChain(recorder, ledger, options)]);
  setRpcIdentityTransportForTesting(async (_url, method) => (method === "eth_chainId" ? "0x14a34" : undefined));
}

beforeEach(() => {
  recorder = { signed: [] };
  ledger = fakeLedger();
  install();
});

afterEach(async () => {
  setPaymentChainsForTesting(undefined);
  setRpcIdentityTransportForTesting(undefined);
  setRejectedRequestHardStopForTesting(undefined);
  await Promise.all(walls.splice(0).map((wall) => wall.close()));
});

async function wall(mode: InvalidMode, extra: Partial<RejectPaywallOptions> = {}, maxTimeoutSeconds = 60): Promise<RejectPaywall> {
  const created = await rejectPaywall(ledger, [{ ...option({ amount: "10000" }), maxTimeoutSeconds }], { mode, ...extra });
  walls.push(created);
  return created;
}

function byId(results: readonly CheckResult[], id: string): CheckResult {
  const found = results.find((result) => result.id === id);
  assert.ok(found, `no ${id} in ${results.map((result) => result.id).join(", ")}`);
  return found;
}

const run = (target: string, extra: Partial<Parameters<typeof runX402PaymentChecks>[0]> = {}) =>
  runX402PaymentChecks({ target, network: NETWORK, payerSecretKey: "test-payer-key", reject: REJECT, ...extra });

/** The X402-06..10 signatures of a conformant service: four, X402-08 resends X402-06's. */
const BEFORE_X402_11 = 4;

describe("X402-11 in the payment checks", () => {
  it("is the last payment check, after X402-10", () => {
    assert.deepEqual(X402_PAYMENT_CHECK_IDS, ["X402-06", "X402-07", "X402-08", "X402-09", "X402-10", "X402-11"]);
  });

  it("PASS: the service refuses without settling; the nonce is unused past its expiry; the control is found", async () => {
    const target = await wall("refuse");
    const results = await run(target.url);
    const result = byId(results, "X402-11");
    assert.equal(result.pass, true, result.detail);
    assert.equal(result.error, undefined);
    assert.match(result.detail, /refused \(HTTP 400/);
    assert.match(result.detail, /not taken/);
    assert.match(result.detail, /expired at ledger \d+ unused/);
    // It signed one payment, for the advertised terms exactly (no shortened lifetime).
    assert.equal(recorder.signed.length, BEFORE_X402_11 + 1);
    const signed = recorder.signed.at(-1)!;
    assert.equal(signed.amount, "10000");
    assert.equal(signed.maxTimeoutSeconds, 60);
    assert.equal(signed.payTo, PAY_TO);
    // The invalid request was the one sent with it.
    assert.equal(target.invalid.length, 1);
    assert.equal(target.invalid[0]!.headers["x-invalid"], "1");
    for (const id of ["X402-06", "X402-07", "X402-08", "X402-09", "X402-10"]) {
      assert.equal(byId(results, id).pass, true, `${id}: ${byId(results, id).detail}`);
    }
  });

  it("FAIL: the service settles the payment and then refuses the request; the transaction is named", async () => {
    const target = await wall("settle-then-refuse");
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.pass, false);
    assert.equal(result.error, undefined, result.detail);
    assert.equal(result.skipped, undefined);
    assert.match(result.detail, /refused .* and the payment was taken/);
    assert.match(result.detail, /tx-nonce-5/);
    assert.ok(result.hint !== undefined && /settle/i.test(result.hint));
  });

  it("FAIL: the service serves the request the config declares invalid, and says whether it settled", async () => {
    const target = await wall("serve");
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.pass, false);
    assert.equal(result.error, undefined, result.detail);
    assert.match(result.detail, /declares invalid was served \(HTTP 200\)/);
    assert.match(result.detail, /taken/);
  });

  it("says in one line, before the wait, what it waits for and for how long, with no text from the service", async () => {
    const target = await wall("refuse");
    const lines: string[] = [];
    await run(target.url, { onProgress: (line) => lines.push(line) });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^X402-11: the payment was sent with the request the service must refuse \(HTTP 400\); reading the chain once a ledger until its authorization expires at ledger \d+, for at most 360 s\.$/);
    assert.doesNotMatch(lines[0]!, /invalid request/);
  });

  it("a refusal with another 4xx or a 5xx counts as a refusal", async () => {
    for (const refusalStatus of [422, 500]) {
      const target = await wall("refuse", { refusalStatus });
      const result = byId(await run(target.url), "X402-11");
      assert.equal(result.pass, true, `${refusalStatus}: ${result.detail}`);
      assert.match(result.detail, new RegExp(`HTTP ${refusalStatus}`));
    }
  });
});

describe("X402-11 signs nothing when it cannot reach a verdict", () => {
  it("SKIP without a reject case in the config", async () => {
    const target = await wall("refuse");
    const result = byId(await run(target.url, { reject: undefined }), "X402-11");
    assert.equal(result.skipped, true);
    assert.equal(result.skipKind, "not-applicable");
    assert.match(result.skipReason ?? "", /reject/);
    assert.equal(recorder.signed.length, BEFORE_X402_11);
  });

  it("SKIP when the service refuses the invalid request before asking for payment", async () => {
    const target = await wall("refuse", { refuseUnpaidInvalid: true });
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.skipped, true);
    assert.equal(result.skipKind, "not-applicable");
    assert.match(result.skipReason ?? "", /before any payment is asked \(HTTP 400\)/);
    assert.equal(recorder.signed.length, BEFORE_X402_11);
    assert.equal(target.invalid.length, 0);
  });

  it(`SKIP before signing when the advertised lifetime is above ${REJECTED_REQUEST_MAX_LIFETIME_SECONDS} s`, async () => {
    assert.equal(REJECTED_REQUEST_MAX_LIFETIME_SECONDS, 300);
    const target = await wall("refuse", {}, 301);
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.skipped, true);
    assert.match(result.skipReason ?? "", /301 seconds/);
    assert.match(result.skipReason ?? "", /Nothing was signed/);
    assert.equal(recorder.signed.length, BEFORE_X402_11);
    assert.equal(target.invalid.length, 0);
  });

  it("SKIP before signing when the service raises the lifetime above 300 s on the read it is paid from (review R1)", async () => {
    // The first unpaid read of the reject request says 60 s; the read the
    // payment is signed from says 100000 s.
    const target = await wall("refuse", { invalidUnpaidLifetimes: [60, 100_000] });
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.skipped, true, result.detail);
    assert.match(result.skipReason ?? "", /100000 seconds/);
    assert.match(result.skipReason ?? "", /Nothing was signed/);
    assert.equal(recorder.signed.length, BEFORE_X402_11, "nothing signed for X402-11");
    assert.ok(recorder.signed.every((signed) => signed.maxTimeoutSeconds <= REJECTED_REQUEST_MAX_LIFETIME_SECONDS));
    assert.equal(target.invalid.length, 0, "nothing sent with the invalid request");
  });

  it("not sent when the signed authorization outlives 300 s, whatever the client was asked (review R1)", async () => {
    install({ extraExpiryLedgers: 100 });
    const target = await wall("refuse");
    const result = byId(await run(target.url), "X402-11");
    assert.notEqual(result.pass, true);
    assert.ok(result.error !== undefined, `no verdict expected: ${result.detail}`);
    assert.match(result.error.message, /it was not sent/);
    assert.doesNotMatch(result.error.message, /Nothing was signed/);
    assert.equal(recorder.signed.length, BEFORE_X402_11 + 1, "signed once, then discarded");
    assert.equal(target.invalid.length, 0, "nothing sent with the invalid request");
  });

  it(`SKIP before signing when the advertised lifetime is below ${REJECTED_REQUEST_MIN_LIFETIME_SECONDS} s (screening S-1)`, async () => {
    assert.equal(REJECTED_REQUEST_MIN_LIFETIME_SECONDS, 30);
    const target = await wall("refuse", {}, 29);
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.skipped, true, result.detail);
    assert.match(result.skipReason ?? "", /29 seconds/);
    assert.match(result.skipReason ?? "", /shorter than the 30 seconds/);
    assert.match(result.skipReason ?? "", /Nothing was signed/);
    assert.equal(recorder.signed.length, BEFORE_X402_11);
    assert.equal(target.invalid.length, 0);
  });

  it("a lifetime of exactly 30 s is waited out", async () => {
    const target = await wall("refuse", {}, 30);
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.pass, true, result.detail);
    assert.equal(recorder.signed.at(-1)!.maxTimeoutSeconds, 30);
  });

  it("SKIP before signing when the service lowers the lifetime below 30 s on the read it is paid from (screening S-1)", async () => {
    const target = await wall("refuse", { invalidUnpaidLifetimes: [60, 10] });
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.skipped, true, result.detail);
    assert.match(result.skipReason ?? "", /10 seconds/);
    assert.match(result.skipReason ?? "", /Nothing was signed/);
    assert.equal(recorder.signed.length, BEFORE_X402_11);
    assert.equal(target.invalid.length, 0);
  });

  it("not sent when fewer than 3 ledgers of validity are left right before sending (screening S-1)", async () => {
    install({ extraExpiryLedgers: -10 });
    const target = await wall("refuse");
    const result = byId(await run(target.url), "X402-11");
    assert.notEqual(result.pass, true);
    assert.ok(result.error !== undefined, `no verdict expected: ${result.detail}`);
    assert.match(result.error.message, /too soon/);
    assert.match(result.error.message, /it was not sent/);
    assert.equal(recorder.signed.length, BEFORE_X402_11 + 1, "signed once, then discarded");
    assert.equal(target.invalid.length, 0);
  });

  it("a lifetime of exactly 300 s is waited out", async () => {
    const target = await wall("refuse", {}, 300);
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.pass, true, result.detail);
    assert.equal(recorder.signed.at(-1)!.maxTimeoutSeconds, 300);
  });

  it("SKIP on a chain X402-11 cannot read, without making the endpoint unsupported", async () => {
    install({ withoutWatch: true });
    const target = await wall("refuse");
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.skipped, true);
    assert.notEqual(result.skipKind, "unsupported");
    assert.equal(recorder.signed.length, BEFORE_X402_11);
  });

  it("SKIP when X402-06 did not pass: its nonce cannot be the control", async () => {
    install({ settlementFails: true });
    const target = await wall("refuse");
    const results = await run(target.url);
    assert.equal(byId(results, "X402-06").pass, false);
    const result = byId(results, "X402-11");
    assert.equal(result.skipped, true);
    assert.equal(result.skipKind, "dependency");
    assert.equal(recorder.signed.length, BEFORE_X402_11);
  });

  it("no verdict, nothing signed, when the chain does not return X402-06's used nonce before signing", async () => {
    ledger.hidden.add("nonce-1");
    const target = await wall("refuse");
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.error?.kind, "setup", result.detail);
    assert.match(result.detail, /X402-06/);
    assert.match(result.detail, /Nothing was signed/);
    assert.equal(recorder.signed.length, BEFORE_X402_11);
    assert.equal(target.invalid.length, 0);
  });

  it("no verdict, nothing signed, when the payer's balance cannot be read before signing", async () => {
    ledger.balanceUnreadable = true;
    const target = await wall("refuse");
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.error?.kind, "setup", result.detail);
    assert.match(result.detail, /balance/);
    assert.equal(recorder.signed.length, BEFORE_X402_11);
  });

  it("refused by L2 when the plan has no signature for X402-11", async () => {
    const target = await wall("refuse");
    const plan = await planX402Run({ network: NETWORK, endpoints: [{ name: "paid", target: target.url }] });
    const entry = plan.endpoints[0]!;
    assert.ok(!entry.signatures.some((signature) => signature.check === "X402-11"));
    const result = byId(await run(target.url, { plan: entry }), "X402-11");
    assert.equal(result.error?.kind, "setup", result.detail);
    assert.match(result.detail, /plan/);
    assert.equal(recorder.signed.length, BEFORE_X402_11);
  });
});

describe("X402-11 does not send a payment it cannot tell apart (review R6)", () => {
  const X402_11 = BEFORE_X402_11 + 1;

  it("not sent when its authorization carries X402-06's nonce (K3)", async () => {
    install({ alterPayload: (count) => (count === X402_11 ? { nonce: "nonce-1" } : undefined) });
    const target = await wall("refuse");
    const result = byId(await run(target.url), "X402-11");
    assert.match(result.error?.message ?? "", /carries X402-06's nonce/, result.detail);
    assert.equal(target.invalid.length, 0);
  });

  it("not sent when the chain records its authorization as used before it was sent (K4)", async () => {
    install({ alterPayload: (count) => (count === X402_11 ? { nonce: "nonce-early" } : undefined) });
    ledger.used.set("nonce-early", 999);
    const target = await wall("refuse");
    const result = byId(await run(target.url), "X402-11");
    assert.match(result.error?.message ?? "", /used before it was sent/, result.detail);
    assert.equal(target.invalid.length, 0);
  });

  it("not sent when the read right before sending leaves out X402-06's authorization (K5)", async () => {
    // Read 1 is before signing and finds the control; read 2, right before sending, does not.
    ledger.onRead = (reads) => {
      if (reads === 2) ledger.hidden.add("nonce-1");
    };
    const target = await wall("refuse");
    const result = byId(await run(target.url), "X402-11");
    assert.match(result.error?.message ?? "", /leaves out X402-06's authorization, so this payment was not sent/, result.detail);
    assert.equal(target.invalid.length, 0);
  });

  it("not sent when its authorization is signed by another address than the run's payer (K15)", async () => {
    install({ alterPayload: (count) => (count === X402_11 ? { payer: "GANOTHERPAYER" } : undefined) });
    const target = await wall("refuse");
    const result = byId(await run(target.url), "X402-11");
    assert.match(result.error?.message ?? "", /signed by another address than this run's payer/, result.detail);
    assert.equal(target.invalid.length, 0);
  });
});

describe("X402-11 gives no verdict when the chain readings disagree or stop", () => {
  it("the nonce is used but no transfer of the price to payTo was recorded", async () => {
    ledger.dropTransfers = true;
    const target = await wall("settle-then-refuse");
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.error?.kind, "setup", result.detail);
    assert.match(result.detail, /disagree/);
  });

  it("the nonce stays unused, but the payer's balance fell by the price during the watch", async () => {
    const target = await wall("refuse");
    let dropped = false;
    ledger.onRead = () => {
      // After X402-11's payment is sent (its first watch read), money leaves the payer some other way.
      if (target.invalid.length === 1 && !dropped) {
        dropped = true;
        ledger.balance -= 10000n;
      }
    };
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.error?.kind, "setup", result.detail);
    assert.match(result.detail, /disagree/);
  });

  it("the nonce stays unused, but a transfer of the price to payTo was recorded after the payment was sent", async () => {
    const target = await wall("refuse");
    let pushed = false;
    ledger.onRead = () => {
      if (target.invalid.length === 1 && !pushed) {
        pushed = true;
        ledger.transfers.push({ amount: 10000n, reference: "tx-other", ledger: ledger.latest + 1, asset: option({ amount: "1" }).asset, from: "0x2222222222222222222222222222222222222222", to: PAY_TO });
        ledger.balance -= 10000n;
      }
    };
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.error?.kind, "setup", result.detail);
    assert.match(result.detail, /disagree/);
  });

  it("a late settlement of X402-09's half-price payment during the watch is not this payment: still a PASS", async () => {
    const target = await wall("refuse");
    let pushed = false;
    ledger.onRead = () => {
      if (target.invalid.length === 1 && !pushed) {
        pushed = true;
        ledger.transfers.push({ amount: 5000n, reference: "tx-half", ledger: ledger.latest + 1, asset: option({ amount: "1" }).asset, from: "0x2222222222222222222222222222222222222222", to: PAY_TO });
        ledger.balance -= 5000n;
      }
    };
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.pass, true, result.detail);
  });

  it("a transfer of the same amount after the last ledger the watch read is not this payment: still a PASS", async () => {
    const target = await wall("refuse");
    let pushed = false;
    ledger.onRead = () => {
      if (target.invalid.length === 1 && !pushed) {
        pushed = true;
        // Another run with the same payer, recorded far past this watch.
        ledger.transfers.push({ amount: 10000n, reference: "tx-later", ledger: 999_999, asset: option({ amount: "1" }).asset, from: "0x2222222222222222222222222222222222222222", to: PAY_TO });
      }
    };
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.pass, true, result.detail);
  });

  it("the chain's answer leaves out X402-06's nonce during the watch: no verdict, never PASS", async () => {
    const target = await wall("refuse");
    ledger.onRead = () => {
      if (target.invalid.length === 1) ledger.hidden.add("nonce-1");
    };
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.error?.kind, "setup", result.detail);
    assert.match(result.detail, /X402-06/);
  });

  it("the chain cannot be read during the watch: no verdict on a refused request", async () => {
    const target = await wall("refuse");
    ledger.onRead = () => {
      if (target.invalid.length === 1) ledger.readError = new Error("rpc down");
    };
    const result = byId(await run(target.url), "X402-11");
    assert.notEqual(result.error, undefined, result.detail);
    assert.equal(result.pass, false);
  });

  it("the chain's transfers cannot be read: a served request is still a FAIL, and says the settlement was not read", async () => {
    ledger.transferError = new Error("events not served");
    const target = await wall("serve");
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.pass, false);
    assert.equal(result.error, undefined, result.detail);
    assert.match(result.detail, /served/);
    assert.match(result.detail, /not read/);
  });

  it("SKIP when the authorization is still valid at the hard stop", async () => {
    setRejectedRequestHardStopForTesting(60);
    ledger.step = 0;
    const target = await wall("refuse");
    const result = byId(await run(target.url), "X402-11");
    assert.equal(result.skipped, true, result.detail);
    assert.match(result.skipReason ?? "", /still valid until ledger \d+/);
  });

  it(`the hard stop is ${REJECTED_REQUEST_HARD_STOP_MS / 1000} s, and a test cannot raise it`, () => {
    assert.equal(REJECTED_REQUEST_HARD_STOP_MS, 360_000);
    assert.equal(rejectedRequestHardStopMs(), 360_000);
    setRejectedRequestHardStopForTesting(10 * 60_000);
    assert.equal(rejectedRequestHardStopMs(), 360_000);
    setRejectedRequestHardStopForTesting(5);
    assert.equal(rejectedRequestHardStopMs(), 5);
  });
});

describe("watchAuthorization", () => {
  const ours = { payer: "P", nonce: "2", expiresAt: 1010 };
  const control = { payer: "P", nonce: "1", expiresAt: 990 };

  /** A watch whose reads answer from `latests` in turn, ours never used, the control always found. */
  function scripted(latests: number[], used: (latest: number) => number | undefined = () => undefined) {
    let index = 0;
    const reads: number[] = [];
    return {
      reads,
      watch: {
        unit: "ledger",
        unitMs: 1,
        unitSeconds: 5,
        decode: () => ours,
        async read() {
          const latest = latests[Math.min(index, latests.length - 1)]!;
          index += 1;
          reads.push(latest);
          return { latest, used: [used(latest), 995] };
        },
        async transfers() {
          return { latest: 0, transfers: [] };
        },
      },
    };
  }

  it("needs a read ABOVE the expiration ledger: at the expiration ledger it keeps reading", async () => {
    const { watch, reads } = scripted([1009, 1010, 1011]);
    const outcome = await watchAuthorization({ watch, network: NETWORK, rpcUrl: "x", ours, control, sentAt: Date.now() });
    assert.deepEqual(outcome, { kind: "unused", latest: 1011 });
    assert.deepEqual(reads, [1009, 1010, 1011]);
  });

  it("ends as unread at the hard stop when a read never answers (review R5)", { timeout: 5000 }, async () => {
    setRejectedRequestHardStopForTesting(200);
    const watch = {
      unit: "ledger",
      unitMs: 1,
      unitSeconds: 5,
      decode: () => ours,
      read: () => new Promise<never>(() => undefined),
      async transfers() {
        return { latest: 0, transfers: [] };
      },
    };
    const started = Date.now();
    const outcome = await watchAuthorization({ watch, network: NETWORK, rpcUrl: "x", ours, control, sentAt: started });
    assert.equal(outcome.kind, "unread");
    assert.match(outcome.kind === "unread" ? outcome.why : "", /did not answer/);
    assert.ok(Date.now() - started < 2000, "the watch waited past its hard stop for a read");
  });

  it("stops at once when the authorization is found used", async () => {
    const { watch, reads } = scripted([1003, 1004], (latest) => (latest === 1004 ? 1004 : undefined));
    const outcome = await watchAuthorization({ watch, network: NETWORK, rpcUrl: "x", ours, control, sentAt: Date.now() });
    assert.deepEqual(outcome, { kind: "used", ledger: 1004, latest: 1004 });
    assert.equal(reads.length, 2);
  });

  it("counts the hard stop from when the payment was sent", async () => {
    setRejectedRequestHardStopForTesting(1000);
    const { watch } = scripted([1003]);
    let now = 10_000;
    const outcome = await watchAuthorization({
      watch,
      network: NETWORK,
      rpcUrl: "x",
      ours,
      control,
      sentAt: 9_500,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    assert.deepEqual(outcome, { kind: "still-valid", latest: 1003 });
    assert.ok(now >= 10_500 && now <= 10_501, String(now));
  });
});

describe("the reject request", () => {
  it("is the endpoint's request with the reject case over it: method, headers merged, body replaced", () => {
    const shape = rejectRequestShape(
      { method: "POST", headers: { "x-tenant": "demo" }, body: '{"text":"hello"}' },
      { headers: { "x-lang": "xx" }, body: '{"text":""}' },
    );
    assert.deepEqual(shape, { method: "POST", headers: { "x-tenant": "demo", "x-lang": "xx" }, body: '{"text":""}' });
  });

  it("keeps the endpoint's body when the reject case changes only a header", () => {
    const shape = rejectRequestShape({ method: "POST", body: '{"text":"hello"}' }, { headers: { "x-lang": "xx" } });
    assert.equal(shape.body, '{"text":"hello"}');
  });

  it("drops the endpoint's body when the reject case asks for a method without one", () => {
    const shape = rejectRequestShape({ method: "POST", body: '{"text":"hello"}' }, { method: "GET", headers: {} });
    assert.equal(shape.method, "GET");
    assert.equal(shape.body, undefined);
  });

  it("is what reaches the service: the reject body and the endpoint's own headers", async () => {
    const target = await wall("refuse");
    await run(target.url, {
      method: "POST",
      headers: { "x-tenant": "demo" },
      body: '{"text":"hello"}',
      reject: { headers: { "x-invalid": "1" }, body: '{"text":""}' },
    });
    assert.equal(target.invalid.length, 1);
    assert.equal(target.invalid[0]!.method, "POST");
    assert.equal(target.invalid[0]!.body, '{"text":""}');
    assert.equal(target.invalid[0]!.headers["x-tenant"], "demo");
  });
});

describe("the plan (L1) counts X402-11", () => {
  it("plans one more signature at the price when the endpoint has a reject case", async () => {
    const target = await wall("refuse");
    const plan = await planX402Run({
      network: NETWORK,
      endpoints: [
        { name: "with", target: target.url, reject: REJECT },
        { name: "without", target: target.url },
      ],
    });
    const [withReject, without] = plan.endpoints;
    assert.deepEqual(
      withReject!.signatures.map((signature) => [signature.check, signature.amount]),
      [["X402-06", 10000n], ["X402-07", 10000n], ["X402-09", 5000n], ["X402-10", 10000n], ["X402-11", 10000n]],
    );
    assert.equal(withReject!.worstCase, 45000n);
    assert.equal(without!.worstCase, 35000n);
  });

  it("does not plan it when the lifetime is above 300 s, or on a chain X402-11 cannot read", async () => {
    const long = await wall("refuse", {}, 301);
    const longPlan = await planX402Run({ network: NETWORK, endpoints: [{ name: "long", target: long.url, reject: REJECT }] });
    assert.ok(!longPlan.endpoints[0]!.signatures.some((signature) => signature.check === "X402-11"));

    const short = await wall("refuse", {}, 29);
    const shortPlan = await planX402Run({ network: NETWORK, endpoints: [{ name: "short", target: short.url, reject: REJECT }] });
    assert.ok(!shortPlan.endpoints[0]!.signatures.some((signature) => signature.check === "X402-11"), "planned below 30 s");

    install({ withoutWatch: true });
    const target = await wall("refuse");
    const plan = await planX402Run({ network: NETWORK, endpoints: [{ name: "paid", target: target.url, reject: REJECT }] });
    assert.ok(!plan.endpoints[0]!.signatures.some((signature) => signature.check === "X402-11"));
  });

  it("a $1 price with a reject case plans $4.50, within the $5 cap", async () => {
    const target = await rejectPaywall(ledger, [option({ amount: "1000000" })], { mode: "refuse" });
    walls.push(target);
    const plan = await planX402Run({ network: NETWORK, endpoints: [{ name: "paid", target: target.url, reject: REJECT }] });
    assert.equal(plan.endpoints[0]!.worstCase, 4_500_000n);
    assert.equal(plan.refusal, undefined);
  });

  it("with the plan, a full run signs exactly what was planned", async () => {
    const target = await wall("refuse");
    const plan = await planX402Run({ network: NETWORK, endpoints: [{ name: "paid", target: target.url, reject: REJECT }] });
    const entry = plan.endpoints[0]!;
    const result = byId(await run(target.url, { plan: entry }), "X402-11");
    assert.equal(result.pass, true, result.detail);
    const total = recorder.signed.reduce((sum, requirement) => sum + BigInt(requirement.amount), 0n);
    assert.equal(total, entry.worstCase);
  });
});

describe("rejectedRequestVerdict", () => {
  const base = { amount: 10000n, expiresAt: 1012, unit: "ledger" } as const;
  const agreeNotTaken = { balance: { before: 50000n, after: 50000n }, transfers: [] };
  const agreeTaken = { balance: { before: 50000n, after: 40000n }, transfers: [{ reference: "tx-a", ledger: 1003 }] };

  it("PASS: refused, unused past the expiry, readings agree", () => {
    const result = rejectedRequestVerdict({ ...base, status: 400, watch: { kind: "unused", latest: 1013 }, ...agreeNotTaken });
    assert.equal(result.pass, true);
    assert.equal(result.id, "X402-11");
    assert.equal(result.name, "Rejected Request Not Settled");
  });

  it("FAIL: refused, used, readings agree; the transaction is named", () => {
    const result = rejectedRequestVerdict({ ...base, status: 402, reason: "invalid", watch: { kind: "used", ledger: 1003, latest: 1004 }, ...agreeTaken });
    assert.equal(result.pass, false);
    assert.equal(result.error, undefined);
    assert.match(result.detail, /tx-a/);
    assert.match(result.detail, /HTTP 402: invalid/);
  });

  it("no verdict: used, but the balance did not fall by the price", () => {
    const result = rejectedRequestVerdict({
      ...base,
      status: 400,
      watch: { kind: "used", ledger: 1003, latest: 1004 },
      balance: { before: 50000n, after: 45000n },
      transfers: [{ reference: "tx-a", ledger: 1003 }],
    });
    assert.equal(result.error?.kind, "setup");
  });

  it("no verdict: unused, but a transfer of the price was recorded", () => {
    const result = rejectedRequestVerdict({
      ...base,
      status: 400,
      watch: { kind: "unused", latest: 1013 },
      balance: { before: 50000n, after: 50000n },
      transfers: [{ reference: "tx-b", ledger: 1005 }],
    });
    assert.equal(result.error?.kind, "setup");
  });

  it("no verdict: a refused request whose chain read did not finish", () => {
    const result = rejectedRequestVerdict({ ...base, status: 400, watch: { kind: "unread", why: "rpc down" } });
    assert.equal(result.error?.kind, "setup");
    assert.match(result.detail, /rpc down/);
  });

  it("no verdict: the second readings are missing", () => {
    const result = rejectedRequestVerdict({ ...base, status: 400, watch: { kind: "unused", latest: 1013 } });
    assert.equal(result.error?.kind, "setup");
  });

  it("SKIP: refused and still valid when the watch stopped", () => {
    const result = rejectedRequestVerdict({ ...base, status: 400, watch: { kind: "still-valid", latest: 1005 } });
    assert.equal(result.skipped, true);
    assert.match(result.skipReason ?? "", /not settled by ledger 1005; still valid until ledger 1012/);
  });

  it("FAIL whenever the invalid request was served, whatever the chain shows", () => {
    for (const watch of [
      { kind: "used", ledger: 1003, latest: 1004 },
      { kind: "unused", latest: 1013 },
      { kind: "still-valid", latest: 1005 },
      { kind: "unread", why: "rpc down" },
    ] as const) {
      const result = rejectedRequestVerdict({ ...base, status: 200, watch, ...(watch.kind === "used" ? agreeTaken : agreeNotTaken) });
      assert.equal(result.pass, false, watch.kind);
      assert.equal(result.error, undefined, watch.kind);
      assert.equal(result.skipped, undefined, watch.kind);
      assert.match(result.detail, /served \(HTTP 200\)/);
    }
  });
});

describe("X402-06's reference, for the payment proof of the PR comment (2026-11-20)", () => {
  it("carries the settlement it read back from the chain on a PASS, and none on a FAIL", async () => {
    const target = await wall("refuse");
    const honest = byId(await run(target.url), "X402-06");
    assert.equal(honest.pass, true, honest.detail);
    assert.equal(honest.reference, "tx-nonce-1");
    install({ settlementFails: true });
    const other = await wall("refuse");
    const failed = byId(await run(other.url), "X402-06");
    assert.equal(failed.pass, false, failed.detail);
    assert.equal(failed.reference, undefined);
  });
});
