/**
 * The mainnet path through the REAL Stellar adapter and the real
 * `@x402/stellar` client scheme, on stellar:pubnet (spec B5, B17.2, B13 V0):
 * every other mainnet test stands the adapter in, and the SDK-level gate
 * tests run on testnet. Here the adapter, the SDK's pubnet branch (it needs
 * the RPC handed to it) and the signed-terms gate run as they would in a paid
 * run, before the first one (B13 V3) does.
 *
 * Offline: the RPC's methods are replaced on `rpc.Server.prototype` (one copy
 * of the SDK is installed), Horizon's SDK client is refused, public Horizon is
 * the loopback stand-in of `../support/pubnet-chain.ts`, and the RPC identity
 * check answers through its seam. The payer is a fresh random key that holds
 * nothing; nothing leaves 127.0.0.1.
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { Address, Horizon, Keypair, Networks, SorobanDataBuilder, hash, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";

import { PaymentGuardRefusedError } from "../../src/guard/budget.js";
import { closeMainnetRun, openMainnetOptIn } from "../../src/guard/mainnet-run.js";
import { anchorOfOptIn, type MainnetOptIn } from "../../src/guard/optin.js";
import type { LedgerEntry } from "../../src/guard/run-ledger.js";
import { SigningGate, type SigningTerms } from "../../src/guard/signed-terms.js";
import { setPaymentChainsForTesting } from "../../src/x402/chains/index.js";
import { stellarChain } from "../../src/x402/chains/stellar.js";
import { planX402Run } from "../../src/x402/plan.js";
import { runX402PaymentChecks } from "../../src/x402/simulator.js";
import { PUBNET, PUBNET_RPC, PUBNET_USDC, TESTNET_USDC, installPubnetWorld, pubnetOption, type PubnetWorld } from "../support/pubnet-chain.js";

const payerKey = Keypair.random();
const PAYER = payerKey.publicKey();
const PAY_TO = Keypair.random().publicKey();
const ATTACKER = Keypair.random().publicKey();
const CENT = 100_000n;

interface Spec {
  readonly to?: string;
  readonly amount?: bigint;
  readonly contract?: string;
  readonly subInvocations?: xdr.SorobanAuthorizedInvocation[];
}

function invocation(spec: Spec = {}): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(spec.contract ?? PUBNET_USDC).toScAddress(),
        functionName: "transfer",
        args: [
          nativeToScVal(PAYER, { type: "address" }),
          nativeToScVal(spec.to ?? PAY_TO, { type: "address" }),
          nativeToScVal(spec.amount ?? CENT, { type: "i128" }),
        ],
      }),
    ),
    subInvocations: spec.subInvocations ?? [],
  });
}

function entry(spec: Spec = {}): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(PAYER).toScAddress(),
        nonce: xdr.Int64.fromString("7"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation(spec),
  });
}

type Patchable = Record<string, unknown>;

interface Rpc {
  latest: number;
  /** The payer's USDC as the token's `balance` returns it. */
  usdc: bigint;
  /** What the first simulation of each payment returns as the payer's auth entries. */
  entries: () => xdr.SorobanAuthorizationEntry[];
  /** Every RPC call: method, the contract function simulated (if any), the URL. */
  readonly calls: Array<[string, string, string]>;
  /** Signatures the payer's key made. */
  signatures: number;
}

/** The contract function a simulated transaction calls; "" when it calls none. */
function calledFunction(transaction: unknown): string {
  const operation = (transaction as { operations?: Array<{ func?: xdr.HostFunction }> }).operations?.[0];
  try {
    return operation?.func?.invokeContract().functionName().toString() ?? "";
  } catch {
    return "";
  }
}

function simulation(latest: number, value: xdr.ScVal, auth: readonly xdr.SorobanAuthorizationEntry[] = []): Record<string, unknown> {
  return {
    latestLedger: latest,
    minResourceFee: "100",
    transactionData: new SorobanDataBuilder().build().toXDR("base64"),
    results: [{ auth: auth.map((item) => item.toXDR("base64")), xdr: value.toXDR("base64") }],
    events: [],
  };
}

