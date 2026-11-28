/**
 * How the payment checks keep the run ledger (spec B5, B-A03), written before
 * the code (B11): `preparePayment` writes the intent of each signature after
 * the run is charged and before the key is asked to sign, then what became of
 * it; each check records what it sent and the answer's status; X402-06 records
 * the settlement. A ledger that cannot take the intent stops the payment with
 * nothing signed. It works on every network; here, a test network.
 *
 * Offline: the recording chain of `../support/recording-chain.ts`, and a gated
 * variant that signs through the signed-terms gate as the Stellar signer does.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Address, Keypair, Networks, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import type { CheckResult } from "../../src/check.js";
import { CheckSetupError } from "../../src/errors.js";
import { PaymentGuardRefusedError, RunBudget } from "../../src/guard/budget.js";
import { setRpcIdentityTransportForTesting } from "../../src/guard/rpc-identity.js";
import { RunLedger, type LedgerEntry, type PaymentLedger } from "../../src/guard/run-ledger.js";
import { setPaymentChainsForTesting } from "../../src/x402/chains/index.js";
import type { PaymentChain } from "../../src/x402/chains/types.js";
import { runX402PaymentChecks } from "../../src/x402/simulator.js";
import { NETWORK, PAYER, PAY_TO, USDC, option, paywall, recordingChain, type Paywall, type Recorder } from "../support/recording-chain.js";

const dirs: string[] = [];
const walls: Paywall[] = [];
let recorder: Recorder;

beforeEach(() => {
  recorder = { signed: [] };
});

afterEach(async () => {
  setPaymentChainsForTesting(undefined);
  setRpcIdentityTransportForTesting(undefined);
  await Promise.all(walls.splice(0).map((wall) => wall.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function install(chain: PaymentChain): void {
  setPaymentChainsForTesting([chain]);
  setRpcIdentityTransportForTesting(async (_url, method) => (method === "eth_chainId" ? "0x14a34" : undefined));
}

function newLedger(): RunLedger {
  const dir = mkdtempSync(join(tmpdir(), "wasit-ledger-wiring-"));
  dirs.push(dir);
  return RunLedger.create(dir, {
    versions: { core: "test" },
    environment: "test",
    network: NETWORK,
    payer: PAYER,
    caps: { perPaymentUsd: "$1.00", runUsd: "$5.00" },
    plan: {},
    rpc: "http://127.0.0.1:9",
  });
}

function entriesOf(ledger: RunLedger): LedgerEntry[] {
  return (JSON.parse(readFileSync(ledger.path, "utf-8")) as { entries: LedgerEntry[] }).entries;
}

async function wall(amount: string): Promise<Paywall> {
  const created = await paywall([option({ amount })]);
  walls.push(created);
  return created;
}

function byId(results: readonly CheckResult[], id: string): CheckResult {
  const found = results.find((result) => result.id === id);
  assert.ok(found, `no ${id}`);
  return found;
}

const run = (target: string, ledger: PaymentLedger) =>
  runX402PaymentChecks({ target, network: NETWORK, payerSecretKey: "test-payer-key", budget: new RunBudget(), ledger });

/** A Stellar authorization preimage expiring at `expiration`, as the gate records what it let the key sign. */
function preimage(expiration: number): string {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address("CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75").toScAddress(),
        functionName: "transfer",
        args: [
          new Address(Keypair.random().publicKey()).toScVal(),
          new Address(Keypair.random().publicKey()).toScVal(),
          nativeToScVal(1n, { type: "i128" }),
        ],
      }),
    ),
    subInvocations: [],
  });
  return xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(Networks.TESTNET)),
      nonce: xdr.Int64.fromString("7"),
      invocation,
      signatureExpirationLedger: expiration,
    }),
  ).toXDR("base64");
}

interface GatedOptions {
  /** Asks the gate for a second signature: refused, nothing recorded. */
  readonly twice?: boolean;
  readonly bind?: () => void;
  /** Called when the key is asked to sign, before it signs. */
  readonly onSign?: (requirements: { amount: string }) => void;
}

/** The recording chain, signing through the gate and recording a preimage that expires at the gate's bound. */
function gatedChain(options: GatedOptions = {}): PaymentChain {
  const base = recordingChain(recorder);
  return {
    ...base,
    registerPayer(client, _network, _key, _rpc, gate) {
      client.register(NETWORK, {
        scheme: "exact",
        findDefaultAsset: (asset, network) =>
          network === NETWORK && asset.toLowerCase() === USDC.toLowerCase() ? { asset: USDC, decimals: 6, symbol: "USDC" } : undefined,
        async createPaymentPayload(version, requirements) {
          options.onSign?.(requirements);
          const terms = gate.take();
          if (options.twice === true) gate.take();
          gate.record({ preimage: preimage(terms.maxExpiration), signature: Buffer.alloc(64, 1) });
          recorder.signed.push(requirements);
          return { x402Version: version, payload: { signature: `sig-${recorder.signed.length}` } };
        },
      });
    },
    signedTerms: {
      unitSeconds: 5,
      latestUnit: async () => 1000,
      bind: () => options.bind?.(),
    },
  };
}

