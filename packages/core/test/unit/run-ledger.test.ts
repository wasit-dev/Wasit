/**
 * The run ledger (spec B5, safety rule 6), written before the code (B11): a
 * file a paying run keeps beside it, so that a person can compare what Wasit
 * signed with what the chain shows, even after a crash.
 *
 * - One file per run, `wasit-ledger-<UTC time>.json`, created new (never
 *   overwritten), valid JSON after every write (written whole to a temporary
 *   file, flushed, then renamed over the ledger).
 * - One entry per signature: "intent" first, written before the signature;
 *   then signed (with the ledger it expires at), not signed, or unknown; then
 *   discarded, or sent with the answer's status; the settlement if any.
 * - Balances before and after, and whether they are consistent with what the
 *   ledger says settled.
 * - No secret: free text is cut, and anything shaped like a Stellar secret or
 *   a 64-hex value in it is masked.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { Address, Keypair, Networks, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import { CheckSetupError } from "../../src/errors.js";
import {
  RUN_LEDGER_FORMAT,
  RunLedger,
  RunLedgerError,
  ledgerConsistency,
  openAuthorizationsUntil,
  runLedgerFileName,
  type LedgerEntry,
  type RunLedgerHeader,
} from "../../src/guard/run-ledger.js";
import { expirationOfSigned } from "../../src/guard/signed-terms.js";

const PAYER = Keypair.random().publicKey();
const PAY_TO = Keypair.random().publicKey();
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "wasit-ledger-test-"));
  dirs.push(dir);
  return dir;
}

const header: RunLedgerHeader = {
  versions: { core: "0.8.0-test", cli: "0.8.0-test" },
  environment: "mainnet",
  network: "stellar:pubnet",
  payer: PAYER,
  pin: { payTo: PAY_TO, asset: USDC },
  caps: { perPaymentUsd: "$1.00", runUsd: "$5.00" },
  plan: { worstCaseUsd: "$0.045", endpoints: [{ name: "weather", signatures: [{ check: "X402-06", amount: 100_000n }] }] },
  rpc: "https://rpc.example",
};

let clock = Date.parse("2026-11-21T11:01:29.123Z");
const now = (): Date => new Date((clock += 1000));

function onDisk(ledger: RunLedger): Record<string, unknown> {
  return JSON.parse(readFileSync(ledger.path, "utf-8")) as Record<string, unknown>;
}

function entriesOnDisk(ledger: RunLedger): LedgerEntry[] {
  return onDisk(ledger)["entries"] as LedgerEntry[];
}

const intent = { check: "X402-06", network: "stellar:pubnet", asset: USDC, payTo: PAY_TO, amount: "100000" };

describe("the run ledger's file", () => {
  it("is named after the run's start in UTC, with no character a file system refuses", () => {
    assert.equal(runLedgerFileName(new Date("2026-11-21T11:01:29.123Z")), "wasit-ledger-2026-11-21T11-01-29.123Z.json");
  });

  it("is created in its folder, made if missing, and holds the header from the start", () => {
    const dir = join(folder(), "ledgers", "run");
    const ledger = RunLedger.create(dir, header, { now });
    assert.ok(ledger.path.startsWith(dir));
    const doc = onDisk(ledger);
    assert.equal(doc["format"], RUN_LEDGER_FORMAT);
    assert.equal(doc["version"], 1);
    assert.equal(doc["payer"], PAYER);
    assert.equal(doc["network"], "stellar:pubnet");
    assert.deepEqual(doc["pin"], { payTo: PAY_TO, asset: USDC });
    assert.equal(doc["rpc"], "https://rpc.example");
    assert.deepEqual(doc["entries"], []);
    assert.equal(doc["result"], "open");
    // bigints of the plan are written as strings.
    assert.match(JSON.stringify(doc["plan"]), /"amount":"100000"/);
  });

  it("is never overwritten: a second ledger with the same name is refused", () => {
    const dir = folder();
    const fixed = (): Date => new Date("2026-11-21T11:01:29.123Z");
    const first = RunLedger.create(dir, header, { now: fixed });
    first.forEndpoint("weather").intent(intent);
    assert.throws(() => RunLedger.create(dir, header, { now: fixed }), RunLedgerError);
    assert.equal(entriesOnDisk(first).length, 1, "the first ledger is untouched");
  });

  it("refuses an RPC that is not given as an origin, so no path or key of it is written", () => {
    assert.throws(() => RunLedger.create(folder(), { ...header, rpc: "https://rpc.example/v1/SECRETKEY" }, { now }), RunLedgerError);
  });

  it("is valid JSON after every write, and leaves no temporary file", () => {
    const dir = folder();
    const ledger = RunLedger.create(dir, header, { now });
    const entry = ledger.forEndpoint("weather").intent(intent);
    JSON.parse(readFileSync(ledger.path, "utf-8"));
    entry.signed(65_594_600);
    JSON.parse(readFileSync(ledger.path, "utf-8"));
    entry.sent({ status: 200 });
    entry.settled("a".repeat(64), true);
    ledger.close({ after: { usdc: 0n, native: 0n }, source: "test" });
    JSON.parse(readFileSync(ledger.path, "utf-8"));
    assert.deepEqual(readdirSync(dir), [ledger.path.slice(dir.length + 1)]);
  });

  it("refuses to record an intent it cannot write, so the caller signs nothing", () => {
    const dir = folder();
    const ledger = RunLedger.create(dir, header, { now });
    rmSync(dir, { recursive: true, force: true });
    assert.throws(() => ledger.forEndpoint("weather").intent(intent), (error: unknown) => {
      assert.ok(error instanceof RunLedgerError);
      assert.ok(error instanceof CheckSetupError, "a ledger that cannot be written is a setup error: no verdict");
      assert.match(error.message, /Nothing was signed\./);
      return true;
    });
  });
});

describe("one entry per signature", () => {
  it("starts as an intent, on disk before the call returns", () => {
    const ledger = RunLedger.create(folder(), header, { now });
    ledger.forEndpoint("weather").intent(intent);
    const [entry] = entriesOnDisk(ledger);
    assert.equal(entry!.state, "intent");
    assert.equal(entry!.id, 1);
    assert.equal(entry!.endpoint, "weather");
    assert.equal(entry!.check, "X402-06");
    assert.equal(entry!.amount, "100000");
    assert.equal(entry!.payTo, PAY_TO);
    assert.equal(entry!.asset, USDC);
    assert.equal(typeof entry!.intentAt, "string");
  });

  it("records the signature with the ledger it expires at, then what was sent and what settled", () => {
    const ledger = RunLedger.create(folder(), header, { now });
    const handle = ledger.forEndpoint("weather").intent(intent);
    handle.signed(65_594_600);
    handle.sent({ status: 200 });
    handle.settled("b".repeat(64), true);
    const [entry] = entriesOnDisk(ledger);
    assert.equal(entry!.state, "signed");
    assert.equal(entry!.expiresAtLedger, 65_594_600);
    assert.equal(entry!.sent?.status, 200);
    assert.deepEqual(entry!.settlement, { reference: "b".repeat(64), verified: true });
  });

  it("records a signature whose expiry could not be read as such", () => {
    const ledger = RunLedger.create(folder(), header, { now });
    ledger.forEndpoint("weather").intent(intent).signed(undefined);
    assert.equal(entriesOnDisk(ledger)[0]!.expiresAtLedger, null);
  });

  it("records not signed, unknown, discarded and an error on sending", () => {
    const ledger = RunLedger.create(folder(), header, { now });
    const endpoint = ledger.forEndpoint("weather");
    endpoint.intent({ ...intent, check: "X402-07" }).notSigned("The signed-terms gate refused it.");
    endpoint.intent({ ...intent, check: "X402-09" }).unknown("The client failed while building the payment.");
    const discarded = endpoint.intent({ ...intent, check: "X402-10" });
    discarded.signed(65_594_570);
    discarded.discarded("The payload names other terms.");
    const failed = endpoint.intent({ ...intent, check: "X402-11" });
    failed.signed(65_594_660);
    failed.sent({ error: "no answer" });
    const [a, b, c, d] = entriesOnDisk(ledger);
    assert.equal(a!.state, "not-signed");
    assert.match(a!.note ?? "", /gate refused/);
    assert.equal(b!.state, "unknown");
    assert.equal(c!.state, "signed");
    assert.match(c!.discarded ?? "", /other terms/);
    assert.equal(c!.sent, undefined);
    assert.equal(d!.sent?.error, "no answer");
    assert.deepEqual(entriesOnDisk(ledger).map((entry) => entry.id), [1, 2, 3, 4]);
  });

  it("refuses an entry that is not a whole positive amount, or a second outcome", () => {
    const ledger = RunLedger.create(folder(), header, { now });
    const endpoint = ledger.forEndpoint("weather");
    assert.throws(() => endpoint.intent({ ...intent, amount: "-1" }), RunLedgerError);
    assert.throws(() => endpoint.intent({ ...intent, amount: "1.5" }), RunLedgerError);
    const handle = endpoint.intent(intent);
    handle.notSigned("refused");
    assert.throws(() => handle.signed(1), RunLedgerError);
  });

  it("refuses a send or a discard without a signature, and a second one", () => {
    const ledger = RunLedger.create(folder(), header, { now });
    const endpoint = ledger.forEndpoint("weather");
    const refused = endpoint.intent(intent);
    refused.notSigned("refused");
    assert.throws(() => refused.sent({ status: 200 }), RunLedgerError);
    assert.throws(() => refused.discarded("x"), RunLedgerError);
    const sent = endpoint.intent(intent);
    sent.signed(1);
    sent.sent({ status: 402 });
    assert.throws(() => sent.sent({ status: 200 }), RunLedgerError);
    assert.throws(() => sent.discarded("x"), RunLedgerError);
    const discarded = endpoint.intent(intent);
    discarded.signed(1);
    discarded.discarded("x");
    assert.throws(() => discarded.discarded("y"), RunLedgerError);
    assert.throws(() => discarded.sent({ status: 200 }), RunLedgerError);
  });

  it("keeps no trace of an intent it could not write: the next one is entry 1", () => {
    const dir = folder();
    const ledger = RunLedger.create(dir, header, { now });
    rmSync(dir, { recursive: true, force: true });
    assert.throws(() => ledger.forEndpoint("weather").intent(intent), RunLedgerError);
    mkdirSync(dir, { recursive: true });
    ledger.forEndpoint("weather").intent({ ...intent, check: "X402-07" });
    assert.deepEqual(entriesOnDisk(ledger).map((entry) => [entry.id, entry.check]), [[1, "X402-07"]]);
  });

  it("masks anything shaped like a secret in free text, and cuts it", () => {
    const ledger = RunLedger.create(folder(), header, { now });
    const secret = Keypair.random().secret();
    const hex = "c".repeat(64);
    ledger.forEndpoint("weather").intent(intent).notSigned(`an error naming ${secret} and ${hex} ${"x".repeat(1000)}`);
    const raw = readFileSync(ledger.path, "utf-8");
    assert.ok(!raw.includes(secret));
    assert.ok(!raw.includes(hex));
    assert.ok((entriesOnDisk(ledger)[0]!.note ?? "").length <= 300);
  });
});

describe("balances and the ledger's result", () => {
  const entry = (overrides: Partial<LedgerEntry>): LedgerEntry => ({
    id: 1,
    endpoint: "weather",
    check: "X402-06",
    network: "stellar:pubnet",
    asset: USDC,
    payTo: PAY_TO,
    amount: "100000",
    intentAt: "2026-11-21T11:01:30.123Z",
    state: "signed",
    expiresAtLedger: 65_594_600,
    ...overrides,
  });

  it("is consistent when the payer's USDC went down by exactly the verified settlements, and its XLM did not move", () => {
    const result = ledgerConsistency(
      { usdc: 1_000_000n, native: 50_000_000n },
      { usdc: 900_000n, native: 50_000_000n },
      [entry({ settlement: { reference: "d".repeat(64), verified: true } }), entry({ id: 2, check: "X402-07" })],
    );
    assert.equal(result.consistent, true, result.reasons.join("; "));
    assert.equal(result.spentUsdc, 100_000n);
    assert.equal(result.settledUsdc, 100_000n);
  });

  it("is inconsistent when more left the account than the ledger shows settled, or less", () => {
    const more = ledgerConsistency({ usdc: 1_000_000n, native: 1n }, { usdc: 850_000n, native: 1n }, [
      entry({ settlement: { reference: "d".repeat(64), verified: true } }),
    ]);
    assert.equal(more.consistent, false);
    assert.match(more.reasons.join(" "), /150000/);
    const less = ledgerConsistency({ usdc: 1_000_000n, native: 1n }, { usdc: 1_000_000n, native: 1n }, [
      entry({ settlement: { reference: "d".repeat(64), verified: true } }),
    ]);
    assert.equal(less.consistent, false);
    // A settlement the run could not verify on chain is not counted as settled.
    const unverified = ledgerConsistency({ usdc: 1_000_000n, native: 1n }, { usdc: 900_000n, native: 1n }, [
      entry({ settlement: { reference: "d".repeat(64), verified: false } }),
    ]);
    assert.equal(unverified.consistent, false);
    assert.equal(unverified.settledUsdc, 0n);
  });

  it("is inconsistent when the payer's XLM moved: Wasit sends no transaction from the payer", () => {
    const result = ledgerConsistency({ usdc: 1n, native: 50_000_000n }, { usdc: 1n, native: 49_999_900n }, []);
    assert.equal(result.consistent, false);
    assert.match(result.reasons.join(" "), /XLM/);
  });

  it("is inconsistent when either reading is missing", () => {
    assert.equal(ledgerConsistency(undefined, { usdc: 1n, native: 1n }, []).consistent, false);
    assert.equal(ledgerConsistency({ usdc: 1n, native: 1n }, undefined, []).consistent, false);
  });

  it("names entries with no outcome, read as signed", () => {
    const result = ledgerConsistency({ usdc: 1n, native: 1n }, { usdc: 1n, native: 1n }, [entry({ state: "intent", expiresAtLedger: undefined })]);
    assert.match(result.reasons.join(" "), /X402-06.*assume/);
  });

  it("is written with the balances on close", () => {
    const ledger = RunLedger.create(folder(), header, { now });
    ledger.recordBalancesBefore({ usdc: 1_000_000n, native: 50_000_000n }, "rpc and horizon");
    const handle = ledger.forEndpoint("weather").intent(intent);
    handle.signed(65_594_600);
    handle.sent({ status: 200 });
    handle.settled("e".repeat(64), true);
    const result = ledger.close({ after: { usdc: 900_000n, native: 50_000_000n }, source: "horizon" });
    assert.equal(result.consistent, true);
    const doc = onDisk(ledger);
    assert.deepEqual(doc["balancesBefore"], { usdc: "1000000", native: "50000000", source: "rpc and horizon", at: (doc["balancesBefore"] as { at: string }).at });
    assert.equal((doc["balancesAfter"] as { usdc: string }).usdc, "900000");
    assert.equal(doc["result"], "consistent");
    assert.equal(typeof doc["closedAt"], "string");
    assert.throws(() => ledger.forEndpoint("weather").intent(intent), RunLedgerError, "a closed ledger takes no entry");
    assert.throws(() => ledger.close({ after: { usdc: 0n, native: 0n } }), RunLedgerError, "a ledger is closed once");
    assert.equal(onDisk(ledger)["result"], "consistent", "a second close changes nothing");
  });
});

describe("a gap the checks that FAILed explain", () => {
  const entry = (overrides: Partial<LedgerEntry>): LedgerEntry => ({
    id: 1,
    endpoint: "weather",
    check: "X402-06",
    network: "stellar:pubnet",
    asset: USDC,
    payTo: PAY_TO,
    amount: "100000",
    intentAt: "2026-11-22T11:01:30.123Z",
    state: "signed",
    expiresAtLedger: 65_594_600,
    sent: { at: "2026-11-22T11:01:31.000Z", status: 200 },
    ...overrides,
  });
  const verified = { reference: "d".repeat(64), verified: true };
  const before = { usdc: 1_000_000n, native: 50_000_000n };
  const after = (usdc: bigint, native = 50_000_000n) => ({ usdc, native });
  /** A lax service, price 0.01: X402-06 settled and verified; X402-09 (half) and X402-11 settled, not verified, both FAIL. */
  const lax = (overrides: { readonly nine?: Partial<LedgerEntry>; readonly eleven?: Partial<LedgerEntry> } = {}): LedgerEntry[] => [
    entry({ settlement: verified, verdict: "pass" }),
    entry({ id: 2, check: "X402-07", verdict: "pass", sent: { at: "t", status: 402 } }),
    entry({ id: 3, check: "X402-09", amount: "50000", verdict: "fail", ...overrides.nine }),
    entry({ id: 4, check: "X402-10", verdict: "pass", sent: { at: "t", status: 402 } }),
    entry({ id: 5, check: "X402-11", verdict: "fail", ...overrides.eleven }),
  ];

  it("is explained when the USDC above the verified settlements is within the payments of checks that FAILed", () => {
    const result = ledgerConsistency(before, after(750_000n), lax());
    assert.equal(result.result, "explained", result.reasons.join("; "));
    assert.equal(result.consistent, false, "explained is not consistent");
    assert.equal(result.spentUsdc, 250_000n);
    assert.equal(result.settledUsdc, 100_000n);
    const text = result.reasons.join(" ");
    assert.match(text, /went down by 250000 base units: 100000 in the settlements this run verified, and 150000 more/);
    assert.match(text, /X402-09 of weather, entry 3, 50000; X402-11 of weather, entry 5, 100000/);
    // No more than: a gap smaller than the FAILed payments is explained too (only one of them settled).
    assert.equal(ledgerConsistency(before, after(850_000n), lax()).result, "explained");
  });

  it("is consistent, not explained, once the settlements of the FAILed checks are verified on chain", () => {
    const result = ledgerConsistency(before, after(750_000n), lax({ nine: { settlement: verified }, eleven: { settlement: verified } }));
    assert.equal(result.result, "consistent", result.reasons.join("; "));
    assert.equal(result.consistent, true);
    assert.equal(result.settledUsdc, 250_000n);
  });

  it("is inconsistent when the gap is more than the payments of the checks that FAILed", () => {
    const result = ledgerConsistency(before, after(749_999n), lax());
    assert.equal(result.result, "inconsistent");
    assert.match(result.reasons.join(" "), /went down by 250001 base units, and the settlements this run verified add up to 100000; the payments of the checks that FAILed add up to only 150000 more/);
  });

  it("is inconsistent when the only unverified payment belongs to a check that passed, had no verdict, was skipped or has none recorded", () => {
    for (const verdict of ["pass", "no-verdict", "skipped", undefined] as const) {
      const entries = lax({ eleven: verdict === undefined ? { verdict: undefined } : { verdict } }).filter((item) => item.check !== "X402-09");
      const result = ledgerConsistency(before, after(800_000n), entries);
      assert.equal(result.result, "inconsistent", `X402-11 ${String(verdict)}`);
    }
  });

  it("a FAILed check's payment that was discarded unsent, or never signed, explains nothing", () => {
    const discarded = lax({ nine: { discarded: "not sent", sent: undefined }, eleven: { verdict: "pass" } });
    assert.equal(ledgerConsistency(before, after(850_000n), discarded).result, "inconsistent");
    const unsigned = lax({ nine: { state: "not-signed", sent: undefined }, eleven: { verdict: "pass" } });
    assert.equal(ledgerConsistency(before, after(850_000n), unsigned).result, "inconsistent");
  });

  it("is inconsistent when the XLM moved, or a reading is missing, or less left than was verified, whatever FAILed", () => {
    const xlm = ledgerConsistency(before, after(750_000n, 49_999_000n), lax());
    assert.equal(xlm.result, "inconsistent");
    assert.match(xlm.reasons.join(" "), /XLM/);
    assert.equal(ledgerConsistency(undefined, after(750_000n), lax()).result, "inconsistent");
    assert.equal(ledgerConsistency(before, undefined, lax()).result, "inconsistent");
    assert.equal(ledgerConsistency(before, after(950_000n), lax()).result, "inconsistent");
  });

  it("records each check's verdict on its own entries, once, and writes explained on close", () => {
    const ledger = RunLedger.create(folder(), header, { now });
    ledger.recordBalancesBefore({ usdc: 1_000_000n, native: 50_000_000n }, "horizon");
    const book = ledger.forEndpoint("weather");
    const honest = book.intent(intent);
    honest.signed(65_594_600);
    honest.sent({ status: 200 });
    honest.settled("e".repeat(64), true);
    // Another endpoint's verdict for the same check id is not this endpoint's.
    ledger.forEndpoint("other").verdict!("X402-06", "fail");
    assert.equal(ledger.entries[0]!.verdict, undefined);
    book.verdict!("X402-06", "pass");
    const under = book.intent({ ...intent, check: "X402-09", amount: "50000" });
    under.signed(65_594_600);
    under.sent({ status: 200 });
    book.verdict!("X402-09", "fail");
    // A second verdict for the same check changes nothing.
    book.verdict!("X402-09", "pass");
    assert.deepEqual(ledger.entries.map((item) => [item.check, item.verdict]), [["X402-06", "pass"], ["X402-09", "fail"]]);
    assert.deepEqual((onDisk(ledger)["entries"] as LedgerEntry[]).map((item) => item.verdict), ["pass", "fail"]);
    assert.throws(() => book.verdict!("X402-09", "maybe" as never), RunLedgerError);
    const result = ledger.close({ after: { usdc: 850_000n, native: 50_000_000n }, source: "horizon" });
    assert.equal(result.result, "explained", result.reasons.join("; "));
    assert.equal(onDisk(ledger)["result"], "explained");
    assert.throws(() => book.verdict!("X402-06", "fail"), RunLedgerError, "a closed ledger takes no verdict");
  });
});