function installRpc(): { readonly state: Rpc; readonly undo: () => void } {
  const state: Rpc = { latest: 61_000_000, usdc: 50_000_000n, entries: () => [entry()], calls: [], signatures: 0 };
  const server = rpc.Server.prototype as unknown as Patchable;
  const horizon = Horizon.Server.prototype as unknown as Patchable;
  const keypair = Keypair.prototype as unknown as Patchable;
  const saved = {
    getLatestLedger: server["getLatestLedger"],
    simulate: server["_simulateTransaction"],
    ledgers: horizon["ledgers"],
    sign: keypair["sign"],
  };
  let transfers = 0;
  server["getLatestLedger"] = async function (this: rpc.Server) {
    state.calls.push(["getLatestLedger", "", this.serverURL.toString()]);
    return { id: "0", sequence: state.latest, protocolVersion: 23 };
  };
  server["_simulateTransaction"] = async function (this: rpc.Server, transaction: unknown) {
    const fn = calledFunction(transaction);
    state.calls.push(["simulateTransaction", fn, this.serverURL.toString()]);
    if (fn === "balance") return simulation(state.latest, nativeToScVal(state.usdc, { type: "i128" }));
    if (fn === "decimals") return simulation(state.latest, nativeToScVal(7, { type: "u32" }));
    if (fn === "transfer") {
      transfers += 1;
      // The first simulation of a payment returns the entries to sign; the second carries the signature back.
      return simulation(state.latest, xdr.ScVal.scvVoid(), transfers % 2 === 1 ? state.entries() : []);
    }
    throw new Error(`the stand-in RPC simulates no ${fn || "other"} call`);
  };
  horizon["ledgers"] = () => {
    throw new Error("offline: the SDK's Horizon client is not used in tests");
  };
  const sign = saved.sign as (this: Keypair, data: Buffer) => Buffer;
  keypair["sign"] = function (this: Keypair, data: Buffer) {
    if (this.publicKey() === PAYER) state.signatures += 1;
    return sign.call(this, data);
  };
  return {
    state,
    undo: () => {
      server["getLatestLedger"] = saved.getLatestLedger;
      server["_simulateTransaction"] = saved.simulate;
      horizon["ledgers"] = saved.ledgers;
      keypair["sign"] = saved.sign;
    },
  };
}

let world: PubnetWorld;
let standIn: ReturnType<typeof installRpc>;
let dir: string;
let optIn: MainnetOptIn;

beforeEach(async () => {
  world = await installPubnetWorld();
  // The real adapters, not the world's stand-in chain: its Horizon and identity seam stay.
  setPaymentChainsForTesting(undefined);
  standIn = installRpc();
  dir = mkdtempSync(path.join(tmpdir(), "wasit-real-adapter-"));
  optIn = await openMainnetOptIn({
    frontEnd: "cli",
    env: { WASIT_MAINNET_PAYER_SECRET: payerKey.secret() },
    environment: "mainnet",
    network: PUBNET,
    operatedByMe: true,
    pin: { payTo: PAY_TO, asset: PUBNET_USDC },
    rpcUrl: PUBNET_RPC,
    ledgerDir: dir,
  });
});

afterEach(async () => {
  optIn.close();
  standIn.undo();
  await world.close();
  rmSync(dir, { recursive: true, force: true });
});

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return pubnetOption(PAY_TO, CENT, overrides);
}

function terms(overrides: Partial<SigningTerms> = {}): SigningTerms {
  return { network: PUBNET, payer: PAYER, asset: PUBNET_USDC, payTo: PAY_TO, amount: CENT.toString(), maxExpiration: 61_000_014, ...overrides };
}

/** Signs through the SDK with the run's opt-in, unless `with.mainnet` is null (none at all). */
async function signThroughSdk(gate: SigningGate, options: { readonly mainnet?: MainnetOptIn | null; readonly rpcUrl?: string } = {}) {
  const client = new x402Client();
  const mainnet = options.mainnet === null ? undefined : (options.mainnet ?? optIn);
  await stellarChain.registerPayer(client, PUBNET, payerKey.secret(), options.rpcUrl ?? PUBNET_RPC, gate, mainnet);
  return client.createPaymentPayload({ x402Version: 2, resource: { url: "http://127.0.0.1/paid" }, accepts: [requirements()] });
}

