/**
 * L1 of a mainnet run (spec B3, B4, B17.2, B17.5, B18 O1), written before the
 * code (B11): with an opt-in, the plan first reads the token's decimals, the
 * payer's USDC through the RPC and on public Horizon, and the RPC's latest
 * ledger beside Horizon's, before the target is asked anything; then it
 * plans each endpoint by the mainnet rules. Any refusal stops the opt-in, and
 * nothing is signed.
 *
 * Offline: test/support/pubnet-chain.ts. No key here has ever held funds.
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import { ConfigurationError } from "../../src/errors.js";
import { RunBudget, formatUsd, usdFromDollars } from "../../src/guard/budget.js";
import { MainnetPayerRefusedError } from "../../src/guard/mainnet-payer.js";
import { MainnetPlanRefusedError } from "../../src/guard/mainnet-plan.js";
import { openMainnetOptIn } from "../../src/guard/mainnet-run.js";
import { PaymentNetworkRefusedError } from "../../src/guard/networks.js";
import type { MainnetOptIn } from "../../src/guard/optin.js";
import { describePlan, mainnetFirstLine, planX402Run } from "../../src/x402/plan.js";
import { paywall, type Paywall } from "../support/recording-chain.js";
import { PUBNET, PUBNET_RPC, PUBNET_USDC, installPubnetWorld, pubnetOption, type PubnetWorld } from "../support/pubnet-chain.js";

const PAYER_KEY = Keypair.random();
const PAY_TO = Keypair.random().publicKey();
/** 0.01 USDC. */
const CENT = 100_000n;

let world: PubnetWorld;
let dir: string;
let walls: Paywall[] = [];
let optIn: MainnetOptIn;

async function wall(amount: bigint, overrides: Parameters<typeof pubnetOption>[2] = {}): Promise<Paywall> {
  const created = await paywall([pubnetOption(PAY_TO, amount, overrides)]);
  walls.push(created);
  return created;
}

async function openOptIn(budget?: RunBudget): Promise<MainnetOptIn> {
  return openMainnetOptIn({
    frontEnd: "cli",
    env: { WASIT_MAINNET_PAYER_SECRET: PAYER_KEY.secret() },
    environment: "mainnet",
    network: PUBNET,
    operatedByMe: true,
    pin: { payTo: PAY_TO, asset: PUBNET_USDC },
    rpcUrl: PUBNET_RPC,
    ledgerDir: dir,
    ...(budget === undefined ? {} : { budget }),
  });
}

beforeEach(async () => {
  world = await installPubnetWorld();
  dir = mkdtempSync(path.join(tmpdir(), "wasit-plan-"));
  optIn = await openOptIn();
});

afterEach(async () => {
  optIn.close();
  for (const created of walls) await created.close();
  walls = [];
  await world.close();
  rmSync(dir, { recursive: true, force: true });
});

async function refusedPlan(endpoints: { name: string; target: string }[], kind: new (...args: never[]) => Error): Promise<Error> {
  const error = await planX402Run({ network: PUBNET, endpoints, mainnet: optIn }).then(
    () => undefined,
    (caught: unknown) => caught as Error,
  );
  assert.ok(error instanceof kind, `expected ${kind.name}, got ${String(error)}`);
  assert.ok(error instanceof ConfigurationError);
  assert.equal(optIn.stopped, error.message, "a refused plan leaves the opt-in live");
  assert.equal(optIn.plan, undefined);
  assert.equal(world.signed.length, 0);
  return error;
}