describe("when every authorization of the run has expired (L4)", () => {
  const base = { endpoint: "w", network: "stellar:pubnet", asset: USDC, payTo: PAY_TO, amount: "1", intentAt: "t" };
  it("is after the latest expiry of every entry that may be signed", () => {
    const entries: LedgerEntry[] = [
      { ...base, id: 1, check: "X402-06", state: "signed", expiresAtLedger: 100 },
      { ...base, id: 2, check: "X402-07", state: "signed", expiresAtLedger: 140 },
      { ...base, id: 3, check: "X402-09", state: "not-signed" },
    ];
    assert.deepEqual(openAuthorizationsUntil(entries), { latest: 140, unknown: 0 });
  });

  it("counts the entries whose expiry is not known, so the caller waits its longest bound", () => {
    const entries: LedgerEntry[] = [
      { ...base, id: 1, check: "X402-06", state: "intent" },
      { ...base, id: 2, check: "X402-07", state: "unknown" },
      { ...base, id: 3, check: "X402-09", state: "signed", expiresAtLedger: null },
      { ...base, id: 4, check: "X402-10", state: "signed", expiresAtLedger: 90 },
    ];
    assert.deepEqual(openAuthorizationsUntil(entries), { latest: 90, unknown: 3 });
  });
});

describe("the expiry of a signature, from what the key signed", () => {
  it("is the preimage's signature expiration ledger", () => {
    const invocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(USDC).toScAddress(),
          functionName: "transfer",
          args: [new Address(PAYER).toScVal(), new Address(PAY_TO).toScVal(), nativeToScVal(100_000n, { type: "i128" })],
        }),
      ),
      subInvocations: [],
    });
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(Networks.PUBLIC)),
        nonce: xdr.Int64.fromString("7"),
        invocation,
        signatureExpirationLedger: 65_594_600,
      }),
    ).toXDR("base64");
    assert.equal(expirationOfSigned({ preimage, signature: Buffer.alloc(64) }), 65_594_600);
    assert.equal(expirationOfSigned({ preimage: "not xdr", signature: Buffer.alloc(64) }), undefined);
  });
});