function simulations(): number {
  return standIn.state.calls.filter(([method, fn]) => method === "simulateTransaction" && fn === "transfer").length;
}

describe("the x402 Stellar client on stellar:pubnet, through the real adapter and the gate", () => {
  it("signs the honest transfer once, for the Public network, every call to the opt-in's RPC, and the payload binds", async () => {
    const gate = new SigningGate();
    gate.arm(terms());
    const payload = await signThroughSdk(gate);
    assert.equal(standIn.state.signatures, 1);
    assert.equal(simulations(), 2);
    const signed = gate.signed;
    assert.ok(signed !== undefined, "the gate recorded no signature");
    const preimage = xdr.HashIdPreimage.fromXDR(signed.preimage, "base64");
    assert.equal(preimage.switch().name, "envelopeTypeSorobanAuthorization");
    assert.ok(preimage.sorobanAuthorization().networkId().equals(hash(Buffer.from(Networks.PUBLIC))), "not the Public network id");
    assert.ok(preimage.sorobanAuthorization().signatureExpirationLedger() <= 61_000_014);
    for (const [method, , url] of standIn.state.calls) assert.equal(url, PUBNET_RPC, method);
    stellarChain.signedTerms!.bind(payload.payload, gate);
  });

  const hostile: ReadonlyArray<[string, () => xdr.SorobanAuthorizationEntry[], RegExp]> = [
    ["pays another address", () => [entry({ to: ATTACKER })], /pays/],
    ["asks for twice the amount", () => [entry({ amount: 2n * CENT })], /base units/],
    ["calls the testnet USDC contract", () => [entry({ contract: TESTNET_USDC })], /contract/],
    ["adds a sub-invocation", () => [entry({ subInvocations: [invocation({ contract: TESTNET_USDC })] })], /further call/],
  ];
  for (const [name, entries, pattern] of hostile) {
    it(`a pubnet simulation that ${name}: no signature, and no second simulation`, async () => {
      standIn.state.entries = entries;
      const gate = new SigningGate();
      gate.arm(terms());
      await assert.rejects(signThroughSdk(gate), (error: unknown) => {
        assert.ok(error instanceof PaymentGuardRefusedError, String(error));
        assert.match(error.message, pattern);
        return true;
      });
      assert.equal(standIn.state.signatures, 0);
      assert.equal(simulations(), 1);
    });
  }

  it("gives the SDK no RPC without a live opt-in for that RPC: stopped, closed, another RPC or none; nothing is signed", async () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      ["no opt-in", () => signThroughSdk(armed(), { mainnet: null })],
      ["another RPC", () => signThroughSdk(armed(), { rpcUrl: "https://rpc.other.example/stellar:pubnet" })],
    ];
    // The SDK's own refusal on pubnet without an RPC (B-A01): the second line behind L0.
    const sdkRefusal = /Stellar mainnet requires a non-empty rpcUrl/;
    for (const [label, run] of cases) {
      await assert.rejects(run(), sdkRefusal, label);
      assert.equal(standIn.state.signatures, 0, label);
      assert.ok(!standIn.state.calls.some(([, , url]) => url === PUBNET_RPC), `${label}: the opt-in's RPC was used`);
    }
    optIn.stop("stopped for the test");
    await assert.rejects(signThroughSdk(armed()), sdkRefusal, "stopped");
    optIn.close();
    await assert.rejects(signThroughSdk(armed()), sdkRefusal, "closed");
    assert.equal(standIn.state.signatures, 0);
    assert.ok(!standIn.state.calls.some(([, , url]) => url === PUBNET_RPC), "the opt-in's RPC was used without a live opt-in");
  });
});

function armed(): SigningGate {
  const gate = new SigningGate();
  gate.arm(terms());
  return gate;
}

