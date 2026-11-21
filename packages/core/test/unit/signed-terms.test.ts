/**
 * The signed-terms gate (spec B17.2), written before the code it tests (B11).
 *
 * The caps, the pin and the plan are checked on the terms Wasit hands the x402
 * client. On Stellar the client then signs the authorization entries the RPC's
 * simulation returns, so the gate checks the preimage each signature covers:
 * one signature per payment, for `transfer(payer, payTo, amount)` on the
 * checked asset, on the run's network, with no sub-invocation and an
 * expiration within the payment's lifetime. Anything else is refused before
 * the key signs.
 *
 * Offline. The SDK tests drive the real `@x402/stellar` client scheme with the
 * RPC's methods replaced on `rpc.Server.prototype` (one copy of the SDK is
 * installed) and Horizon refused, so nothing leaves the process. The payer is
 * a fresh random key that holds nothing.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import {
  Address,
  Horizon,
  Keypair,
  Networks,
  SorobanDataBuilder,
  hash,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

import { PaymentGuardRefusedError } from "../../src/guard/budget.js";
import { NETWORK_CLASSES } from "../../src/guard/networks.js";
import { SigningAnchor, SigningGate, checkStellarPreimage, type SigningTerms } from "../../src/guard/signed-terms.js";
import { paymentChainFor } from "../../src/x402/chains/index.js";
import { stellarChain } from "../../src/x402/chains/stellar.js";

const NETWORK = "stellar:testnet";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const OTHER_CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const RPC_URL = "https://rpc.invalid/soroban";

const payerKey = Keypair.random();
const PAYER = payerKey.publicKey();
const PAY_TO = Keypair.random().publicKey();
const ATTACKER = Keypair.random().publicKey();

function terms(overrides: Partial<SigningTerms> = {}): SigningTerms {
  return { network: NETWORK, payer: PAYER, asset: USDC, payTo: PAY_TO, amount: "10000", maxExpiration: 1014, ...overrides };
}

interface InvocationSpec {
  readonly contract?: string;
  readonly fn?: string;
  readonly args?: xdr.ScVal[];
  readonly from?: string;
  readonly to?: string;
  readonly amount?: bigint;
  readonly subInvocations?: xdr.SorobanAuthorizedInvocation[];
}

function transferArgs(spec: InvocationSpec): xdr.ScVal[] {
  return [
    nativeToScVal(spec.from ?? PAYER, { type: "address" }),
    nativeToScVal(spec.to ?? PAY_TO, { type: "address" }),
    nativeToScVal(spec.amount ?? 10_000n, { type: "i128" }),
  ];
}

function invocation(spec: InvocationSpec = {}): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(spec.contract ?? USDC).toScAddress(),
        functionName: spec.fn ?? "transfer",
        args: spec.args ?? transferArgs(spec),
      }),
    ),
    subInvocations: spec.subInvocations ?? [],
  });
}

function preimage(
  spec: InvocationSpec & { readonly expiration?: number; readonly passphrase?: string; readonly withAddress?: boolean } = {},
): string {
  const networkId = hash(Buffer.from(spec.passphrase ?? Networks.TESTNET));
  const fields = {
    networkId,
    nonce: xdr.Int64.fromString("7"),
    invocation: invocation(spec),
    signatureExpirationLedger: spec.expiration ?? 1012,
  };
  const value =
    spec.withAddress === true
      ? xdr.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(
          new xdr.HashIdPreimageSorobanAuthorizationWithAddress({ ...fields, address: new Address(PAYER).toScAddress() }),
        )
      : xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization(fields));
  return value.toXDR("base64");
}

function refusedSignedTerms(pattern: RegExp): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof PaymentGuardRefusedError, `not a guard refusal: ${String(error)}`);
    assert.equal(error.reason, "signed-terms");
    assert.match(error.message, pattern);
    return true;
  };
}

describe("signed terms: the preimage check", () => {
  it("passes the transfer that was checked, at the latest expiration allowed", () => {
    checkStellarPreimage(preimage({ expiration: 1014 }), terms());
  });

  const refused: ReadonlyArray<[string, string, RegExp]> = [
    ["another network", preimage({ passphrase: Networks.PUBLIC }), /network/],
    ["another contract", preimage({ contract: OTHER_CONTRACT }), /contract/],
    ["another function", preimage({ fn: "approve" }), /transfer/],
    ["two arguments", preimage({ args: transferArgs({}).slice(0, 2) }), /argument/],
    ["four arguments", preimage({ args: [...transferArgs({}), nativeToScVal(1n, { type: "i128" })] }), /argument/],
    ["from another address", preimage({ from: ATTACKER }), /from/],
    ["to another address", preimage({ to: ATTACKER }), /pays/],
    ["one base unit more", preimage({ amount: 10_001n }), /base units/],
    ["one base unit less", preimage({ amount: 9_999n }), /base units/],
    ["a zero amount", preimage({ amount: 0n }), /base units/],
    ["a negative amount", preimage({ amount: -10_000n }), /base units/],
    ["the high half of the amount set", preimage({ amount: (1n << 64n) + 10_000n }), /base units/],
    [
      "the amount as a u128",
      preimage({ args: [...transferArgs({}).slice(0, 2), nativeToScVal(10_000n, { type: "u128" })] }),
      /base units/,
    ],
    ["a sub-invocation", preimage({ subInvocations: [invocation({ contract: OTHER_CONTRACT })] }), /further call/],
    ["one ledger past the bound", preimage({ expiration: 1015 }), /ledger 1015/],
    ["the address-bound form", preimage({ withAddress: true }), /form/],
  ];
  for (const [name, value, pattern] of refused) {
    it(`refuses ${name}`, () => {
      assert.throws(() => checkStellarPreimage(value, terms()), refusedSignedTerms(pattern));
    });
  }

  it("refuses an authorization that is not a contract call (a contract creation)", () => {
    const create = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
        new xdr.CreateContractArgs({
          contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
            new xdr.ContractIdPreimageFromAddress({ address: new Address(PAYER).toScAddress(), salt: Buffer.alloc(32) }),
          ),
          executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
        }),
      ),
      subInvocations: [],
    });
    const value = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(Networks.TESTNET)),
        nonce: xdr.Int64.fromString("7"),
        invocation: create,
        signatureExpirationLedger: 1012,
      }),
    ).toXDR("base64");
    assert.throws(() => checkStellarPreimage(value, terms()), refusedSignedTerms(/not a contract call/));
  });

  it("refuses what does not decode", () => {
    assert.throws(() => checkStellarPreimage("not xdr", terms()), refusedSignedTerms(/decode/));
  });
});

describe("signed terms: the gate", () => {
  it("refuses a signature it was not armed for", () => {
    assert.throws(() => new SigningGate().take(), refusedSignedTerms(/expected no signature/));
  });

  it("gives its terms once: a second signature in the same payment is refused", () => {
    const gate = new SigningGate();
    gate.arm(terms());
    assert.equal(gate.take().amount, "10000");
    assert.throws(() => gate.take(), refusedSignedTerms(/second signature/));
  });

  it("is armed once", () => {
    const gate = new SigningGate();
    gate.arm(terms());
    assert.throws(() => gate.arm(terms()));
  });
});

describe("signed terms: the anchor", () => {
  it("bounds the expiration by the first reading, the time since, and the lifetime", () => {
    assert.equal(new SigningAnchor().reading, undefined);
    const anchor = new SigningAnchor();
    anchor.set(1000, 0);
    anchor.set(5000, 0);
    assert.equal(anchor.reading?.unit, 1000, "only the first reading counts");
    assert.equal(anchor.maxExpiration(5, 60, 0), 1000 + 12 + 2);
    assert.equal(anchor.maxExpiration(5, 1, 0), 1000 + 1 + 2);
    assert.equal(anchor.maxExpiration(5, 60, 1), 1000 + 1 + 12 + 2, "a started unit counts");
    assert.equal(anchor.maxExpiration(5, 60, 30_000), 1000 + 6 + 12 + 2);
  });

  it("refuses a lifetime that is not a positive number of seconds, and rounds a fraction up", () => {
    const anchor = new SigningAnchor();
    anchor.set(1000, 0);
    for (const lifetime of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => anchor.maxExpiration(5, lifetime, 0), refusedSignedTerms(/lifetime/));
    }
    assert.equal(anchor.maxExpiration(5, 1.5, 0), 1000 + 1 + 2);
  });
});

/** The RPC and Horizon, replaced for the SDK tests. */
interface StandIn {
  /** What the next `getLatestLedger` answers. */
  latest: number;
  /** The payer's auth entries the first simulation returns. */
  entries: xdr.SorobanAuthorizationEntry[];
  /** Every RPC call, with the URL it went to. */
  readonly calls: Array<[string, string]>;
  /** Signatures the payer's key made. */
  signatures: number;
}