describe("the plan of a mainnet run", () => {
  it("reads the chain and Horizon, plans the endpoint, and records the plan on the opt-in", async () => {
    const weather = await wall(CENT);
    const plan = await planX402Run({ network: PUBNET, endpoints: [{ name: "weather", target: weather.url }], mainnet: optIn });
    assert.equal(plan.refusal, undefined);
    assert.equal(plan.network, PUBNET);
    assert.deepEqual(plan.pin, optIn.pin);
    assert.equal(plan.endpoints[0]?.status, "planned");
    // 06 + 07 + 09 + 10 at 0.01 USDC: 0.035.
    assert.equal(formatUsd(plan.worstCaseUsd), "$0.035");
    assert.ok(plan.mainnet !== undefined);
    assert.equal(plan.mainnet.payer, PAYER_KEY.publicKey());
    assert.equal(plan.mainnet.decimals, 7);
    assert.equal(plan.mainnet.usdc, 50_000_000n);
    assert.equal(plan.mainnet.native, 25_000_000n);
    assert.equal(plan.mainnet.rpcLatest, 61_000_000);
    assert.equal(plan.mainnet.horizonLatest, 61_000_002);
    assert.equal(plan.mainnet.remainingUsd, usdFromDollars(5));
    assert.equal(optIn.plan, plan);
    assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.endpoints[0]) && Object.isFrozen(plan.endpoints[0]!.signatures[0]));
    assert.equal(optIn.stopped, undefined);
    assert.equal(world.signed.length, 0, "the plan signs nothing");
    for (const read of ["assetDecimals", "payerBalance", "latestUnit"]) assert.ok(world.reads.includes(read), read);
    assert.ok(world.horizonRequests.includes("/"));
    assert.ok(world.horizonRequests.includes(`/accounts/${PAYER_KEY.publicKey()}`));
  });

  it("states the run in its first line, and the plan names both hosts and the balance", async () => {
    const weather = await wall(CENT);
    const plan = await planX402Run({ network: PUBNET, endpoints: [{ name: "weather", target: weather.url }], mainnet: optIn });
    assert.equal(
      mainnetFirstLine(plan),
      `MAINNET RUN on stellar:pubnet: real funds. Payer ${PAYER_KEY.publicKey()}; pays only ${PAY_TO} in USDC; ` +
        `at most $1.00 per payment; this run could spend up to $0.035 of the $5.00 cap.`,
    );
    const text = describePlan(plan).join("\n");
    assert.match(text, /rpc\.example/);
    assert.match(text, /horizon|127\.0\.0\.1/i);
    assert.match(text, /\$5\.00 in USDC|5\.0000000/);
  });

  it("reads before the target is asked anything: a refused read sends the target nothing", async () => {
    const weather = await wall(CENT);
    world.state.decimals = 6;
    await refusedPlan([{ name: "weather", target: weather.url }], MainnetPlanRefusedError);
    assert.equal(weather.paid, 0);
    assert.equal(world.horizonRequests.length, 0, "Horizon was asked before the decimals were checked");
  });

  it("refuses decimals that are not the number 7", async () => {
    for (const decimals of [6, 8, "7", undefined]) {
      optIn.close();
      optIn = await openOptIn();
      world.state.decimals = decimals;
      await refusedPlan([], MainnetPlanRefusedError);
    }
  });

  it("refuses a payer above $10, and a balance the RPC cannot read", async () => {
    world.state.rpcUsdc = 100_000_001n;
    world.state.horizonUsdc = 100_000_001n;
    await refusedPlan([], MainnetPayerRefusedError);
    optIn.close();
    optIn = await openOptIn();
    world.state.rpcUsdc = undefined;
    await refusedPlan([], MainnetPayerRefusedError);
  });

  it("passes a payer at exactly $10", async () => {
    world.state.rpcUsdc = 100_000_000n;
    world.state.horizonUsdc = 100_000_000n;
    const plan = await planX402Run({ network: PUBNET, endpoints: [], mainnet: optIn });
    assert.equal(plan.mainnet?.usdc, 100_000_000n);
  });

  it("refuses when the RPC and Horizon disagree on the payer's USDC, or Horizon cannot be read", async () => {
    world.state.horizonUsdc = 49_999_999n;
    await refusedPlan([], MainnetPlanRefusedError);
    for (const change of [
      () => {
        world.state.horizonStatus = 500;
      },
      () => {
        world.state.horizonPassphrase = "Test SDF Network ; September 2015";
      },
      () => {
        world.state.horizonUsdc = undefined;
      },
    ]) {
      optIn.close();
      optIn = await openOptIn();
      Object.assign(world.state, { horizonUsdc: 50_000_000n, horizonStatus: 200, horizonPassphrase: "Public Global Stellar Network ; September 2015" });
      change();
      await refusedPlan([], MainnetPlanRefusedError);
    }
  });

  it("holds the RPC's latest ledger to Horizon's: 12 ledgers apart pass, 13 do not", async () => {
    world.state.horizonLatest = world.state.rpcLatest + 12;
    await planX402Run({ network: PUBNET, endpoints: [], mainnet: optIn });
    optIn.close();
    optIn = await openOptIn();
    world.state.horizonLatest = world.state.rpcLatest - 13;
    await refusedPlan([], MainnetPlanRefusedError);
  });

  it("refuses the whole run when one endpoint breaks a mainnet rule, and names it", async () => {
    const cases: Array<[string, Parameters<typeof pubnetOption>[2], bigint]> = [
      ["lifetime above 300 s", { maxTimeoutSeconds: 301 }, CENT],
      ["another asset", { asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" }, CENT],
      ["another payee", { payTo: Keypair.random().publicKey() }, CENT],
      ["above $1", {}, 10_000_001n],
      ["no option on stellar:pubnet", { network: "stellar:testnet" as never }, CENT],
    ];
    for (const [label, overrides, amount] of cases) {
      optIn.close();
      optIn = await openOptIn();
      const good = await wall(CENT);
      const bad = await wall(amount, overrides);
      const plan = await planX402Run({
        network: PUBNET,
        endpoints: [
          { name: "good", target: good.url },
          { name: "bad", target: bad.url },
        ],
        mainnet: optIn,
      });
      assert.ok(plan.refusal !== undefined, `${label}: the run was not refused`);
      assert.match(plan.refusal, /bad/, `${label}: the refusal does not name the endpoint`);
      assert.match(plan.refusal, /Nothing was signed/);
      assert.equal(optIn.stopped, plan.refusal, `${label}: the opt-in is still live`);
      assert.equal(optIn.plan, undefined, `${label}: a refused plan was recorded`);
      assert.equal(world.signed.length, 0);
    }
  });

  it("refuses two endpoints at $1 each: $7.00 (3.5 times each price, no reject case) is above the $5.00", async () => {
    const one = await wall(10_000_000n);
    const two = await wall(10_000_000n);
    const plan = await planX402Run({
      network: PUBNET,
      endpoints: [
        { name: "one", target: one.url },
        { name: "two", target: two.url },
      ],
      mainnet: optIn,
    });
    assert.match(plan.refusal ?? "", /\$7\.00/);
    assert.equal(optIn.stopped, plan.refusal);
  });

  it("holds the worst case to what is left of a shared budget (the MCP server's, D-018)", async () => {
    optIn.close();
    const shared = new RunBudget();
    // Earlier runs of the same server process charged $4.98 (five payments of $0.996).
    for (let paid = 0; paid < 5; paid += 1) {
      shared.charge({ check: "X402-06", network: "stellar:testnet", asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", amount: "9960000" });
    }
    optIn = await openOptIn(shared);
    const weather = await wall(CENT);
    const plan = await planX402Run({ network: PUBNET, endpoints: [{ name: "weather", target: weather.url }], mainnet: optIn });
    assert.equal(plan.mainnet?.remainingUsd, usdFromDollars(0.02));
    assert.match(plan.refusal ?? "", /\$0\.035/);
    assert.equal(optIn.stopped, plan.refusal);
  });

  it("plans once per opt-in, with its own pin and cap only", async () => {
    const weather = await wall(CENT);
    const endpoints = [{ name: "weather", target: weather.url }];
    await planX402Run({ network: PUBNET, endpoints, mainnet: optIn });
    const asked = { horizon: world.horizonRequests.length, reads: world.reads.length };
    await assert.rejects(planX402Run({ network: PUBNET, endpoints, mainnet: optIn }), /planned once/);
    assert.ok(optIn.stopped !== undefined, "a second plan leaves the run live");
    assert.deepEqual({ horizon: world.horizonRequests.length, reads: world.reads.length }, asked, "a second plan read the chain again");

    optIn.close();
    optIn = await openOptIn();
    await assert.rejects(
      planX402Run({ network: PUBNET, endpoints, mainnet: optIn, pin: { payTo: Keypair.random().publicKey(), asset: PUBNET_USDC } }),
      ConfigurationError,
    );
    optIn.close();
    optIn = await openOptIn();
    await assert.rejects(planX402Run({ network: PUBNET, endpoints, mainnet: optIn, maxRunUsd: 1 }), ConfigurationError);
    optIn.close();
    optIn = await openOptIn();
    // The same pin, given again, is the opt-in's.
    await planX402Run({ network: PUBNET, endpoints, mainnet: optIn, pin: { payTo: PAY_TO, asset: PUBNET_USDC } });
  });

  it("does not plan with a stopped or closed opt-in, nor on another network with it", async () => {
    const weather = await wall(CENT);
    const endpoints = [{ name: "weather", target: weather.url }];
    optIn.stop("stopped for the test");
    await assert.rejects(planX402Run({ network: PUBNET, endpoints, mainnet: optIn }), PaymentNetworkRefusedError);
    optIn.close();
    optIn = await openOptIn();
    await assert.rejects(planX402Run({ network: "stellar:testnet", endpoints, mainnet: optIn }), ConfigurationError);
    optIn.close();
    await assert.rejects(planX402Run({ network: PUBNET, endpoints, mainnet: optIn }), PaymentNetworkRefusedError);
    assert.equal(weather.paid, 0);
  });

  it("stops the run on anything that stops its plan, not only a refusal", async () => {
    // A list that fails when it is read, after the chain reads: no refusal of the guard, an unexpected failure.
    const broken = {
      [Symbol.iterator](): never {
        throw new Error("an unexpected failure");
      },
    } as unknown as { name: string; target: string }[];
    await assert.rejects(planX402Run({ network: PUBNET, endpoints: broken, mainnet: optIn }), /an unexpected failure/);
    assert.ok(optIn.stopped !== undefined, "the run is still live after its plan failed");
    assert.equal(optIn.plan, undefined);
  });

  it("records where each endpoint pays, origin and path only, and prints it", async () => {
    const weather = await wall(CENT);
    const plan = await planX402Run({
      network: PUBNET,
      endpoints: [{ name: "weather", target: `${weather.url}?token=abc123#part` }],
      mainnet: optIn,
    });
    assert.equal(plan.refusal, undefined, plan.refusal ?? "");
    assert.equal(plan.endpoints[0]?.url, weather.url, "the plan does not say where it pays, or keeps the query");
    assert.ok(!JSON.stringify(plan, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)).includes("abc123"));
    const text = describePlan(plan).join("\n");
    assert.ok(text.includes(weather.url), "the plan's text does not show where it pays");
    assert.ok(!text.includes("abc123"), "the plan's text shows the query");
  });

  it("refuses an endpoint that redirects to another path when the plan reads it: it pays the config's URL only", async () => {
    const challenge = Buffer.from(
      JSON.stringify({ x402Version: 2, resource: { url: "http://127.0.0.1/elsewhere" }, accepts: [pubnetOption(PAY_TO, CENT)] }),
    ).toString("base64");
    const server = http.createServer((request, response) => {
      request.on("data", () => undefined);
      request.on("end", () => {
        if (request.url === "/paid") {
          response.writeHead(307, { location: "/elsewhere" });
          response.end();
          return;
        }
        response.writeHead(402, { "content-type": "application/json", "payment-required": challenge });
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}/paid`;
      const plan = await planX402Run({ network: PUBNET, endpoints: [{ name: "redirected", target }], mainnet: optIn });
      assert.equal(plan.endpoints[0]?.status, "refused");
      assert.match(plan.endpoints[0]?.reason ?? "", /redirect/);
      assert.match(plan.refusal ?? "", /redirected/);
      assert.equal(optIn.stopped, plan.refusal);
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    }
  });

  it("refuses an endpoint that is not https, unless it is on this machine, before any request", async () => {
    const plan = await planX402Run({
      network: PUBNET,
      endpoints: [{ name: "plain", target: "http://wasit-endpoint.invalid/paid" }],
      mainnet: optIn,
    });
    assert.equal(plan.endpoints[0]?.status, "refused");
    assert.match(plan.endpoints[0]?.reason ?? "", /pays an https endpoint only/);
    assert.match(plan.refusal ?? "", /plain/);
    assert.equal(optIn.stopped, plan.refusal);
  });

  it("refuses an endpoint whose URL carries a user name or password, without echoing them", async () => {
    const plan = await planX402Run({
      network: PUBNET,
      endpoints: [{ name: "hidden", target: "https://api.example.com:s3cretword@wasit-endpoint.invalid/paid" }],
      mainnet: optIn,
    });
    assert.equal(plan.endpoints[0]?.status, "refused");
    assert.match(plan.endpoints[0]?.reason ?? "", /user name or password/);
    assert.ok(!(plan.refusal ?? "").includes("s3cretword"));
    assert.ok(!describePlan(plan).join("\n").includes("s3cretword"));
  });

  it("lets an https endpoint through the rule (here it cannot be reached, so it is not planned for that reason)", async () => {
    const plan = await planX402Run({
      network: PUBNET,
      endpoints: [{ name: "deployed", target: "https://wasit-endpoint.invalid/paid" }],
      mainnet: optIn,
    });
    assert.equal(plan.endpoints[0]?.status, "not-paid");
    assert.doesNotMatch(plan.endpoints[0]?.reason ?? "", /pays an https endpoint only/);
  });

  it("still refuses stellar:pubnet without an opt-in, before any request", async () => {
    const weather = await wall(CENT);
    await assert.rejects(planX402Run({ network: PUBNET, endpoints: [{ name: "weather", target: weather.url }] }), PaymentNetworkRefusedError);
    assert.equal(world.reads.length, 0);
  });
});
