/**
 * MPP-01 in `wasit run` (D-036): the same caps as x402. The plan (L1) reads the
 * unpaid charge challenge before anything is signed: a test network only, an
 * asset Wasit values in dollars, at most $1 a payment, the pin when there is
 * one, and one budget for the run. At the exact challenge about to be signed
 * (L2) the amount, currency and recipient must be the planned ones, and the
 * run's budget is charged before the SDK signs.
 *
 * Written before the code (CONTEXT rule 3). The targets are the official
 * @stellar/mpp charge server in process; the SDK's signer is a stand-in that
 * counts, or an https RPC address that answers nothing. Nothing leaves
 * 127.0.0.1 and no key holds funds.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { charge as chargeClient } from "@stellar/mpp/charge/client";
import { Mppx, Store, charge } from "@stellar/mpp/charge/server";
import { Challenge } from "mppx";

import { classifyCheckError } from "../../src/errors.js";
import { PaymentGuardRefusedError, RunBudget, formatUsd, usdFromDollars } from "../../src/guard/budget.js";
import { setRpcIdentityTransportForTesting } from "../../src/guard/rpc-identity.js";
import { payCharge, runMppChargeChecks, type MppChargeGuard } from "../../src/mpp/charge.js";
import { runMppChargeSuite } from "../../src/mpp/charge-suite.js";
import type { MppNetwork } from "../../src/mpp/network.js";
import {
  MPP_CHARGE_SCHEME,
  combinePaymentPlan,
  describePaymentPlan,
  planMppChargeEndpoint,
  planPaymentRun,
  plannedChargeOf,
} from "../../src/mpp/plan.js";
import type { EndpointPlan, RunPlan } from "../../src/x402/plan.js";

const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const OTHER_SAC = StrKey.encodeContract(randomBytes(32));

interface Listening {
  readonly url: string;
  readonly close: () => Promise<void>;
}

async function listen(handler: http.RequestListener): Promise<Listening> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface ChargeTerms {
  readonly amount?: string;
  readonly currency?: string;
  readonly recipient?: string;
  readonly network?: MppNetwork;
}

const RECIPIENT = Keypair.random().publicKey();

/** The official charge server's listener for one resource priced by `terms` (0.001 USDC on testnet by default). */
function officialCharge(terms: ChargeTerms = {}): http.RequestListener {
  const currency = terms.currency ?? USDC_SAC;
  const recipient = terms.recipient ?? RECIPIENT;
  const network = terms.network ?? "stellar:testnet";
  const mppx = Mppx.create({
    secretKey: "wasit-unit-test-challenge-secret",
    methods: [charge({ recipient, currency, network, store: Store.memory() })],
  });
  return async (req, res) => {
    const result = await Mppx.toNodeListener(mppx.charge({ amount: terms.amount ?? "0.001", currency, recipient }))(req, res);
    if (result.status !== 402) res.end("paid");
  };
}

/** A charge target answering its n-th request with the terms `pick(n)` gives, counting requests and credentials. */
async function chargeTarget(pick: (request: number) => ChargeTerms = () => ({})) {
  const listeners = new Map<string, http.RequestListener>();
  let requests = 0;
  let credentials = 0;
  const target = await listen((req, res) => {
    requests += 1;
    if (req.headers.authorization) credentials += 1;
    const terms = pick(requests);
    const key = JSON.stringify(terms);
    if (!listeners.has(key)) listeners.set(key, officialCharge(terms));
    return listeners.get(key)!(req, res);
  });
  return { ...target, requests: () => requests, credentials: () => credentials };
}