function entry(spec: InvocationSpec & { readonly nonce?: string } = {}): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(PAYER).toScAddress(),
        nonce: xdr.Int64.fromString(spec.nonce ?? "7"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation(spec),
  });
}

function rawSimulation(entries: readonly xdr.SorobanAuthorizationEntry[], latest: number): Record<string, unknown> {
  return {
    latestLedger: latest,
    minResourceFee: "100",
    transactionData: new SorobanDataBuilder().build().toXDR("base64"),
    results: [{ auth: entries.map((value) => value.toXDR("base64")), xdr: xdr.ScVal.scvVoid().toXDR("base64") }],
    events: [],
  };
}

type Patchable = Record<string, unknown>;

function installStandIn(): { readonly state: StandIn; readonly undo: () => void } {
  const state: StandIn = { latest: 1000, entries: [entry()], calls: [], signatures: 0 };
  const server = rpc.Server.prototype as unknown as Patchable;
  const horizon = Horizon.Server.prototype as unknown as Patchable;
  const keypair = Keypair.prototype as unknown as Patchable;
  const saved = {
    getLatestLedger: server["getLatestLedger"],
    simulate: server["_simulateTransaction"],
    ledgers: horizon["ledgers"],
    sign: keypair["sign"],
  };
  let simulations = 0;
  server["getLatestLedger"] = async function (this: rpc.Server) {
    state.calls.push(["getLatestLedger", this.serverURL.toString()]);
    return { id: "0", sequence: state.latest, protocolVersion: 23 };
  };
  server["_simulateTransaction"] = async function (this: rpc.Server) {
    state.calls.push(["simulateTransaction", this.serverURL.toString()]);
    simulations += 1;
    return rawSimulation(simulations === 1 ? state.entries : [], state.latest);
  };
  horizon["ledgers"] = () => {
    throw new Error("offline: no Horizon in tests");
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

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: "10000",
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
    ...overrides,
  };
}