interface RefusingWall {
  readonly url: string;
  /** Payment headers received. */
  readonly payments: string[];
  close(): Promise<void>;
}

/** A pubnet paywall that asks for payment and refuses what it is paid with (402): nothing settles. */
async function refusingWall(accepts: PaymentRequirements[]): Promise<RefusingWall> {
  const payments: string[] = [];
  const server = http.createServer((request, response) => {
    request.on("data", () => undefined);
    request.on("end", () => {
      const header = request.headers["payment-signature"];
      if (typeof header === "string") payments.push(header);
      const challenge = {
        x402Version: 2,
        resource: { url: "http://127.0.0.1/weather" },
        accepts,
        ...(typeof header === "string" ? { error: "invalid_exact_stellar_payload" } : {}),
      };
      response.writeHead(402, { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/weather`,
    payments,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("a mainnet run through the real adapter: plan, ledger, one signature, send, close", () => {
  it("plans by the chain's reads, signs once for the Public network, records it, and closes consistent", async () => {
    const target = await refusingWall([requirements()]);
    try {
      const plan = await planX402Run({ network: PUBNET, endpoints: [{ name: "weather", target: target.url }], mainnet: optIn });
      assert.equal(plan.refusal, undefined, plan.refusal ?? "");
      // L1 read the payer's USDC and the token's decimals through the real adapter, on the opt-in's RPC.
      const simulated = standIn.state.calls.filter(([method]) => method === "simulateTransaction").map(([, fn]) => fn);
      assert.ok(simulated.includes("balance") && simulated.includes("decimals"), simulated.join(", "));
      const bound = anchorOfOptIn(optIn).maxExpiration(5, 60);
      const ledger = optIn.openLedger({ core: "test" });

      const results = await runX402PaymentChecks({
        target: target.url,
        network: PUBNET,
        payerSecretKey: payerKey.secret(),
        plan: plan.endpoints[0]!,
        mainnet: optIn,
      });
      const six = results.find((result) => result.id === "X402-06");
      assert.ok(six !== undefined && six.pass === false && six.error === undefined, JSON.stringify(results.map((r) => [r.id, r.detail])));
      assert.match(six.detail, /Expected 2xx after a valid payment, got 402 \(invalid_exact_stellar_payload\)/);
      assert.equal(optIn.stopped, undefined, "the run stopped");

      // One payment reached the service, signed once by the payer's key, for the Public network.
      assert.equal(target.payments.length, 1);
      assert.equal(standIn.state.signatures, 1);
      const payment = JSON.parse(Buffer.from(target.payments[0]!, "base64").toString("utf-8")) as { accepted: PaymentRequirements };
      assert.equal(payment.accepted.network, PUBNET);
      assert.equal(payment.accepted.payTo, PAY_TO);
      assert.equal(payment.accepted.amount, CENT.toString());
      for (const [method, , url] of standIn.state.calls) assert.equal(url, PUBNET_RPC, method);

      const [recorded, ...more] = JSON.parse(readFileSync(ledger.path, "utf-8")).entries as LedgerEntry[];
      assert.equal(more.length, 0);
      assert.equal(recorded!.check, "X402-06");
      assert.equal(recorded!.state, "signed");
      assert.equal(typeof recorded!.expiresAtLedger, "number");
      assert.ok(recorded!.expiresAtLedger! <= bound);
      assert.equal(recorded!.sent?.status, 402);
      assert.equal(recorded!.verdict, "fail");

      // L4: every authorization expired, then the balances after on Horizon: nothing moved, nothing verified.
      const close = await closeMainnetRun(optIn, {
        sleep: async () => {
          standIn.state.latest += 10;
          world.state.horizonLatest = standIn.state.latest;
        },
      });
      assert.equal(close.consistency?.result, "consistent", `${close.problem ?? ""} ${close.consistency?.reasons.join(" ") ?? ""}`);
      assert.ok((close.waitedUntil ?? 0) >= recorded!.expiresAtLedger!);
    } finally {
      await target.close();
    }
  });
});