describe("the run ledger in the payment checks", () => {
  it("has each signature's intent on disk before the key is asked to sign it", async () => {
    const ledger = newLedger();
    const seenBeforeSigning: LedgerEntry[] = [];
    install(
      gatedChain({
        onSign: () => {
          const last = entriesOf(ledger).at(-1);
          assert.ok(last !== undefined, "an intent is on disk");
          seenBeforeSigning.push(last);
        },
      }),
    );
    const target = await wall("10000");
    const results = await run(target.url, ledger.forEndpoint("paid"));
    assert.equal(byId(results, "X402-06").pass, true, byId(results, "X402-06").detail);
    assert.deepEqual(
      seenBeforeSigning.map((entry) => [entry.check, entry.state, entry.amount]),
      [
        ["X402-06", "intent", "10000"],
        ["X402-07", "intent", "10000"],
        ["X402-09", "intent", "5000"],
        ["X402-10", "intent", "10000"],
      ],
    );
  });

  it("records each signature with its expiry, what was sent, and X402-06's settlement", async () => {
    const ledger = newLedger();
    install(gatedChain());
    const target = await wall("10000");
    await run(target.url, ledger.forEndpoint("paid"));
    const entries = entriesOf(ledger);
    assert.deepEqual(entries.map((entry) => entry.check), ["X402-06", "X402-07", "X402-09", "X402-10"]);
    for (const entry of entries) {
      assert.equal(entry.state, "signed", entry.check);
      assert.equal(entry.endpoint, "paid");
      assert.equal(entry.payTo, PAY_TO);
      assert.equal(entry.asset, USDC);
      assert.equal(typeof entry.expiresAtLedger, "number", `${entry.check} expiry`);
      assert.equal(typeof entry.sent?.status, "number", `${entry.check} sent`);
    }
    // 60 s of lifetime from ledger 1000: at most 1000 + 12 + 2 (+ the time since the anchor).
    assert.ok(entries[0]!.expiresAtLedger! >= 1014 && entries[0]!.expiresAtLedger! <= 1016);
    assert.equal(entries[0]!.settlement?.verified, true);
    assert.match(entries[0]!.settlement?.reference ?? "", /^tx-/);
    assert.equal(entries[1]!.settlement, undefined);
    // The paywall serves the underpaid payment and names its settlement: read back as X402-06's is, and recorded.
    assert.deepEqual(entries[2]!.settlement, { reference: "tx-4", verified: true });
    assert.equal(entries[3]!.settlement, undefined);
    // Each entry carries the verdict of its check: X402-07, 09 and 10 FAIL against a paywall that serves everything.
    assert.deepEqual(entries.map((entry) => entry.verdict), ["pass", "fail", "fail", "fail"]);
  });

  it("X402-09 accepted: its settlement is held to the payment signed, and what the chain shows is added to the FAIL", async () => {
    const ledger = newLedger();
    const asked: Array<{ reference: string; amount: bigint; recipient: string }> = [];
    install({
      ...gatedChain(),
      verifySettlement: async (_network, _rpc, reference, expected) => {
        asked.push({ reference, amount: expected.amount, recipient: expected.recipient });
        return { pass: true, detail: "settled (stand-in)" };
      },
    });
    const target = await wall("10000");
    const results = await run(target.url, ledger.forEndpoint("paid"));
    const nine = byId(results, "X402-09");
    assert.equal(nine.pass, false);
    assert.equal(nine.error, undefined, nine.detail);
    assert.match(nine.detail, /was accepted \(HTTP 200\)/);
    assert.match(nine.detail, /It settled on chain: 5000 base units moved from the payer to payTo in tx-4/);
    assert.deepEqual(asked.at(-1), { reference: "tx-4", amount: 5000n, recipient: PAY_TO });
  });

  it("X402-09 accepted with a settlement the chain does not show as this payment: recorded unverified, still a FAIL", async () => {
    const ledger = newLedger();
    install({
      ...gatedChain(),
      verifySettlement: async (_network, _rpc, _reference, expected) =>
        expected.amount === 5000n ? { pass: false, detail: "no such transfer (stand-in)" } : { pass: true, detail: "settled (stand-in)" },
    });
    const target = await wall("10000");
    const results = await run(target.url, ledger.forEndpoint("paid"));
    const nine = byId(results, "X402-09");
    assert.equal(nine.pass, false);
    assert.equal(nine.error, undefined);
    assert.match(nine.detail, /names tx-4, which the chain does not show as this payment: no such transfer/);
    assert.deepEqual(entriesOf(ledger)[2]!.settlement, { reference: "tx-4", verified: false });
  });

  it("X402-09 accepted and the chain gives no answer: recorded unverified, the FAIL stands", async () => {
    const ledger = newLedger();
    install({
      ...gatedChain(),
      verifySettlement: async (_network, _rpc, _reference, expected) => {
        if (expected.amount === 5000n) throw new Error("rpc down");
        return { pass: true, detail: "settled (stand-in)" };
      },
    });
    const target = await wall("10000");
    const results = await run(target.url, ledger.forEndpoint("paid"));
    const nine = byId(results, "X402-09");
    assert.equal(nine.pass, false);
    assert.equal(nine.error, undefined, "a chain that gives no answer does not turn the FAIL into no verdict");
    assert.match(nine.detail, /names tx-4, which could not be read on chain \(rpc down\)/);
    assert.deepEqual(entriesOf(ledger)[2]!.settlement, { reference: "tx-4", verified: false });
  });

  it("records not signed when the run stops before the key is asked (the payer cannot pay)", async () => {
    const ledger = newLedger();
    install({ ...gatedChain(), payerBalance: async () => 0n });
    const target = await wall("10000");
    const results = await run(target.url, ledger.forEndpoint("paid"));
    assert.equal(byId(results, "X402-06").error?.kind, "setup");
    const [entry, ...rest] = entriesOf(ledger);
    assert.equal(entry!.state, "not-signed");
    assert.equal(rest.length, 0);
    assert.equal(recorder.signed.length, 0);
  });

  it("records not signed when the gate refuses, since the gate is the only way to the key", async () => {
    const ledger = newLedger();
    install(gatedChain({ twice: true }));
    const target = await wall("10000");
    await run(target.url, ledger.forEndpoint("paid"));
    const [entry] = entriesOf(ledger);
    assert.equal(entry!.state, "not-signed");
    assert.match(entry!.note ?? "", /second signature/);
  });

  it("records a payload it cannot bind as signed and discarded, never sent", async () => {
    const ledger = newLedger();
    install(
      gatedChain({
        bind: () => {
          throw new PaymentGuardRefusedError("signed-terms", "The payment names another invocation.", { signed: true });
        },
      }),
    );
    const target = await wall("10000");
    await run(target.url, ledger.forEndpoint("paid"));
    const [entry] = entriesOf(ledger);
    assert.equal(entry!.state, "signed");
    assert.match(entry!.discarded ?? "", /another invocation/);
    assert.equal(entry!.sent, undefined);
    assert.equal(target.paid, 0);
  });

  it("records unknown when a client without a gate fails while building: it may have signed", async () => {
    const ledger = newLedger();
    const base = recordingChain(recorder);
    install({
      ...base,
      registerPayer(client) {
        client.register(NETWORK, {
          scheme: "exact",
          findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }),
          async createPaymentPayload() {
            throw new Error("the client failed after the key was used");
          },
        });
      },
    });
    const target = await wall("10000");
    await run(target.url, ledger.forEndpoint("paid"));
    const [entry] = entriesOf(ledger);
    assert.equal(entry!.state, "unknown");
  });

  it("records signed when the client fails after the gate let the key sign: the signature exists", async () => {
    const ledger = newLedger();
    const base = gatedChain();
    install({
      ...base,
      registerPayer(client, _network, _key, _rpc, gate) {
        client.register(NETWORK, {
          scheme: "exact",
          findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }),
          async createPaymentPayload() {
            const terms = gate.take();
            gate.record({ preimage: preimage(terms.maxExpiration), signature: Buffer.alloc(64, 1) });
            throw new Error("the second simulation failed");
          },
        });
      },
    });
    const target = await wall("10000");
    await run(target.url, ledger.forEndpoint("paid"));
    const [entry] = entriesOf(ledger);
    assert.equal(entry!.state, "signed");
    assert.equal(typeof entry!.expiresAtLedger, "number");
    assert.equal(entry!.sent, undefined, "no send recorded: read as sent");
  });

  it("records not signed on a chain without a gate when the run stops before the client is asked", async () => {
    const ledger = newLedger();
    install({ ...recordingChain(recorder), payerBalance: async () => 0n });
    const target = await wall("10000");
    await run(target.url, ledger.forEndpoint("paid"));
    const [entry] = entriesOf(ledger);
    assert.equal(entry!.state, "not-signed");
    assert.equal(recorder.signed.length, 0);
  });

  it("signs nothing when the intent cannot be written", async () => {
    install(gatedChain());
    const target = await wall("10000");
    const broken: PaymentLedger = {
      intent() {
        throw new CheckSetupError("The run ledger could not be written. Nothing was signed.");
      },
    };
    const results = await run(target.url, broken);
    const first = byId(results, "X402-06");
    assert.equal(first.error?.kind, "setup", first.detail);
    assert.match(first.detail, /Nothing was signed\./);
    assert.equal(recorder.signed.length, 0);
    assert.equal(target.paid, 0);
  });
});
