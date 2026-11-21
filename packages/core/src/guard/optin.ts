/**
 * The mainnet opt-in (spec B5), as one object: made by core only
 * (`openMainnetOptIn`, guard/mainnet-run.ts), for one run.
 *
 * An x402 payment on `stellar:pubnet` is made only with a live opt-in: L0
 * passes that network with one and with nothing else. It holds what the run
 * pays by (the payer's public address, the pin, the RPC, the budget) and what
 * the run has done so far (its plan, its ledger, whether it was stopped or
 * closed). It never holds the key.
 *
 * Its constructor takes a symbol only this module has, and every opt-in it
 * makes is kept in a set only this module reads, so an object that only looks
 * like one (a literal, a copy, `Object.create` of its prototype) is never taken
 * for one. That stops a mistake or a forged object; code that reaches into the
 * package's files holds the key itself and is outside every rule of Wasit.
 */

import { ConfigurationError } from "../errors.js";
import { PER_PAYMENT_CAP_USD, formatUsd, usdFromDollars, type PinTerms, type RunBudget } from "./budget.js";
import { RunLedger } from "./run-ledger.js";
import type { MainnetRunLock } from "./run-lock.js";
import { SigningAnchor } from "./signed-terms.js";
import type { RunPlan } from "../x402/plan.js";

/** The front end whose switch asked for this run: `--mainnet`, the Action's input, the MCP server's start-up setting. */
export type MainnetFrontEnd = "cli" | "action" | "mcp";

const ISSUE = Symbol("mainnet opt-in");
const issued = new WeakSet<object>();
const anchors = new WeakMap<object, SigningAnchor>();
const plans = new WeakMap<object, RunPlan>();

export interface MainnetOptInFields {
  readonly frontEnd: MainnetFrontEnd;
  readonly environment: string;
  readonly payer: string;
  readonly pin: PinTerms;
  readonly rpcUrl: string;
  readonly budget: RunBudget;
  readonly ledgerDir: string;
  readonly lock: MainnetRunLock;
}

/** A plan, a pin or anything else the opt-in keeps: frozen all the way down, so no caller changes it later. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** Which rule refused or stopped the mainnet run. */
export type MainnetRunRefusal = "network" | "operated-by-me" | "key" | "rpc" | "cap" | "job" | "run";

/**
 * A mainnet run does not open, or a step of it is refused. A
 * `ConfigurationError`: it says nothing about the target. Nothing was started,
 * sent or signed by the step that threw it.
 */
export class MainnetRunRefusedError extends ConfigurationError {
  public readonly reason: MainnetRunRefusal;

  public constructor(reason: MainnetRunRefusal, message: string) {
    super(`${message} Nothing was started, sent or signed.`);
    this.name = "MainnetRunRefusedError";
    this.reason = reason;
  }
}

function refuse(message: string): MainnetRunRefusedError {
  return new MainnetRunRefusedError("run", message);
}

export class MainnetOptIn {
  public readonly network = "stellar:pubnet";
  public readonly frontEnd: MainnetFrontEnd;
  public readonly environment: string;
  /** The payer's public address, derived from the key when the opt-in was made. */
  public readonly payer: string;
  public readonly pin: PinTerms;
  public readonly rpcUrl: string;
  /** The run's budget: its own $5, or the MCP server's for the whole process (D-018). */
  public readonly budget: RunBudget;
  /** Where the lock is, and where the ledger is written. */
  public readonly ledgerDir: string;
  readonly #lock: MainnetRunLock;
  #ledger: RunLedger | undefined;
  #stopped: string | undefined;
  #closed = false;

  /** Core only: `openMainnetOptIn`. */
  public constructor(key: symbol, fields: MainnetOptInFields) {
    if (key !== ISSUE) throw new TypeError("A mainnet opt-in is made by openMainnetOptIn only.");
    this.frontEnd = fields.frontEnd;
    this.environment = fields.environment;
    this.payer = fields.payer;
    this.pin = deepFreeze({ payTo: fields.pin.payTo, asset: fields.pin.asset });
    this.rpcUrl = fields.rpcUrl;
    this.budget = fields.budget;
    this.ledgerDir = fields.ledgerDir;
    this.#lock = fields.lock;
    issued.add(this);
    anchors.set(this, new SigningAnchor());
  }

  /** The plan L1 made for this run, once it passed. */
  public get plan(): RunPlan | undefined {
    return plans.get(this);
  }

