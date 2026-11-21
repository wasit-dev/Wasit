/**
 * The mainnet opt-in (spec B5, B18 O1), written before the code (B11): the
 * one function that creates it, every rule it refuses on before anything is
 * sent, and L0 taking only a live opt-in made by it, for x402 on
 * stellar:pubnet only.
 *
 * Offline: the chain, the RPC identity and Horizon are stood in
 * (test/support/pubnet-chain.ts). No key here has ever held funds.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import { ConfigurationError } from "../../src/errors.js";
import { RunBudget } from "../../src/guard/budget.js";
import { MainnetJobRefusedError } from "../../src/guard/ci-mainnet.js";
import { MainnetRunRefusedError, openMainnetOptIn, type MainnetOptInInput } from "../../src/guard/mainnet-run.js";
import { MainnetPlanRefusedError } from "../../src/guard/mainnet-plan.js";
import { PaymentNetworkRefusedError, assertPaymentNetworkAllowed } from "../../src/guard/networks.js";
import { MainnetOptIn, isLiveOptIn } from "../../src/guard/optin.js";
import { RpcIdentityError } from "../../src/guard/rpc-identity.js";
import { MAINNET_RUN_LOCK_FILE, MainnetRunLockedError } from "../../src/guard/run-lock.js";
import { PUBNET, PUBNET_RPC, PUBNET_USDC, TESTNET, installPubnetWorld, type PubnetWorld } from "../support/pubnet-chain.js";

const PAYER_KEY = Keypair.random();
const PAY_TO = Keypair.random().publicKey();

let world: PubnetWorld;
let dir: string;
const opened: MainnetOptIn[] = [];

beforeEach(async () => {
  world = await installPubnetWorld();
  dir = mkdtempSync(path.join(tmpdir(), "wasit-optin-"));
});

afterEach(async () => {
  for (const optIn of opened.splice(0)) optIn.close();
  await world.close();
  rmSync(dir, { recursive: true, force: true });
});

function input(overrides: Partial<MainnetOptInInput> = {}): MainnetOptInInput {
  return {
    frontEnd: "cli",
    env: { WASIT_MAINNET_PAYER_SECRET: PAYER_KEY.secret() },
    environment: "mainnet",
    network: PUBNET,
    operatedByMe: true,
    pin: { payTo: PAY_TO, asset: PUBNET_USDC },
    rpcUrl: PUBNET_RPC,
    ledgerDir: dir,
    ...overrides,
  };
}

async function open(overrides: Partial<MainnetOptInInput> = {}): Promise<MainnetOptIn> {
  const optIn = await openMainnetOptIn(input(overrides));
  opened.push(optIn);
  return optIn;
}

/** Refused, with no lock taken and the key never echoed. */
async function refused(overrides: Partial<MainnetOptInInput>, kind: new (...args: never[]) => Error): Promise<Error> {
  const error = await openMainnetOptIn(input(overrides)).then(
    (optIn) => {
      opened.push(optIn);
      return undefined;
    },
    (caught: unknown) => caught as Error,
  );
  assert.ok(error instanceof kind, `expected ${kind.name}, got ${String(error)}`);
  assert.ok(error instanceof ConfigurationError, "every refusal is a configuration error: no verdict");
  assert.ok(!error.message.includes(PAYER_KEY.secret()), "the message echoes the key");
  assert.equal(existsSync(path.join(dir, MAINNET_RUN_LOCK_FILE)), false, "a refused opt-in took the lock");
  return error;
}

