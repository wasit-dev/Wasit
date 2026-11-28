/**
 * The MCP server's mainnet opt-in (spec B5, B18 O3). Beta.
 *
 * Start-up only, read once: `WASIT_MAINNET_OPT_IN=1` together with
 * `WASIT_MAINNET_CONFIG` (an absolute path to a wasit.config.json) and
 * `WASIT_MAINNET_ENVIRONMENT` (one environment of it). All three or none. With
 * them, every rule below must hold or the server does not start; the config is
 * then frozen, so a later edit of the file changes nothing until a person
 * restarts the server. The server then registers `wasit_x402_mainnet_test`,
 * whose only argument is the name of an x402 endpoint of that environment: the
 * agent gives no URL, network, RPC, payee or amount.
 *
 * Each call opens its own mainnet run through core (`openMainnetOptIn`), which
 * checks every rule of the opt-in again (the key, the pin, the RPC, the lock),
 * on ONE budget for the whole process: $5.00, or the config's lower maxRunUsd
 * (Najmi, D-018). A restart resets it. One call at a time. Once a call has
 * opened its ledger and ends stopped, or with a ledger that does not match the
 * payer's balances (or with the balances after not read), the tool refuses
 * every later call of this process: a person reads the ledger, compares it
 * with the chain, then restarts the server (B13: any mismatch, stop
 * everything). An explained ledger does not lock it.
 *
 * This is the weakest switch (B5, B-A05): an MCP server takes its environment
 * from the client's configuration, so the mainnet key may sit where the agent
 * can read it, and an agent that reads the key is outside every limit of
 * Wasit. The bound on this path is the dedicated account's balance (L1 refuses
 * a payer above $10), not the $5.
 *
 * Nothing here has a top-level effect: `index.ts` calls it.
 */

import path from "node:path";

import {
  CheckSetupError,
  ConfigError,
  ConfigurationError,
  MAINNET_PAYER_KEY_ENV,
  RunBudget,
  assertMainnetPin,
  closeMainnetRun,
  describePlan,
  errored,
  formatUsd,
  inGithubActions,
  mainnetFirstLine,
  mainnetOpeningLine,
  openMainnetOptIn,
  planX402Run,
  readConfigFile,
  resolveRun,
  runX402PaymentChecks,
  runX402ReadChecks,
  sanitizeText,
  urlOrigin,
  type CheckResult,
  type LedgerResult,
  type MainnetCloseResult,
  type MainnetOptIn,
  type ResolvedEndpoint,
  type ResolvedRun,
  type RunPlan,
} from "@wasit-dev/core";

/** The tool a mainnet opt-in registers. */
export const MAINNET_TOOL = "wasit_x402_mainnet_test";

/** The three start-up variables of the opt-in: all three, or none. */
export const MAINNET_STARTUP_VARIABLES = ["WASIT_MAINNET_OPT_IN", "WASIT_MAINNET_CONFIG", "WASIT_MAINNET_ENVIRONMENT"] as const;

const STELLAR_PUBNET = "stellar:pubnet";

/** What the server read at start-up for its mainnet tool. Frozen, the budget's state aside. */
export interface MainnetSetup {
  readonly configPath: string;
  readonly environment: string;
  /** The resolved environment, deep-frozen. Its endpoints' headers are secrets: never print them. */
  readonly run: ResolvedRun;
  /** The names of its x402 endpoints, the tool's only argument. */
  readonly endpoints: readonly string[];
  /** Where each call writes its ledger and takes its lock: the config's folder. */
  readonly ledgerDir: string;
  /** The one budget of this process (D-018). */
  readonly budget: RunBudget;
}

export type MainnetStartup =
  | { readonly kind: "off" }
  | { readonly kind: "refused"; readonly reasons: readonly string[] }
  | { readonly kind: "on"; readonly setup: MainnetSetup };

type Env = Readonly<Record<string, string | undefined>>;