async function signThroughSdk(gate: SigningGate, accepted = requirements()) {
  const client = new x402Client();
  await stellarChain.registerPayer(client, NETWORK, payerKey.secret(), RPC_URL, gate);
  return client.createPaymentPayload({ x402Version: 2, resource: { url: "http://127.0.0.1/paid" }, accepts: [accepted] });
}

function simulations(state: StandIn): number {
  return state.calls.filter(([method]) => method === "simulateTransaction").length;
}

describe("signed terms: through the x402 Stellar client", () => {
  let standIn: ReturnType<typeof installStandIn>;
  beforeEach(() => {
    standIn = installStandIn();
  });
  afterEach(() => standIn.undo());

  it("signs the honest transfer once, and the payload carries exactly that signature", async () => {
    const gate = new SigningGate();
    gate.arm(terms());
    const payload = await signThroughSdk(gate);
    assert.equal(standIn.state.signatures, 1);
    assert.equal(simulations(standIn.state), 2);
    assert.ok(gate.signed);
    stellarChain.signedTerms?.bind(payload.payload, gate);
  });

  const hostile: ReadonlyArray<[string, () => xdr.SorobanAuthorizationEntry[], RegExp]> = [
    ["pays another address", () => [entry({ to: ATTACKER })], /pays/],
    ["asks for twice the amount", () => [entry({ amount: 20_000n })], /base units/],
    ["calls another contract", () => [entry({ contract: OTHER_CONTRACT })], /contract/],
    ["adds a sub-invocation", () => [entry({ subInvocations: [invocation({ contract: OTHER_CONTRACT })] })], /further call/],
  ];
  for (const [name, entries, pattern] of hostile) {
    it(`a simulation that ${name}: no signature, and nothing reaches the RPC again`, async () => {
      standIn.state.entries = entries();
      const gate = new SigningGate();
      gate.arm(terms());
      await assert.rejects(signThroughSdk(gate), refusedSignedTerms(pattern));
      assert.equal(standIn.state.signatures, 0);
      assert.equal(simulations(standIn.state), 1, "the second simulation (which would carry a signature) is never made");
    });
  }

  it("a simulation with two honest entries for the payer: the second is refused, the first never leaves", async () => {
    standIn.state.entries = [entry({ nonce: "7" }), entry({ nonce: "8" })];
    const gate = new SigningGate();
    gate.arm(terms());
    await assert.rejects(signThroughSdk(gate), refusedSignedTerms(/second signature/));
    assert.equal(standIn.state.signatures, 1);
    assert.equal(simulations(standIn.state), 1);
  });

  it("an RPC that answers a later latest ledger than the anchor: the long expiration is refused", async () => {
    const anchor = new SigningAnchor();
    anchor.set(1000);
    const gate = new SigningGate();
    gate.arm(terms({ maxExpiration: anchor.maxExpiration(5, 60) }));
    standIn.state.latest = 50_000;
    await assert.rejects(signThroughSdk(gate), refusedSignedTerms(/ledger 50012/));
    assert.equal(standIn.state.signatures, 0);
  });

  /** The signer the adapter hands the SDK scheme, as the scheme holds it. */
  function registeredSigner(gate: SigningGate) {
    const registered: unknown[] = [];
    const client = { register: (_network: string, scheme: unknown) => registered.push(scheme) };
    stellarChain.registerPayer(client as never, NETWORK, payerKey.secret(), RPC_URL, gate);
    return (registered[0] as { signer: { signAuthEntry: (preimage: string, opts?: { address?: string }) => Promise<unknown> } })
      .signer;
  }

  it("refuses a request to sign for another address than the payer's", async () => {
    const gate = new SigningGate();
    gate.arm(terms());
    await assert.rejects(
      registeredSigner(gate).signAuthEntry(preimage(), { address: ATTACKER }),
      refusedSignedTerms(/another address/),
    );
    assert.equal(standIn.state.signatures, 0);
  });

  it("refuses terms that name another payer than the key it holds", async () => {
    const gate = new SigningGate();
    gate.arm(terms({ payer: ATTACKER }));
    await assert.rejects(registeredSigner(gate).signAuthEntry(preimage({ from: ATTACKER })), refusedSignedTerms(/another payer/));
    assert.equal(standIn.state.signatures, 0);
  });

  it("builds and simulates the payment through the run's RPC, not the SDK's default", async () => {
    const gate = new SigningGate();
    gate.arm(terms());
    await signThroughSdk(gate);
    assert.ok(standIn.state.calls.length >= 3, JSON.stringify(standIn.state.calls));
    for (const [method, url] of standIn.state.calls) assert.equal(url, RPC_URL, method);
  });

  it("an unarmed gate: the client gets no signature", async () => {
    await assert.rejects(signThroughSdk(new SigningGate()), refusedSignedTerms(/expected no signature/));
    assert.equal(standIn.state.signatures, 0);
  });
});