describe("openMainnetOptIn: the one place a mainnet opt-in is made", () => {
  it("opens with every rule met: the payer's address, the pin, the RPC, the lock; the key is not kept", async () => {
    const optIn = await open();
    assert.ok(isLiveOptIn(optIn, PUBNET));
    assert.equal(optIn.network, PUBNET);
    assert.equal(optIn.payer, PAYER_KEY.publicKey());
    assert.deepEqual(optIn.pin, { payTo: PAY_TO, asset: PUBNET_USDC });
    assert.equal(optIn.rpcUrl, PUBNET_RPC);
    assert.equal(optIn.frontEnd, "cli");
    assert.equal(optIn.environment, "mainnet");
    assert.ok(optIn.budget instanceof RunBudget);
    assert.equal(optIn.plan, undefined);
    assert.equal(optIn.ledger, undefined);
    assert.equal(optIn.stopped, undefined);
    assert.ok(existsSync(path.join(dir, MAINNET_RUN_LOCK_FILE)), "the lock is taken");
    assert.ok(world.identityCalls.some((call) => call.endsWith("getNetwork")), "the RPC's network was checked");
    for (const shown of [JSON.stringify(optIn), inspect(optIn, { depth: 5, showHidden: true })]) {
      assert.ok(!shown.includes(PAYER_KEY.secret()), "the opt-in holds the key");
    }
    assert.ok(Object.isFrozen(optIn.pin), "the pin can be changed after the opt-in");
  });

  it("each front end's switch opens it the same way", async () => {
    for (const frontEnd of ["cli", "action", "mcp"] as const) {
      const optIn = await open({ frontEnd });
      assert.equal(optIn.frontEnd, frontEnd);
      optIn.close();
    }
  });

  it("refuses a network that is not stellar:pubnet, before any request", async () => {
    for (const network of [TESTNET, "eip155:8453", "stellar:futurenet", ""]) {
      await refused({ network }, MainnetRunRefusedError);
    }
    assert.equal(world.identityCalls.length, 0);
  });

  it("refuses an environment without operatedByMe: true", async () => {
    await refused({ operatedByMe: false }, MainnetRunRefusedError);
    assert.equal(world.identityCalls.length, 0);
  });

  it("reads the key from WASIT_MAINNET_PAYER_SECRET only", async () => {
    await refused({ env: {} }, MainnetRunRefusedError);
    const blank = await refused({ env: { WASIT_MAINNET_PAYER_SECRET: "   " } }, MainnetRunRefusedError);
    assert.match(blank.message, /is not set/);
    await refused({ env: { STELLAR_PRIVATE_KEY: PAYER_KEY.secret() } }, MainnetRunRefusedError);
    await refused({ env: { WASIT_MAINNET_PAYER_SECRET: "not-a-key" } }, MainnetRunRefusedError);
    // A public address is not a key.
    await refused({ env: { WASIT_MAINNET_PAYER_SECRET: PAYER_KEY.publicKey() } }, MainnetRunRefusedError);
    assert.equal(world.identityCalls.length, 0);
  });

  it("refuses a mainnet key that is also a testnet key variable's value (use a dedicated account)", async () => {
    for (const name of ["STELLAR_PRIVATE_KEY", "MPP_PAYER_SECRET", "stellar_private_key"]) {
      const error = await refused(
        { env: { WASIT_MAINNET_PAYER_SECRET: PAYER_KEY.secret(), [name]: ` ${PAYER_KEY.secret()} ` } },
        MainnetRunRefusedError,
      );
      assert.match(error.message, /dedicated/);
    }
    // Another value under a testnet name is not this rule's (the CI job rules see it in GitHub Actions).
    const optIn = await open({ env: { WASIT_MAINNET_PAYER_SECRET: PAYER_KEY.secret(), STELLAR_PRIVATE_KEY: Keypair.random().secret() } });
    assert.ok(isLiveOptIn(optIn, PUBNET));
  });

  it("refuses a missing or wrong pin: USDC only, a valid payee that is not the payer", async () => {
    await refused({ pin: undefined }, MainnetPlanRefusedError);
    await refused({ pin: { payTo: PAY_TO, asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" } }, MainnetPlanRefusedError);
    await refused({ pin: { payTo: "GNOTANADDRESS", asset: PUBNET_USDC } }, MainnetPlanRefusedError);
    await refused({ pin: { payTo: PAYER_KEY.publicKey(), asset: PUBNET_USDC } }, MainnetPlanRefusedError);
    assert.equal(world.identityCalls.length, 0);
  });

  it("refuses without an RPC, with an http RPC, and with one that serves another network", async () => {
    await refused({ rpcUrl: undefined }, MainnetRunRefusedError);
    await refused({ rpcUrl: "" }, MainnetRunRefusedError);
    assert.equal(world.identityCalls.length, 0);
    await refused({ rpcUrl: "http://rpc.example/stellar:pubnet" }, RpcIdentityError);
    await refused({ rpcUrl: "https://rpc.example/stellar:testnet" }, RpcIdentityError);
  });

  it("takes the cap from one place: a budget, or maxRunUsd, never both", async () => {
    await refused({ budget: new RunBudget(), maxRunUsd: 1 }, MainnetRunRefusedError);
    await refused({ maxRunUsd: 0 }, ConfigurationError);
    const lowered = await open({ maxRunUsd: 1 });
    assert.equal(lowered.budget.capUsd, new RunBudget({ maxRunUsd: 1 }).capUsd);
    lowered.close();
    class Lenient extends RunBudget {
      public override charge(): void {}
    }
    await refused({ budget: new Lenient() }, MainnetRunRefusedError);
    const shared = new RunBudget();
    const optIn = await open({ budget: shared });
    assert.equal(optIn.budget, shared, "the MCP server's budget for the process is the run's");
  });

  it("in GitHub Actions, refuses a job that breaks the mainnet job rules, and a job it cannot see", async () => {
    const env = {
      WASIT_MAINNET_PAYER_SECRET: PAYER_KEY.secret(),
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "push",
      RUNNER_ENVIRONMENT: "github-hosted",
      GITHUB_REF: "refs/heads/main",
    };
    const job = { defaultBranch: "main", startsService: false, baseUrl: "https://api.example.com", installDirs: [] };
    await refused({ env, job }, MainnetJobRefusedError);
    await refused({ env: { ...env, GITHUB_EVENT_NAME: "workflow_dispatch" } }, MainnetRunRefusedError);
    const optIn = await open({ env: { ...env, GITHUB_EVENT_NAME: "workflow_dispatch" }, job });
    assert.ok(isLiveOptIn(optIn, PUBNET));
  });

  it("refuses a second mainnet run in the same folder while one is open; the lock goes with close()", async () => {
    const first = await open();
    const error = await openMainnetOptIn(input()).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    assert.ok(error instanceof MainnetRunLockedError, String(error));
    first.close();
    first.close();
    assert.equal(existsSync(path.join(dir, MAINNET_RUN_LOCK_FILE)), false);
    assert.equal(isLiveOptIn(first, PUBNET), false, "a closed opt-in is still live");
    const second = await open();
    assert.ok(isLiveOptIn(second, PUBNET));
  });
});

describe("L0 with the opt-in: stellar:pubnet for x402, only with a live one", () => {
  it("passes x402 on stellar:pubnet with a live opt-in, and is live for that network only", async () => {
    const optIn = await open();
    assert.doesNotThrow(() => assertPaymentNetworkAllowed("x402", PUBNET, optIn));
    for (const network of [TESTNET, "eip155:8453", ""]) assert.equal(isLiveOptIn(optIn, network), false, network);
  });

  it("never passes MPP on stellar:pubnet, opt-in or not", async () => {
    const optIn = await open();
    for (const protocol of ["mpp-charge", "mpp-channel"] as const) {
      assert.throws(() => assertPaymentNetworkAllowed(protocol, PUBNET, optIn), PaymentNetworkRefusedError);
    }
  });

  it("never passes another network that is not a test network, opt-in or not", async () => {
    const optIn = await open();
    for (const network of ["eip155:8453", "stellar:futurenet", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]) {
      assert.throws(() => assertPaymentNetworkAllowed("x402", network, optIn), PaymentNetworkRefusedError);
    }
  });

  it("does not take an object that only looks like an opt-in", async () => {
    const real = await open();
    const lookalikes: unknown[] = [
      { network: PUBNET, payer: real.payer, pin: real.pin, rpcUrl: PUBNET_RPC, budget: real.budget, stopped: undefined, closed: false },
      Object.create(MainnetOptIn.prototype) as unknown,
      Object.assign(Object.create(Object.getPrototypeOf(real) as object) as object, { network: PUBNET }),
      { ...real },
      true,
      "stellar:pubnet",
    ];
    for (const value of lookalikes) {
      assert.equal(isLiveOptIn(value, PUBNET), false);
      assert.throws(() => assertPaymentNetworkAllowed("x402", PUBNET, value as MainnetOptIn), PaymentNetworkRefusedError);
    }
    // With every field it needs, but not core's symbol: refused, and not taken for one.
    const fields = { frontEnd: "cli", environment: "mainnet", payer: real.payer, pin: real.pin, rpcUrl: PUBNET_RPC, budget: real.budget, ledgerDir: dir, lock: { path: "", release: () => undefined } };
    assert.throws(
      () => new (MainnetOptIn as unknown as new (...args: unknown[]) => unknown)(Symbol("mainnet opt-in"), fields),
      /openMainnetOptIn only/,
    );
  });

  it("refuses once the opt-in is stopped, and says why", async () => {
    const optIn = await open();
    optIn.stop("a guard refusal");
    optIn.stop("a later reason");
    assert.equal(optIn.stopped, "a guard refusal", "the first reason is kept");
    assert.throws(
      () => assertPaymentNetworkAllowed("x402", PUBNET, optIn),
      (error: unknown) => error instanceof PaymentNetworkRefusedError && /stopped/.test(error.message) && /a guard refusal/.test(error.message),
    );
  });

  it("refuses once the opt-in is closed", async () => {
    const optIn = await open();
    optIn.close();
    assert.throws(() => assertPaymentNetworkAllowed("x402", PUBNET, optIn), PaymentNetworkRefusedError);
  });

  it("still refuses stellar:pubnet with no opt-in, as before", () => {
    assert.throws(() => assertPaymentNetworkAllowed("x402", PUBNET), PaymentNetworkRefusedError);
    assert.throws(() => assertPaymentNetworkAllowed("x402", PUBNET, undefined), PaymentNetworkRefusedError);
  });
});