/** A variable's value by its name in upper case, as a Windows environment compares them; undefined when blank. */
function valueOf(env: Env, name: string): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === name && typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function listed(names: readonly string[]): string {
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

/**
 * Reads the mainnet opt-in at start-up: off (none of its variables, no
 * `--mainnet`), refused (every rule it breaks, as sentences that echo no
 * value), or on, with the frozen setup.
 *
 * @param env the server's environment
 * @param args the server's arguments, after the script
 */
export function readMainnetStartup(env: Env, args: readonly string[]): MainnetStartup {
  const reasons: string[] = [];
  if (args.some((arg) => arg === "--mainnet" || arg.startsWith("--mainnet="))) {
    reasons.push(
      `--mainnet is not read by this server: its mainnet opt-in is WASIT_MAINNET_OPT_IN=1 with WASIT_MAINNET_CONFIG and ` +
        `WASIT_MAINNET_ENVIRONMENT, set before it starts. Remove --mainnet to start it.`,
    );
  }
  const given = MAINNET_STARTUP_VARIABLES.filter((name) => valueOf(env, name) !== undefined);
  if (given.length === 0) return reasons.length === 0 ? { kind: "off" } : { kind: "refused", reasons };

  const missing = MAINNET_STARTUP_VARIABLES.filter((name) => !given.includes(name));
  if (missing.length > 0) {
    reasons.push(
      `${listed(MAINNET_STARTUP_VARIABLES)} are set together or not at all: ${listed(missing)} ${missing.length === 1 ? "is" : "are"} not set.`,
    );
  }
  const optIn = valueOf(env, "WASIT_MAINNET_OPT_IN");
  if (optIn !== undefined && optIn !== "1") {
    reasons.push("WASIT_MAINNET_OPT_IN must be 1 to opt in; remove it to start the server without the mainnet tool.");
  }
  if (inGithubActions(env) || valueOf(env, "CI") !== undefined) {
    reasons.push(
      "The MCP server's mainnet opt-in is for a builder's own machine, and it is refused in CI (CI or GITHUB_ACTIONS is set): " +
        "in GitHub Actions use the Action's mainnet: true on workflow_dispatch.",
    );
  }
  const configPath = valueOf(env, "WASIT_MAINNET_CONFIG");
  if (configPath !== undefined && !path.isAbsolute(configPath)) {
    reasons.push("WASIT_MAINNET_CONFIG must be an absolute path to a wasit.config.json.");
  }
  const environment = valueOf(env, "WASIT_MAINNET_ENVIRONMENT");
  if (reasons.length > 0 || configPath === undefined || environment === undefined) return { kind: "refused", reasons };

  let run: ResolvedRun;
  try {
    run = resolveRun(readConfigFile(configPath), { environment }, env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { kind: "refused", reasons: [`WASIT_MAINNET_CONFIG could not be read as a Wasit config: ${error.message}`] };
  }

  if (run.network !== STELLAR_PUBNET) {
    reasons.push(`Environment ${run.environment} is on another network: the mainnet tool pays on ${STELLAR_PUBNET} only.`);
  } else {
    if (run.operatedByMe !== true) {
      reasons.push(`operatedByMe is not true for environment ${run.environment}: Wasit pays only a service its operator runs.`);
    }
    try {
      assertMainnetPin(run.pinned, undefined);
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      reasons.push(error.message);
    }
    if (run.rpcUrl === undefined) {
      reasons.push(`A mainnet run needs an RPC for ${STELLAR_PUBNET} (rpcUrl in the config, or WASIT_RPC_URL): there is no default one.`);
    } else if (!/^https:\/\//i.test(run.rpcUrl)) {
      reasons.push(`The RPC of a mainnet run must be https (${urlOrigin(run.rpcUrl)} is not).`);
    }
  }
  const endpoints = run.endpoints.filter((endpoint) => endpoint.protocol === "x402").map((endpoint) => endpoint.name);
  if (endpoints.length === 0) {
    reasons.push(`Environment ${run.environment} has no x402 endpoint to pay: MPP stays on test networks.`);
  }
  if (valueOf(env, MAINNET_PAYER_KEY_ENV) === undefined) {
    reasons.push(
      `${MAINNET_PAYER_KEY_ENV} is not set: a mainnet run reads its key from that variable only, never from STELLAR_PRIVATE_KEY. ` +
        `Start the server from a shell that already holds it; never write the key into an MCP config file.`,
    );
  }
  if (reasons.length > 0) return { kind: "refused", reasons };

  const frozen = deepFreeze(structuredClone(run));
  const setup: MainnetSetup = Object.freeze({
    configPath,
    environment: frozen.environment,
    run: frozen,
    endpoints: Object.freeze([...endpoints]),
    ledgerDir: path.dirname(configPath),
    budget: new RunBudget(frozen.maxRunUsd === undefined ? {} : { maxRunUsd: frozen.maxRunUsd }),
  });
  return { kind: "on", setup };
}

/** The tool's description, from the frozen setup: what a call pays, to whom, within what. */
export function mainnetToolDescription(setup: MainnetSetup): string {
  const pin = setup.run.pinned;
  return (
    `Beta. Runs the x402 checks (X402-01..10, and X402-11 for an endpoint with a reject case) on Stellar mainnet ` +
    `(${STELLAR_PUBNET}) with REAL FUNDS, against an endpoint of environment ${setup.environment} of the config this ` +
    `server read at start-up. It pays only ${pin?.payTo ?? "the pinned payee"} in USDC, at most $1.00 a payment, and at ` +
    `most ${formatUsd(setup.budget.capUsd)} for this whole server process, shared by every call (a restart resets it). ` +
    `Every rule of the mainnet opt-in is checked before anything is signed, and each call writes a run ledger next to ` +
    `the config. The service must already be running: this tool never starts it. A call waits for every authorization ` +
    `it signed to expire (each lifetime is at most 300 s), then reads the payer's balances on public Horizon, so it can ` +
    `take several minutes; a call the client cancels still runs to its end. One call at a time. A call that stops, or ` +
    `whose ledger does not match the payer's balances, locks this tool until a person restarts the server. The only argument is ` +
    `the endpoint's name: the network, the payee, the amount and the RPC (${setup.run.rpcUrl === undefined ? "none" : urlOrigin(setup.run.rpcUrl)}) come from the config.`
  );
}

export interface MainnetToolIo {
  /** The process environment at the time of the call: the key is read from it at the moment of use. */
  readonly env: Env;
  /** The versions for the ledger's header, flat. */
  readonly versions: Readonly<Record<string, string>>;
  /** Each line of the run as it happens: stderr and the client's progress. Holds no secret. */
  readonly onLine?: (line: string) => void;
  /** Tests only: the wait between two reads of L4. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface MainnetToolResult {
  /** Every line of the run, in order; the first one says MAINNET RUN when the run opened. */
  readonly lines: readonly string[];
  readonly results: readonly CheckResult[];
  /** Why nothing more was done: the opt-in or the plan refused. Undefined when the checks ran. */
  readonly refused?: string;
  readonly ledgerPath?: string;
  /** The ledger against the balances after, on public Horizon; undefined when no ledger was opened. */
  readonly ledgerResult?: LedgerResult;
  /** Why the run stopped (B3), when it did. */
  readonly stopped?: string;
  /** What this call charged, what the process has charged, and the process's cap: dollar units. */
  readonly spentUsd: bigint;
  readonly processSpentUsd: bigint;
  readonly processCapUsd: bigint;
}

/** What a mainnet call's result says beside its checks. */
export interface MainnetSummary {
  /**
   * The checks' outcome may stand: the run did not stop, and its ledger is consistent, or explained by checks
   * that FAILed. Else the result is no-verdict, as the CLI exits 2.
   */
  readonly trusted: boolean;
  /** The sentence the text ends with when it is not trusted; empty otherwise. */
  readonly caveat: string;
  /** The structured channel's `mainnet` field. */
  readonly fields: {
    readonly network: string;
    readonly payTo: string;
    readonly ledger: string;
    /** "consistent", "explained" or "inconsistent" (also when the balances after were not read). */
    readonly ledgerResult: LedgerResult;
    readonly stopped?: string;
    readonly spentUsd: string;
    readonly processSpentUsd: string;
    readonly processCapUsd: string;
  };
}

/** The summary of a call that ran its checks (`ledgerPath` set). */
export function summarizeMainnetRun(setup: MainnetSetup, result: MainnetToolResult): MainnetSummary {
  const ledgerResult = result.ledgerResult ?? "inconsistent";
  const trusted = result.stopped === undefined && ledgerResult !== "inconsistent";
  const caveat = trusted
    ? ""
    : `No verdict: ${result.stopped === undefined ? "the run ledger does not match the payer's balances on public Horizon" : "the mainnet run stopped"}. ` +
      "The mainnet tool is locked until the server is restarted: compare the ledger with the chain by hand first.";
  return {
    trusted,
    caveat,
    fields: {
      network: setup.run.network,
      payTo: setup.run.pinned?.payTo ?? "",
      ledger: result.ledgerPath ?? "",
      ledgerResult,
      ...(result.stopped === undefined ? {} : { stopped: result.stopped }),
      spentUsd: formatUsd(result.spentUsd),
      processSpentUsd: formatUsd(result.processSpentUsd),
      processCapUsd: formatUsd(result.processCapUsd),
    },
  };
}

/** Calls that are running, per setup: one at a time. */
const running = new WeakSet<MainnetSetup>();

/** Why the mainnet tool of a setup is locked until the process restarts, with the ledger to read. */
const locked = new WeakMap<MainnetSetup, string>();

const NOTHING_SIGNED = /nothing (was|is) (started, sent or )?signed|nothing was sent and nothing was signed/i;

/** What L4 found, in one line (the CLI's words). */
function ledgerLine(close: MainnetCloseResult): string {
  const file = close.ledgerPath ?? "(no ledger)";
  const consistency = close.consistency;
  if (consistency === undefined) return `Ledger: none was opened, so nothing was signed. ${close.problem ?? ""}`.trim();
  if (consistency.result === "consistent") {
    return (
      `Ledger: consistent: the payer's USDC went down by exactly the settlements this run verified ` +
      `(${consistency.settledUsdc} base units), and its XLM did not move. ${file}`
    );
  }
  if (consistency.result === "explained") return `Ledger: explained: ${consistency.reasons.join(" ")} ${file}`.replace(/\s+/g, " ").trim();
  return `Ledger: INCONSISTENT: ${consistency.reasons.join(" ")} ${close.problem ?? ""} ${file}`.replace(/\s+/g, " ").trim();
}

/** Why a call locked the tool, in one sentence that names its ledger. */
function lockReason(stopped: string | undefined, close: MainnetCloseResult, ledgerPath: string): string {
  const file = path.basename(close.ledgerPath ?? ledgerPath);
  if (stopped !== undefined) return `an earlier call stopped (its ledger is ${file}).`;
  if (close.problem !== undefined) return `the payer's balances after an earlier call were not read (its ledger is ${file}).`;
  return `the ledger of an earlier call does not match the payer's balances (${file}).`;
}

function planEndpoint(endpoint: ResolvedEndpoint) {
  return {
    name: endpoint.name,
    target: endpoint.url,
    method: endpoint.method,
    ...(endpoint.body === undefined ? {} : { body: endpoint.body }),
    ...(Object.keys(endpoint.headers).length === 0 ? {} : { headers: { ...endpoint.headers } }),
    ...(endpoint.reject === undefined ? {} : { reject: endpoint.reject }),
  };
}

/**
 * One call of `wasit_x402_mainnet_test`: opens the run (core checks every rule
 * of the opt-in), says MAINNET RUN, plans this one endpoint against what is
 * left of the process's budget, opens the ledger, runs the read checks and the
 * payment checks, then waits for every authorization to expire, reads the
 * balances after and closes. The run is closed on every way out; a refusal
 * before the checks returns `refused`, with nothing signed. A call that opened
 * its ledger and did not end with a trusted ledger (not stopped; consistent or
 * explained) locks the tool for the rest of the process, whatever ended it.
 */
export async function runMainnetEndpoint(setup: MainnetSetup, name: string, io: MainnetToolIo): Promise<MainnetToolResult> {
  const lines: string[] = [];
  const spentBefore = setup.budget.spentUsd;
  const result = (fields: Partial<MainnetToolResult>): MainnetToolResult => ({
    lines: [...lines],
    results: [],
    ...fields,
    spentUsd: setup.budget.spentUsd - spentBefore,
    processSpentUsd: setup.budget.spentUsd,
    processCapUsd: setup.budget.capUsd,
  });
  const refuse = (message: string): MainnetToolResult => {
    const text = sanitizeText(message);
    return result({ refused: NOTHING_SIGNED.test(text) ? text : `${text} Nothing was signed.` });
  };

  const lock = locked.get(setup);
  if (lock !== undefined) {
    return refuse(
      `The mainnet tool of this server is locked: ${lock} Read that ledger, compare it with the payer's account on ` +
        `the chain, then restart the server to use the mainnet tool again. Nothing was sent.`,
    );
  }
  const endpoint = setup.run.endpoints.find((entry) => entry.name === name && entry.protocol === "x402");
  if (endpoint === undefined || !setup.endpoints.includes(name)) {
    return refuse(
      `There is no x402 endpoint named ${sanitizeText(name).slice(0, 64)} in environment ${setup.environment}; the endpoints are: ` +
        `${setup.endpoints.join(", ")}. Nothing was sent.`,
    );
  }
  if (running.has(setup)) return refuse("A mainnet run of this server is in progress: one at a time. Nothing was sent.");
  running.add(setup);
  try {
    const say = (line: string): void => {
      const clean = sanitizeText(line);
      lines.push(clean);
      io.onLine?.(clean);
    };
    let optIn: MainnetOptIn;
    try {
      optIn = await openMainnetOptIn({
        frontEnd: "mcp",
        env: io.env,
        environment: setup.environment,
        network: setup.run.network,
        operatedByMe: setup.run.operatedByMe,
        pin: setup.run.pinned,
        rpcUrl: setup.run.rpcUrl,
        ledgerDir: setup.ledgerDir,
        budget: setup.budget,
      });
    } catch (error) {
      if (error instanceof ConfigurationError) return refuse(error.message);
      throw error;
    }

    const closeOptions = { ...(io.sleep === undefined ? {} : { sleep: io.sleep }), onProgress: say };
    let close: MainnetCloseResult | undefined;
    // Set once the ledger is open: from then on, only a trusted end leaves the tool unlocked.
    let openedLedger: string | undefined;
    let trustedEnd = false;
    try {
      // B5: the first line, before the target is asked anything.
      say(mainnetOpeningLine(optIn));
      let plan: RunPlan;
      try {
        plan = await planX402Run({ network: setup.run.network, endpoints: [planEndpoint(endpoint)], mainnet: optIn });
      } catch (error) {
        if (error instanceof ConfigurationError || error instanceof CheckSetupError) return refuse(error.message);
        throw error;
      }
      if (plan.refusal !== undefined) {
        for (const line of describePlan(plan)) say(line);
        return refuse(plan.refusal);
      }
      say(mainnetFirstLine(plan));
      for (const line of describePlan(plan).slice(1)) say(line);

      let ledgerPath: string;
      try {
        ledgerPath = optIn.openLedger(io.versions).path;
      } catch (error) {
        if (error instanceof ConfigurationError || error instanceof CheckSetupError) return refuse(error.message);
        throw error;
      }
      openedLedger = ledgerPath;
      say(`Ledger: ${ledgerPath}: every signature is written there before the key signs.`);

      const shape = {
        method: endpoint.method,
        ...(endpoint.body === undefined ? {} : { body: endpoint.body }),
        ...(Object.keys(endpoint.headers).length === 0 ? {} : { headers: { ...endpoint.headers } }),
      };
      const results: CheckResult[] = [];
      try {
        results.push(...(await runX402ReadChecks({ target: endpoint.url, ...shape })));
        // The key, read at the moment of use from its one variable (B5, B6); core holds it to the opt-in's payer.
        const key = (io.env[MAINNET_PAYER_KEY_ENV] ?? "").trim();
        results.push(
          ...(await runX402PaymentChecks({
            target: endpoint.url,
            network: setup.run.network,
            payerSecretKey: key,
            mainnet: optIn,
            budget: optIn.budget,
            plan: plan.endpoints[0]!,
            ...shape,
            ...(endpoint.reject === undefined ? {} : { reject: endpoint.reject }),
            onProgress: say,
          })),
        );
      } catch (error) {
        // A check that throws is a defect in Wasit, not a finding about the service.
        results.push(errored("PREFLIGHT", "Run Preflight", error));
      }

      // L4: every authorization expired, the balances after read, the ledger closed, the lock released.
      close = await closeMainnetRun(optIn, closeOptions);
      say(ledgerLine(close));
      const stopped = optIn.stopped;
      if (stopped !== undefined) say(`The mainnet run stopped: ${stopped}`);
      const ledgerResult = close.consistency?.result ?? "inconsistent";
      if (stopped === undefined && ledgerResult !== "inconsistent") trustedEnd = true;
      else {
        locked.set(setup, lockReason(stopped, close, ledgerPath));
        say("The mainnet tool is now locked until the server is restarted: compare the ledger with the chain by hand first.");
      }
      return result({ results, ledgerPath, ledgerResult, ...(stopped === undefined ? {} : { stopped }) });
    } finally {
      // Every way out closes the run; one that signed waits for its authorizations first.
      if (close === undefined) await closeMainnetRun(optIn, closeOptions);
      // A call that opened its ledger and did not end trusted (a throw included) locks the tool.
      if (openedLedger !== undefined && !trustedEnd && !locked.has(setup)) {
        locked.set(setup, `an earlier call did not finish (its ledger is ${path.basename(openedLedger)}).`);
      }
    }
  } finally {
    running.delete(setup);
  }
}