describe("signed terms: what is sent is what was signed", () => {
  let standIn: ReturnType<typeof installStandIn>;
  beforeEach(() => {
    standIn = installStandIn();
  });
  afterEach(() => standIn.undo());

  async function signed() {
    const gate = new SigningGate();
    gate.arm(terms());
    const payload = await signThroughSdk(gate);
    return { gate, transaction: payload.payload["transaction"] as string };
  }

  function rewrite(transaction: string, change: (entry: xdr.SorobanAuthorizationEntry) => void): string {
    const envelope = xdr.TransactionEnvelope.fromXDR(transaction, "base64");
    const auth = envelope.v1().tx().operations()[0]!.body().invokeHostFunctionOp().auth();
    change(auth[0]!);
    return envelope.toXDR("base64");
  }

  it("refuses, as signed and not sent, a payload whose invocation was swapped after signing", async () => {
    const { gate, transaction } = await signed();
    const swapped = rewrite(transaction, (value) => value.rootInvocation(invocation({ to: ATTACKER })));
    assert.throws(
      () => stellarChain.signedTerms?.bind({ transaction: swapped }, gate),
      (error: unknown) => refusedSignedTerms(/invocation/)(error) && /it was not sent/.test((error as Error).message),
    );
  });

  it("refuses a payload whose expiration was changed after signing", async () => {
    const { gate, transaction } = await signed();
    const later = rewrite(transaction, (value) => value.credentials().address().signatureExpirationLedger(9_999_999));
    assert.throws(() => stellarChain.signedTerms?.bind({ transaction: later }, gate), refusedSignedTerms(/expiration/));
  });

  it("refuses a payload whose signature is not the one Wasit made", async () => {
    const { gate, transaction } = await signed();
    const other = rewrite(transaction, (value) => value.credentials().address().signature(xdr.ScVal.scvVoid()));
    assert.throws(() => stellarChain.signedTerms?.bind({ transaction: other }, gate), refusedSignedTerms(/signature/));
  });

  it("refuses a payload whose nonce was changed after signing", async () => {
    const { gate, transaction } = await signed();
    const other = rewrite(transaction, (value) => value.credentials().address().nonce(xdr.Int64.fromString("99")));
    assert.throws(() => stellarChain.signedTerms?.bind({ transaction: other }, gate), refusedSignedTerms(/nonce/));
  });

  function rewriteSignatureField(transaction: string, field: string, change: (bytes: Buffer) => Buffer): string {
    return rewrite(transaction, (value) => {
      const item = value.credentials().address().signature().vec()![0]!;
      for (const entry of item.map() ?? []) {
        if (entry.key().sym().toString() === field) entry.val(xdr.ScVal.scvBytes(change(Buffer.from(entry.val().bytes()))));
      }
    });
  }

  it("refuses a payload whose signature bytes differ from the ones Wasit made", async () => {
    const { gate, transaction } = await signed();
    const other = rewriteSignatureField(transaction, "signature", (bytes) => {
      const copy = Buffer.from(bytes);
      copy[0] = copy[0]! ^ 0xff;
      return copy;
    });
    assert.throws(() => stellarChain.signedTerms?.bind({ transaction: other }, gate), refusedSignedTerms(/signature/));
  });

  it("refuses a payload whose signature names another public key", async () => {
    const { gate, transaction } = await signed();
    const other = rewriteSignatureField(transaction, "public_key", () => Keypair.random().rawPublicKey());
    assert.throws(() => stellarChain.signedTerms?.bind({ transaction: other }, gate), refusedSignedTerms(/signature/));
  });

  it("refuses a payload that carries a second authorization for the payer", async () => {
    const { gate, transaction } = await signed();
    const envelope = xdr.TransactionEnvelope.fromXDR(transaction, "base64");
    const operation = envelope.v1().tx().operations()[0]!.body().invokeHostFunctionOp();
    operation.auth([...operation.auth(), entry({ nonce: "8" })]);
    assert.throws(
      () => stellarChain.signedTerms?.bind({ transaction: envelope.toXDR("base64") }, gate),
      refusedSignedTerms(/2 authorizations/),
    );
  });

  it("refuses a payload that carries an authorization in another credential form", async () => {
    const { gate, transaction } = await signed();
    const other = rewrite(transaction, (value) =>
      value.credentials(xdr.SorobanCredentials.sorobanCredentialsAddressV2(value.credentials().address())),
    );
    assert.throws(() => stellarChain.signedTerms?.bind({ transaction: other }, gate), refusedSignedTerms(/form/));
  });

  it("refuses a payload when nothing was signed through the gate", () => {
    const gate = new SigningGate();
    gate.arm(terms());
    assert.throws(() => stellarChain.signedTerms?.bind({ transaction: "AAAA" }, gate), refusedSignedTerms(/without/));
  });
});

describe("signed terms: every network that can be opted into has the gate", () => {
  it("each mainnet-optin network belongs to an adapter with a signed-terms gate", () => {
    const optIn = [...NETWORK_CLASSES].filter(([, kind]) => kind === "mainnet-optin").map(([network]) => network);
    assert.ok(optIn.length > 0);
    for (const network of optIn) {
      assert.ok(paymentChainFor(network)?.signedTerms, `${network} has no signed-terms gate`);
    }
  });

  it("the Stellar adapter has it on every network it pays on, testnet included", () => {
    assert.deepEqual(stellarChain.networks, ["stellar:testnet", "stellar:pubnet"]);
    assert.ok(stellarChain.signedTerms);
    assert.equal(stellarChain.signedTerms.unitSeconds, 5);
  });
});