/** An https RPC address on 127.0.0.1 that counts connections and drops each one: a connection is the SDK at work. */
async function countingRpc() {
  let calls = 0;
  const server = net.createServer((socket) => {
    calls += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `https://127.0.0.1:${port}`,
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The SDK's charge client with a signer that counts and records the budget it saw, signing nothing. */
function countingMethod(budget?: RunBudget) {
  const sdk = chargeClient({ secretKey: Keypair.random().secret() });
  const seen: bigint[] = [];
  const method = {
    ...sdk,
    createCredential: async () => {
      seen.push(budget?.spentUsd ?? 0n);
      return "wasit-unit-test-credential";
    },
  } as typeof sdk;
  return { method, signed: () => seen.length, spentWhenSigned: () => seen };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a refusal");
}

const PLANNED = { amount: 10_000n, currency: USDC_SAC, recipient: RECIPIENT };

describe("the plan of MPP-01 (planMppChargeEndpoint)", () => {
  it("plans one signature of the advertised amount, in dollars, on a test network", async () => {
    const target = await chargeTarget();
    try {
      const plan = await planMppChargeEndpoint("stellar:testnet", { name: "chat", target: target.url });
      assert.equal(plan.status, "planned", plan.reason ?? "");
      assert.equal(plan.option?.scheme, MPP_CHARGE_SCHEME);
      assert.equal(plan.option?.payTo, RECIPIENT);
      assert.equal(plan.option?.asset, USDC_SAC);
      assert.deepEqual(plan.signatures, [{ check: "MPP-01", amount: 10_000n }]);
      assert.equal(plan.worstCase, 10_000n);
      assert.equal(formatUsd(plan.worstCaseUsd), "$0.001");
      assert.deepEqual(plannedChargeOf(plan), PLANNED);
      assert.equal(target.credentials(), 0);
    } finally {
      await target.close();
    }
  });

  it("refuses a price above $1 a payment, signing nothing", async () => {
    const target = await chargeTarget(() => ({ amount: "1.5" }));
    try {
      const plan = await planMppChargeEndpoint("stellar:testnet", { name: "chat", target: target.url });
      assert.equal(plan.status, "refused");
      assert.match(plan.reason ?? "", /15000000 base units of USDC \(\$1\.50\), above the \$1\.00 per payment/);
      assert.equal(plan.worstCaseUsd, 0n);
      assert.equal(plannedChargeOf(plan), undefined);
    } finally {
      await target.close();
    }
  });

  it("refuses an asset Wasit does not value in dollars", async () => {
    const target = await chargeTarget(() => ({ currency: OTHER_SAC }));
    try {
      const plan = await planMppChargeEndpoint("stellar:testnet", { name: "chat", target: target.url });
      assert.equal(plan.status, "refused");
      assert.match(plan.reason ?? "", /an asset Wasit does not value in US dollars/);
    } finally {
      await target.close();
    }
  });

  it("refuses a challenge for another network than the run's", async () => {
    const target = await chargeTarget(() => ({ network: "stellar:pubnet" }));
    try {
      const plan = await planMppChargeEndpoint("stellar:testnet", { name: "chat", target: target.url });
      assert.equal(plan.status, "refused");
      assert.match(plan.reason ?? "", /asks to be paid on stellar:pubnet, and this run pays on stellar:testnet only/);
    } finally {
      await target.close();
    }
  });

  it("holds the charge to the environment's pin: recipient and currency", async () => {
    const target = await chargeTarget();
    try {
      const other = Keypair.random().publicKey();
      const recipient = await planMppChargeEndpoint("stellar:testnet", { name: "chat", target: target.url }, { payTo: other, asset: USDC_SAC });
      assert.equal(recipient.status, "refused");
      assert.match(recipient.reason ?? "", new RegExp(`recipient "${RECIPIENT}", not the pinned ${other}`));
      const currency = await planMppChargeEndpoint("stellar:testnet", { name: "chat", target: target.url }, { payTo: RECIPIENT, asset: OTHER_SAC });
      assert.equal(currency.status, "refused");
      assert.match(currency.reason ?? "", /currency "C[A-Z2-7]{55}", not the pinned/);
      const pinned = await planMppChargeEndpoint("stellar:testnet", { name: "chat", target: target.url }, { payTo: RECIPIENT, asset: USDC_SAC });
      assert.equal(pinned.status, "planned", pinned.reason ?? "");
    } finally {
      await target.close();
    }
  });

  it("refuses stellar:pubnet before any request (L0)", async () => {
    const target = await chargeTarget();
    try {
      const error = await rejection(planMppChargeEndpoint("stellar:pubnet", { name: "chat", target: target.url }));
      assert.match(String((error as Error).message), /MPP stays on test networks/);
      assert.equal(target.requests(), 0);
    } finally {
      await target.close();
    }
  });

  it("says why an endpoint whose challenge cannot be read is not paid", async () => {
    const target = await listen((_req, res) => res.end("free"));
    try {
      const plan = await planMppChargeEndpoint("stellar:testnet", { name: "chat", target: target.url });
      assert.equal(plan.status, "not-paid");
      assert.match(plan.reason ?? "", /Expected HTTP 402 with a payment challenge, got 200/);
    } finally {
      await target.close();
    }
  });

  it("does not plan an amount that is not whole base units: below zero, hex, padded, a decimal or an exponent", async () => {
    for (const amount of ["-30000000000", "0x989680", " 10000000 ", "0.5", "1e3"]) {
      const target = await handMadeChargeTarget({ amount, currency: USDC_SAC, recipient: RECIPIENT });
      try {
        const plan = await planMppChargeEndpoint("stellar:testnet", { name: "chat", target: target.url });
        assert.equal(plan.status, "not-paid", `${JSON.stringify(amount)}: ${plan.reason ?? ""}`);
        assert.match(plan.reason ?? "", /not a whole number of base units/, JSON.stringify(amount));
        assert.equal(plan.worstCaseUsd, 0n);
        assert.equal(plannedChargeOf(plan), undefined);
        assert.equal(target.credentials(), 0);
      } finally {
        await target.close();
      }
    }
  });
});

/** A target answering every request with one hand-made charge challenge: terms the official server never writes. */
async function handMadeChargeTarget(request: Record<string, unknown>) {
  const header = Challenge.serialize(
    Challenge.from({ id: "hand-made-charge", realm: "127.0.0.1", method: "stellar", intent: "charge", request }),
  );
  let credentials = 0;
  const target = await listen((req, res) => {
    if (req.headers.authorization) credentials += 1;
    res.writeHead(402, { "WWW-Authenticate": header });
    res.end();
  });
  return { ...target, credentials: () => credentials };
}

/** An x402 plan with one planned endpoint of `usd` dollars, under a cap of `capUsd`. */
function x402Plan(usd: number, capUsd = 5, capLowered = false): RunPlan {
  const endpoint: EndpointPlan = {
    name: "weather",
    status: "planned",
    option: { scheme: "exact", network: "stellar:testnet", payTo: RECIPIENT, asset: USDC_SAC, amount: 1n, maxTimeoutSeconds: 60 },
    signatures: [{ check: "X402-06", amount: 1n }],
    worstCase: 1n,
    worstCaseUsd: usdFromDollars(usd),
  };
  return {
    network: "stellar:testnet",
    perPaymentCapUsd: usdFromDollars(1),
    capUsd: usdFromDollars(capUsd),
    capLowered,
    endpoints: [endpoint],
    worstCaseUsd: usdFromDollars(usd),
  };
}

function mppEntry(name: string, usd: number): EndpointPlan {
  return {
    name,
    status: "planned",
    option: { scheme: MPP_CHARGE_SCHEME, network: "stellar:testnet", payTo: RECIPIENT, asset: USDC_SAC, amount: 10_000n, maxTimeoutSeconds: 0 },
    signatures: [{ check: "MPP-01", amount: 10_000n }],
    worstCase: 10_000n,
    worstCaseUsd: usdFromDollars(usd),
  };
}

describe("one plan and one cap for x402 and MPP-01 (combinePaymentPlan)", () => {
  it("is the x402 plan itself when there is no MPP-01 entry", () => {
    const plan = x402Plan(1);
    assert.equal(combinePaymentPlan(plan, []), plan);
  });

  it("adds the worst cases and keeps both kinds of entry", () => {
    const plan = combinePaymentPlan(x402Plan(1), [mppEntry("chat", 0.5)]);
    assert.equal(formatUsd(plan.worstCaseUsd), "$1.50");
    assert.deepEqual(plan.endpoints.map((entry) => entry.name), ["weather", "chat"]);
    assert.equal(plan.refusal, undefined);
  });

  it("refuses the run when the sum is above the cap, though each part fits", () => {
    const plan = combinePaymentPlan(x402Plan(4.5), [mppEntry("chat", 0.9)]);
    assert.match(plan.refusal ?? "", /This run could spend up to \$5\.40 \(weather \$4\.50, chat \$0\.90\), above the \$5\.00 per run\. Nothing was signed\./);
  });

  it("names maxRunUsd when it lowered the cap", () => {
    const plan = combinePaymentPlan(x402Plan(0.5, 1, true), [mppEntry("chat", 0.9)]);
    assert.match(plan.refusal ?? "", /above the \$1\.00 per run set by maxRunUsd/);
  });

  it("never lets an entry lower the sum: a worst case below zero refuses the run", () => {
    const belowZero: EndpointPlan = { ...mppEntry("chat", 0), worstCaseUsd: -usdFromDollars(3000) };
    for (const x402 of [x402Plan(6), x402Plan(1)]) {
      const plan = combinePaymentPlan(x402, [belowZero]);
      assert.match(plan.refusal ?? "", /a worst case below zero for chat, which is not a price\. Nothing was signed\./);
    }
  });

  it("still refuses an x402 plan above the cap when an MPP-01 challenge asks a negative amount", async () => {
    const target = await handMadeChargeTarget({ amount: "-30000000000", currency: USDC_SAC, recipient: RECIPIENT });
    try {
      const entry = await planMppChargeEndpoint("stellar:testnet", { name: "chat", target: target.url });
      const plan = combinePaymentPlan(x402Plan(6), [entry]);
      assert.equal(formatUsd(plan.worstCaseUsd), "$6.00");
      assert.match(plan.refusal ?? "", /This run could spend up to \$6\.00 \(weather \$6\.00\), above the \$5\.00 per run\./);
    } finally {
      await target.close();
    }
  });

  it("does not count an entry that is not planned", () => {
    const refused: EndpointPlan = { name: "pricey", status: "refused", reason: "above the cap", signatures: [], worstCase: 0n, worstCaseUsd: 0n };
    const plan = combinePaymentPlan(x402Plan(4.5), [refused, mppEntry("chat", 0.4)]);
    assert.equal(formatUsd(plan.worstCaseUsd), "$4.90");
    assert.equal(plan.refusal, undefined);
  });

  it("describes the plan with a first line that names MPP-01", () => {
    const both = describePaymentPlan(combinePaymentPlan(x402Plan(1), [mppEntry("chat", 0.5)]), { x402: true, mppCharge: true });
    assert.equal(both[0], "Plan (dry run): x402 payment checks and MPP-01 on stellar:testnet. Nothing is signed or sent.");
    assert.ok(both.some((line) => /MPP-01 10000 \(base units\)/.test(line)), both.join("\n"));
    const mppOnly = describePaymentPlan(combinePaymentPlan(x402Plan(0), [mppEntry("chat", 0.5)]), { x402: false, mppCharge: true });
    assert.equal(mppOnly[0], "Plan (dry run): MPP-01 on stellar:testnet. Nothing is signed or sent.");
    const x402Only = describePaymentPlan(x402Plan(1), { x402: true, mppCharge: false });
    assert.equal(x402Only[0], "Plan (dry run): x402 payment checks on stellar:testnet. Nothing is signed or sent.");
    // A run of channel endpoints only: nothing it signs is a payment, and the first line does not name x402.
    const channelOnly = describePaymentPlan({ ...x402Plan(0), endpoints: [], worstCaseUsd: 0n }, { x402: false, mppCharge: false });
    assert.equal(channelOnly[0], "Plan (dry run): no payment to plan (no x402 or MPP charge endpoint) on stellar:testnet. Nothing is signed or sent.");
  });
});

describe("planPaymentRun", () => {
  it("plans MPP-01 endpoints against one cap; maxRunUsd can refuse the run", async () => {
    const target = await chargeTarget();
    try {
      const endpoints = [
        { name: "a", target: `${target.url}/a` },
        { name: "b", target: `${target.url}/b` },
      ];
      const plan = await planPaymentRun({ network: "stellar:testnet", x402: [], mppCharge: endpoints });
      assert.equal(plan.refusal, undefined);
      assert.equal(formatUsd(plan.worstCaseUsd), "$0.002");
      const lowered = await planPaymentRun({ network: "stellar:testnet", maxRunUsd: 0.0015, x402: [], mppCharge: endpoints });
      assert.match(lowered.refusal ?? "", /up to \$0\.002 \(a \$0\.001, b \$0\.001\), above the \$0\.0015 per run set by maxRunUsd/);
      assert.equal(target.credentials(), 0);
    } finally {
      await target.close();
    }
  });

  it("refuses stellar:pubnet before any request when it has MPP-01 endpoints", async () => {
    const target = await chargeTarget();
    try {
      await rejection(planPaymentRun({ network: "stellar:pubnet", x402: [], mppCharge: [{ name: "a", target: target.url }] }));
      assert.equal(target.requests(), 0);
    } finally {
      await target.close();
    }
  });
});

describe("MPP-01 at the signature, with a run's guard (payCharge)", () => {
  it("charges the run's budget before the SDK signs the planned charge", async () => {
    const target = await chargeTarget();
    const budget = new RunBudget();
    const { method, signed, spentWhenSigned } = countingMethod(budget);
    try {
      await payCharge(target.url, "stellar:testnet", method, { budget, planned: PLANNED });
      assert.equal(signed(), 1);
      assert.equal(formatUsd(spentWhenSigned()[0]!), "$0.001");
      assert.equal(budget.entries.length, 1);
      assert.equal(budget.entries[0]?.check, "MPP-01");
      assert.equal(budget.entries[0]?.amount, 10_000n);
    } finally {
      await target.close();
    }
  });

  for (const [what, terms] of [
    ["amount", { amount: "0.002" }],
    ["recipient", { recipient: Keypair.random().publicKey() }],
    ["currency", { currency: OTHER_SAC }],
  ] as const) {
    it(`refuses a challenge whose ${what} changed after the plan, signing nothing and charging nothing`, async () => {
      const target = await chargeTarget(() => terms);
      const budget = new RunBudget();
      const { method, signed } = countingMethod(budget);
      try {
        const error = await rejection(payCharge(target.url, "stellar:testnet", method, { budget, planned: PLANNED }));
        assert.ok(error instanceof PaymentGuardRefusedError, String(error));
        assert.equal(error.reason, "plan");
        assert.match(error.message, new RegExp(`${what} .*\\(planned`));
        assert.match(error.message, /Nothing was signed\./);
        assert.equal(signed(), 0);
        assert.equal(budget.spentUsd, 0n);
        assert.equal(target.credentials(), 0);
      } finally {
        await target.close();
      }
    });
  }

  it("refuses when the run's cap has no room for the charge", async () => {
    const target = await chargeTarget();
    const budget = new RunBudget({ maxRunUsd: 0.0005 });
    const { method, signed } = countingMethod(budget);
    try {
      const error = await rejection(payCharge(target.url, "stellar:testnet", method, { budget, planned: PLANNED }));
      assert.ok(error instanceof PaymentGuardRefusedError);
      assert.equal(error.reason, "run-cap");
      assert.equal(signed(), 0);
      assert.equal(target.credentials(), 0);
    } finally {
      await target.close();
    }
  });

  it("pays nothing for an endpoint the plan did not plan", async () => {
    const target = await chargeTarget();
    const budget = new RunBudget();
    const { method, signed } = countingMethod(budget);
    try {
      const guard: MppChargeGuard = { budget, notPlanned: "its challenge could not be read" };
      const error = await rejection(payCharge(target.url, "stellar:testnet", method, guard));
      assert.ok(error instanceof PaymentGuardRefusedError);
      assert.match(error.message, /did not plan a payment for this endpoint, so MPP-01 does not pay it\. The plan says: its challenge could not be read\. Nothing was signed\./);
      assert.equal(signed(), 0);
    } finally {
      await target.close();
    }
  });

  it("still pays without a guard, as wasit mpp-charge does", async () => {
    const target = await chargeTarget(() => ({ amount: "2" }));
    const { method, signed } = countingMethod();
    try {
      await payCharge(target.url, "stellar:testnet", method);
      assert.equal(signed(), 1);
    } finally {
      await target.close();
    }
  });
});

describe("MPP-01 with a run's guard (runMppChargeChecks)", () => {
  beforeEach(() => setRpcIdentityTransportForTesting(async () => ({ passphrase: Networks.TESTNET })));
  afterEach(() => setRpcIdentityTransportForTesting(undefined));

  it("reads an endpoint the plan did not plan, unpaid, and pays it nothing", async () => {
    const target = await chargeTarget();
    const rpc = await countingRpc();
    try {
      const error = await rejection(
        runMppChargeChecks({
          target: target.url,
          network: "stellar:testnet",
          payerSecretKey: Keypair.random().secret(),
          rpcUrl: rpc.url,
          guard: { budget: new RunBudget(), notPlanned: "it is priced above the cap. Nothing was signed." },
        }),
      );
      assert.equal(classifyCheckError(error).kind, "setup");
      assert.match(String((error as Error).message), /The plan says: it is priced above the cap\. Nothing was signed\.$/);
      assert.equal(target.requests(), 1);
      assert.equal(target.credentials(), 0);
      assert.equal(rpc.calls(), 0);
    } finally {
      await target.close();
      await rpc.close();
    }
  });

  it("still gives the target its verdict when the plan could not read its challenge and it still answers without one", async () => {
    const target = await listen((_req, res) => res.end("free"));
    const rpc = await countingRpc();
    try {
      const results = await runMppChargeSuite({
        target: target.url,
        network: "stellar:testnet",
        payerSecretKey: Keypair.random().secret(),
        rpcUrl: rpc.url,
        guard: { budget: new RunBudget(), notPlanned: "Expected HTTP 402 with a payment challenge, got 200." },
      });
      assert.equal(results[0]?.pass, false);
      assert.equal(results[0]?.error, undefined, "a verdict, not a setup error");
      assert.match(results[0]?.detail ?? "", /did not conform: Expected HTTP 402 with a payment challenge, got 200/);
      assert.equal(rpc.calls(), 0);
    } finally {
      await target.close();
      await rpc.close();
    }
  });

  it("refuses when the challenge the check reads is not the planned one, before the SDK is built", async () => {
    const target = await chargeTarget(() => ({ amount: "0.002" }));
    const rpc = await countingRpc();
    try {
      const error = await rejection(
        runMppChargeChecks({
          target: target.url,
          network: "stellar:testnet",
          payerSecretKey: Keypair.random().secret(),
          rpcUrl: rpc.url,
          guard: { budget: new RunBudget(), planned: PLANNED },
        }),
      );
      assert.equal(classifyCheckError(error).kind, "setup");
      assert.match(String((error as Error).message), /amount "20000" \(planned 10000\)/);
      assert.equal(target.requests(), 1);
      assert.equal(target.credentials(), 0);
      assert.equal(rpc.calls(), 0);
    } finally {
      await target.close();
      await rpc.close();
    }
  });

  it("reports a refusal at the paid request as no verdict (setup), never as the target's failure", async () => {
    // The planned price for the check's read, a higher one for the request mppx pays.
    const target = await chargeTarget((request) => (request === 1 ? {} : { amount: "0.002" }));
    const rpc = await countingRpc();
    const budget = new RunBudget();
    try {
      const results = await runMppChargeSuite({
        target: target.url,
        network: "stellar:testnet",
        payerSecretKey: Keypair.random().secret(),
        rpcUrl: rpc.url,
        guard: { budget, planned: PLANNED },
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.id, "MPP-01");
      assert.equal(results[0]?.error?.kind, "setup", results[0]?.detail);
      assert.doesNotMatch(results[0]?.detail ?? "", /Payment attempt failed/);
      assert.equal(budget.spentUsd, 0n);
      assert.equal(target.credentials(), 0);
      assert.equal(rpc.calls(), 0);
    } finally {
      await target.close();
      await rpc.close();
    }
  });

  it("charges the budget, then builds the payment through the run's RPC", async () => {
    const target = await chargeTarget();
    const rpc = await countingRpc();
    const budget = new RunBudget();
    try {
      // The RPC stand-in drops the payer's account lookup, so the SDK fails after the charge, before it signs.
      await rejection(
        runMppChargeChecks({
          target: target.url,
          network: "stellar:testnet",
          payerSecretKey: Keypair.random().secret(),
          rpcUrl: rpc.url,
          guard: { budget, planned: PLANNED },
        }),
      );
      assert.equal(formatUsd(budget.spentUsd), "$0.001");
      assert.ok(rpc.calls() > 0, "the SDK never reached the run's RPC");
      assert.equal(target.credentials(), 0);
    } finally {
      await target.close();
      await rpc.close();
    }
  });
});