  public get ledger(): RunLedger | undefined {
    return this.#ledger;
  }

  /** Why the run stopped (the first reason), if it did. Nothing is signed after it. */
  public get stopped(): string | undefined {
    return this.#stopped;
  }

  public get closed(): boolean {
    return this.#closed;
  }

  /** Stops the whole run (spec B3): nothing more is signed with this opt-in. The first reason is kept. */
  public stop(reason: string): void {
    this.#stopped ??= reason;
  }

  /**
   * Opens the run ledger (spec B5) in the ledger folder: the header from this
   * opt-in and its plan, the RPC by its origin only, and the balances before
   * as L1 read them on public Horizon. Only after a plan that passed, once,
   * and before the first signature: a payment on mainnet without it is refused.
   */
  public openLedger(versions: Readonly<Record<string, string>>, options: { readonly now?: () => Date } = {}): RunLedger {
    if (!isLiveOptIn(this, this.network)) throw refuse("The mainnet run is stopped or closed, so its ledger is not opened.");
    const plan = plans.get(this);
    if (plan?.mainnet === undefined) throw refuse("The mainnet run has no plan that passed yet, so its ledger is not opened.");
    if (this.#ledger !== undefined) throw refuse("The mainnet run's ledger is already open.");
    const ledger = RunLedger.create(
      this.ledgerDir,
      {
        versions,
        environment: this.environment,
        network: this.network,
        payer: this.payer,
        pin: this.pin,
        caps: { perPaymentUsd: formatUsd(usdFromDollars(PER_PAYMENT_CAP_USD)), runUsd: formatUsd(this.budget.capUsd) },
        plan,
        rpc: new URL(this.rpcUrl).origin,
      },
      options,
    );
    ledger.recordBalancesBefore({ usdc: plan.mainnet.usdc, native: plan.mainnet.native }, `public Horizon (${plan.mainnet.horizon})`);
    this.#ledger = ledger;
    return ledger;
  }

  /** Ends the run: nothing more is signed with it, and its lock is released. */
  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#lock.release();
  }
}

/** Core only: L1 records the plan that passed, once. Not a method, so no caller reaches it through an opt-in. */
export function recordMainnetPlan(optIn: MainnetOptIn, plan: RunPlan): void {
  if (!issued.has(optIn) || plans.has(optIn)) throw refuse("The mainnet run already has a plan.");
  plans.set(optIn, deepFreeze(plan));
}

/** Core only: the one way to make an opt-in, used by `openMainnetOptIn`. */
export function issueMainnetOptIn(fields: MainnetOptInFields): MainnetOptIn {
  return new MainnetOptIn(ISSUE, fields);
}

/**
 * The run's anchor (spec B17.2): read in L1 beside public Horizon's latest
 * ledger, never at the first signature. Core only: not on the opt-in, so no
 * caller can set it first.
 */
export function anchorOfOptIn(optIn: MainnetOptIn): SigningAnchor {
  const anchor = anchors.get(optIn);
  if (anchor === undefined) throw new TypeError("Not a mainnet opt-in.");
  return anchor;
}

/** True for an opt-in core made, live, stopped or closed alike. */
export function isMainnetOptIn(value: unknown): value is MainnetOptIn {
  return typeof value === "object" && value !== null && issued.has(value);
}

/** True only for an opt-in core made, for `network`, neither stopped nor closed. */
export function isLiveOptIn(value: unknown, network: string): value is MainnetOptIn {
  return (
    typeof value === "object" &&
    value !== null &&
    issued.has(value) &&
    (value as MainnetOptIn).network === network &&
    (value as MainnetOptIn).stopped === undefined &&
    !(value as MainnetOptIn).closed
  );
}

/**
 * Why `value`, an opt-in core made, is not live for `network`, as a clause;
 * undefined when it is live or is not an opt-in at all.
 */
export function whyNotLive(value: unknown, network: string): string | undefined {
  if (typeof value !== "object" || value === null || !issued.has(value)) return undefined;
  const optIn = value as MainnetOptIn;
  if (optIn.stopped !== undefined) return `the mainnet run stopped, so nothing more is signed in it: ${optIn.stopped.replace(/\.\s*$/, "")}`;
  if (optIn.closed) return "the mainnet run is closed, so nothing more is signed in it";
  if (optIn.network !== network) return `the mainnet opt-in is for ${optIn.network}, not ${network}`;
  return undefined;
}
