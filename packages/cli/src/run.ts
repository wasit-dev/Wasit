/**
 * `wasit run`: the endpoints of a `wasit.config.json`, one after another, with
 * one report (spec A2, A8).
 *
 * Three tiers. `--read-only`: an x402 endpoint gets its unpaid challenge checks
 * (X402-01..05); its payment checks, and every MPP check, are reported as
 * skipped for the tier, so the report says which checks need a payer.
 * `--dry-run` (spec B5): L0 and L1 only, the plan of the payment checks
 * printed; no key, no payment, no signature. Neither flag: the payment tier.
 *
 * The payment tier pays only when every one of these holds (D-022a, B3, A1):
 * the GitHub event may pay (push to the default branch, schedule,
 * workflow_dispatch on it; outside GitHub Actions always), the network is a
 * test network (L0; `stellar:pubnet` pays only through `--mainnet`, below), the
 * environment has `operatedByMe: true`, the chain's key variable is set, and
 * the plan (L1) fits the caps. Then one budget is shared by every endpoint, each
 * endpoint's checks get its entry of the plan, and the pin and `maxRunUsd` come
 * from the config; L2 and L3 hold every signature in core. On a pull request the
 * run is the read-only tier and says so. A key variable that is set on a run that
 * may not pay is refused before the service starts (Najmi, 2026-11-16).
 *
 * `--mainnet` (spec B5, B18 O2) is the CLI's switch of the mainnet opt-in: an
 * x402 run on `stellar:pubnet` that pays real USDC. Core opens it
 * (`openMainnetOptIn`) only when every rule holds: a pubnet environment with
 * `operatedByMe` and a USDC pin, the key in `WASIT_MAINNET_PAYER_SECRET` only,
 * an https RPC that serves pubnet, no other mainnet run holding the lock in the
 * ledger's folder, and in GitHub Actions the mainnet job rules. All of that is
 * checked before a service starts or the target is asked anything. The first
 * line then says MAINNET RUN; the plan reads the payer and the chain; the
 * ledger takes every signature before the key signs; a refusal stops the whole
 * run; L4 waits for every authorization to expire and compares the balances.
 * The switch is never read from the config or the environment. Without it, a
 * paying run on pubnet is refused. `--dry-run` on pubnet plans by the mainnet
 * rules and reads no key.
 *
 * `executeRun` does not call `process.exit` and does not read the process: the
 * environment and the output are passed in, so it can be tested in-process.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  CHECK_CATALOGUE,
  CheckSetupError,
  ConfigError,
  ConfigurationError,
  MAINNET_PAYER_KEY_ENV,
  MAX_BASELINE_BYTES,
  PER_PAYMENT_CAP_USD,
  RunBudget,
  assertPaymentNetworkAllowed,
  buildEndpointReport,
  buildRunReport,
  closeMainnetRun,
  deniedEnvValues,
  describePlan,
  describeRun,
  errored,
  formatUsd,
  githubDefaultBranch,
  inGithubActions,
  isLoopbackUrl,
  mainnetFirstLine,
  mainnetOpeningLine,
  openMainnetOptIn,
  payerKeyVariables,
  paymentChainFor,
  paymentChecksSkipped,
  paymentEventGate,
  planMainnetDryRun,
  planX402Run,
  readBaseline,
  readConfigFile,
  readBuildCommit,
  readGithubEvent,
  readToolVersions,
  redactReport,
  resolveRun,
  runExitCode,
  runX402PaymentChecks,
  runX402ReadChecks,
  sanitizeText,
  selectBaseline,
  skipped,
  skippedPaymentChecks,
  urlOrigin,
  type BaselineResult,
  type CheckResult,
  type MainnetCloseResult,
  type MainnetOptIn,
  type PaymentChain,
  type PinTerms,
  type ResolvedEndpoint,
  type ResolvedRun,
  type RunPlan,
  type RunVerdict,
  type SkipKind,
  RpcIdentityError,
  UnsupportedPaymentNetworkError,
  assertMppPaymentRpc,
  assertX402PaymentRpc,
  describePaymentPlan,
  planPaymentRun,
  plannedChargeOf,
  runMppChannelSuite,
  runMppChargeSuite,
  type MppChargePlanInput,
} from "@wasit-dev/core";

import { formatRun } from "./run-format.js";
import { ServiceError, serviceUserFor, startService, type StartedService } from "./service.js";
import { CLI_VERSION } from "./version.js";

export interface RunCommandOptions {
  readonly config: string;
  readonly env?: string;
  readonly endpoint?: readonly string[];
  readonly readOnly: boolean;
  /** L0 and L1 only: print the plan of the payment checks and exit. No key, no payment, no signature. */
  readonly dryRun?: boolean;
  readonly json: boolean;
  readonly out?: string;
  readonly start: boolean;
  /**
   * Start `service.start` only when it is set and the selected environment is on
   * this machine; otherwise read the configured baseUrl as it is. What the Action
   * passes, so a deployed endpoint (even on mainnet) is read without a service.
   */
  readonly startIfLocal?: boolean;
  readonly baseline?: string;
  /**
   * `--mainnet`: the switch of the mainnet opt-in (spec B5): an x402 run that
   * pays real USDC on `stellar:pubnet`, when every rule of the opt-in holds.
   * Never read from the config or the environment.
   */
  readonly mainnet?: boolean;
  /**
   * `--ledger-dir`: where a mainnet run writes its ledger and takes its lock.
   * Only with `--mainnet`. Default: the working directory.
   */
  readonly ledgerDir?: string;
}

export interface RunContext {
  /** The environment of the run: the header variables, the RPC url, and what `--start` derives the service's from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** One line at a time, the line break added by the caller. */
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now?: () => Date;
  /** Where `service.start` runs. Default: the working directory. */
  readonly cwd?: string;
  /** Tests only: the sudo `--start` uses for a separate service user. Index never sets it; no flag or variable reaches it. */
  readonly sudo?: string;
  /** Tests only: the wait between two reads of L4 (a mainnet run). Index never sets it. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const TIER_NOTE = "Tier: read-only. The payment checks were not run, and nothing was signed.";

const STELLAR_PUBNET = "stellar:pubnet";

/** MPP pays on this network only (L0; D-036). The network is the config's: `MPP_STELLAR_NETWORK` is not read. */
const MPP_NETWORK = "stellar:testnet";

/** The key variables of the MPP checks: MPP-01's payer, and the channel's commitment key (`wasit init` sets up the same ones). */
export const MPP_PAYER_KEY_ENV = "MPP_PAYER_SECRET";
export const MPP_COMMITMENT_KEY_ENV = "COMMITMENT_SECRET_HEX";

const MPP_NOT_ON_MAINNET =
  "MPP pays on test networks only: a mainnet run pays its x402 endpoints, so this endpoint's MPP checks were not run";

const MPP_CHANNEL_NOTE =
  "MPP channel: the commitments MPP-11, MPP-12 and MPP-14 sign are off-chain, and Wasit sends no transaction for " +
  "them, so they are not charged to the cap. MPP-13 (close) is never run by wasit run.";

/** What one MPP mode's checks do in a run of the payment tier on an event that may pay. */
type MppStep =
  | { readonly pay: false; readonly kind: SkipKind; readonly reason?: string }
  | { readonly pay: true; readonly key: string };

/** The MPP side of such a run: a step per mode, the network and RPC, and for MPP-01 the run's plan and budget. */
interface MppRun {
  readonly network: string;
  readonly rpcUrl?: string;
  readonly charge: MppStep;
  readonly channel: MppStep;
  readonly budget?: RunBudget;
  readonly plan?: RunPlan;
}

/** What one endpoint's payment checks do in this run. */
type PaymentStep =
  /** Skipped: with the read-only tier's own words when `reason` is absent. */
  | { readonly pay: false; readonly kind: SkipKind; readonly reason?: string }
  /** Paid, through the run's one budget and its plan. */
  | {
      readonly pay: true;
      readonly network: string;
      readonly key: string;
      readonly rpcUrl?: string;
      readonly budget: RunBudget;
      readonly pin?: PinTerms;
      readonly plan: RunPlan;
      /** Where a check's progress line goes (X402-11's wait): the same channel as the tier line. */
      readonly progress?: (line: string) => void;
      /** A mainnet run: its opt-in, whose budget, pin, plan, ledger and RPC the checks pay by. */
      readonly mainnet?: MainnetOptIn;
    };

function skippedFor(protocol: ResolvedEndpoint["protocol"], step: Extract<PaymentStep, { pay: false }>): CheckResult[] {
  if (step.reason === undefined && (step.kind === "read-only" || step.kind === "needs-payer")) {
    return skippedPaymentChecks(protocol, step.kind);
  }
  return paymentChecksSkipped(protocol, step.kind, step.reason ?? "the payment checks were not run");
}

/** Every check of a protocol, skipped: the endpoints of a mainnet run after it stopped. */
function everyCheckSkipped(protocol: ResolvedEndpoint["protocol"], reason: string): CheckResult[] {
  const why = `the mainnet run stopped, and nothing more is signed in it: ${sanitizeText(reason).slice(0, 400)}`;
  // MPP-13 closes a channel for good and is never listed (report.ts).
  return CHECK_CATALOGUE.filter((entry) => entry.protocol === protocol && entry.id !== "MPP-13").map((entry) =>
    skipped(entry.id, entry.name, why),
  );
}

/**
 * Why an MPP endpoint is not sent anything: the MPP checks send a plain GET in
 * this version, so a method, a body or headers the config gives it (from the
 * file or `WASIT_HEADER_*`) would not reach the service, and a verdict on what
 * it then answers would be about another request. Undefined when it is a plain GET.
 * Names no header and no value: header values are secrets.
 */
function mppShapeProblem(endpoint: ResolvedEndpoint): string | undefined {
  const parts = [
    ...(endpoint.method === "GET" ? [] : [`the method ${endpoint.method}`]),
    ...(endpoint.body === undefined ? [] : ["a body"]),
    ...(Object.keys(endpoint.headers).length === 0 ? [] : ["headers"]),
  ];
  if (parts.length === 0) return undefined;
  return (
    `wasit run sends MPP requests as a plain GET in this version, and this endpoint has ${parts.join(", ")} ` +
    `(from the config or WASIT_HEADER_*): nothing was sent to it`
  );
}

/** The MPP charge endpoints a run can plan and pay: plain GET requests. */
function mppChargeInputs(resolved: ResolvedRun): MppChargePlanInput[] {
  return resolved.endpoints
    .filter((endpoint) => endpoint.protocol === "mpp-charge" && mppShapeProblem(endpoint) === undefined)
    .map((endpoint) => ({ name: endpoint.name, target: endpoint.url }));
}

/**
 * The step of one MPP mode in the payment tier on an event that may pay: the
 * rules of x402 (operatedByMe, the key variable) and a test network that MPP
 * pays on.
 */
function mppStep(
  resolved: ResolvedRun,
  env: Readonly<Record<string, string | undefined>>,
  keyEnv: string,
  keyLabel: string,
  operatorRefusal: string | undefined,
): MppStep {
  if (operatorRefusal !== undefined) return { pay: false, kind: "read-only", reason: `payment checks not run: ${operatorRefusal}` };
  if (resolved.network !== MPP_NETWORK) {
    return {
      pay: false,
      kind: "unsupported",
      reason: `the MPP checks run on ${MPP_NETWORK} only, and environment ${resolved.environment} is on ${resolved.network}`,
    };
  }
  const value = env[keyEnv];
  if (value === undefined || value.trim() === "") {
    return { pay: false, kind: "needs-payer", reason: `payment checks not run: no ${keyLabel}: set ${keyEnv} on the Wasit step` };
  }
  return { pay: true, key: value.trim() };
}

/** One MPP endpoint of a run of the payment tier on an event that may pay. */
async function runMppEndpoint(endpoint: ResolvedEndpoint, mpp: MppRun): Promise<CheckResult[]> {
  const own = endpoint.protocol === "mpp-charge" ? mpp.charge : mpp.channel;
  if (!own.pay) return skippedFor(endpoint.protocol, own);
  const shape = mppShapeProblem(endpoint);
  if (shape !== undefined) return paymentChecksSkipped(endpoint.protocol, "unsupported", shape);
  const rpc = mpp.rpcUrl === undefined ? {} : { rpcUrl: mpp.rpcUrl };
  if (endpoint.protocol === "mpp-charge") {
    // Every plain MPP charge endpoint was planned; one that is not in the plan is not paid.
    const entry = mpp.plan?.endpoints.find((planned) => planned.name === endpoint.name);
    if (mpp.budget === undefined || entry === undefined) throw new Error(`the plan of this run has no entry for ${endpoint.name}`);
    const planned = plannedChargeOf(entry);
    return runMppChargeSuite({
      target: endpoint.url,
      network: mpp.network,
      payerSecretKey: own.key,
      ...rpc,
      guard: { budget: mpp.budget, ...(planned === undefined ? { notPlanned: entry.reason ?? entry.status } : { planned }) },
    });
  }
  const results = await runMppChannelSuite({
    target: endpoint.url,
    commitmentSecretHex: own.key,
    network: mpp.network,
    ...rpc,
    // The channel and its expected terms come from the config only, never from CHANNEL_CONTRACT.
    ...(endpoint.channel === undefined ? {} : { channelOverride: endpoint.channel }),
    ...(endpoint.expect === undefined ? {} : { expected: endpoint.expect }),
    allowDestructive: false,
  });
  // MPP-13 closes a channel for good: wasit run never runs it, and does not list it (report.ts).
  return results.filter((result) => result.id !== "MPP-13");
}

/** What the run does for one endpoint. `mpp`: the MPP side of a run of the payment tier that may pay. */
async function runEndpoint(endpoint: ResolvedEndpoint, step: PaymentStep, mpp?: MppRun): Promise<CheckResult[]> {
  // B3: once a mainnet run is stopped, every remaining check is skipped with the reason, the unpaid ones too.
  const stopped = step.pay ? step.mainnet?.stopped : undefined;
  if (stopped !== undefined) return everyCheckSkipped(endpoint.protocol, stopped);
  try {
    if (endpoint.protocol === "x402") {
      const shape = {
        method: endpoint.method,
        ...(endpoint.body === undefined ? {} : { body: endpoint.body }),
        ...(Object.keys(endpoint.headers).length === 0 ? {} : { headers: endpoint.headers }),
      };
      const challenge = await runX402ReadChecks({ target: endpoint.url, ...shape });
      if (!step.pay) return [...challenge, ...skippedFor("x402", step)];
      // Every endpoint of the run was planned; one that is not in the plan is not paid.
      const plan = step.plan.endpoints.find((entry) => entry.name === endpoint.name);
      if (plan === undefined) throw new Error(`the plan of this run has no entry for ${endpoint.name}`);
      const payment = await runX402PaymentChecks({
        target: endpoint.url,
        network: step.network,
        payerSecretKey: step.key,
        ...(step.mainnet === undefined ? {} : { mainnet: step.mainnet }),
        ...(step.rpcUrl === undefined ? {} : { rpcUrl: step.rpcUrl }),
        budget: step.budget,
        ...(step.pin === undefined ? {} : { pin: step.pin }),
        plan,
        ...shape,
        // X402-11 sends a payment with the request the config says the service must refuse.
        ...(endpoint.reject === undefined ? {} : { reject: endpoint.reject }),
        ...(step.progress === undefined ? {} : { onProgress: step.progress }),
      });
      return [...challenge, ...payment];
    }
    // Every MPP check pays or signs: the payment tier on an event that may pay runs them on a test network.
    if (mpp !== undefined) return await runMppEndpoint(endpoint, mpp);
    // A mainnet run pays x402 only; MPP stays on test networks (L0).
    if (step.pay) return paymentChecksSkipped(endpoint.protocol, "not-applicable", MPP_NOT_ON_MAINNET);
    // The read-only tier, or an event that may not pay: none to run.
    return skippedFor(endpoint.protocol, step);
  } catch (error) {
    // A check that throws is a defect in Wasit, not a finding about the service.
    return [errored("PREFLIGHT", "Run Preflight", error)];
  }
}

/** The x402 endpoints of a run, as the plan reads them. */
function planEndpoints(resolved: ResolvedRun) {
  return resolved.endpoints
    .filter((endpoint) => endpoint.protocol === "x402")
    .map((endpoint) => ({
      name: endpoint.name,
      target: endpoint.url,
      method: endpoint.method,
      ...(endpoint.body === undefined ? {} : { body: endpoint.body }),
      ...(Object.keys(endpoint.headers).length === 0 ? {} : { headers: endpoint.headers }),
      ...(endpoint.reject === undefined ? {} : { reject: endpoint.reject }),
    }));
}

/**
 * A key variable is set on a run that may not pay (Najmi, 2026-11-16): refused
 * before the service starts, because the service would run in the same job as
 * the key. A fork's pull request has empty secrets and is not refused.
 */
function keyOnRefusedEvent(keys: readonly string[], reason: string): string {
  const why = reason.replace(/^payment checks not run: /, "");
  if (keys.includes(MAINNET_PAYER_KEY_ENV)) {
    // The mainnet key has one place: a job started by hand on the default branch (spec B17.4).
    return (
      `wasit run: ${keys.join(", ")} ${keys.length === 1 ? "is" : "are"} set, and this run may not pay (${why}). ` +
      `Nothing was started, sent or signed. ${MAINNET_PAYER_KEY_ENV} belongs only to a mainnet job started by hand ` +
      `(workflow_dispatch) on the default branch, as the secret of a GitHub environment limited to that branch, with a ` +
      `required reviewer.`
    );
  }
  const first = keys[0] ?? "STELLAR_PRIVATE_KEY";
  return (
    `wasit run: ${keys.join(", ")} ${keys.length === 1 ? "is" : "are"} set, and this run may not pay (${why}). ` +
    `Nothing was started or sent: the service of this run would run in the same job as the key. ` +
    `Give the key only to runs that may pay (push to the default branch, schedule, workflow_dispatch), ` +
    `for example in the env: of the Wasit step:\n` +
    `  ${first}: \${{ github.event_name != 'pull_request' && secrets.WASIT_TESTNET_PAYER || '' }}`
  );
}

/** Why `wasit run` stops in a CI that is not GitHub Actions. */
function otherCiRefusal(keys: readonly string[]): string {
  const key =
    keys.length === 0
      ? ""
      : ` ${keys.join(", ")} ${keys.length === 1 ? "is" : "are"} set: remove ${keys.length === 1 ? "it" : "them"} from ` +
        `this job, since the service of this run would run in the same job as the key.`;
  return (
    `wasit run: CI is set, and this is not GitHub Actions. In this version the payment tier runs outside CI, or in ` +
    `GitHub Actions, where it pays only on a push to the default branch, a schedule and workflow_dispatch. ` +
    `In this CI, run wasit run --read-only, with no payer key in the job.${key} Nothing was started, sent or signed.`
  );
}

/** The payer's address for the first line of a paying run; the checks report a key that is not valid. */
function payerAddress(chain: PaymentChain, key: string): string {
  try {
    return chain.payerAddress(key);
  } catch {
    return "(the key is not valid: see the results)";
  }
}

/** MPP-01's payer for the first line of a paying run: a Stellar secret, read by core's Stellar adapter. */
function mppPayerAddress(key: string): string {
  const stellar = paymentChainFor(MPP_NETWORK);
  return stellar === undefined ? "(not read)" : payerAddress(stellar, key);
}

/** The baseline file, read; the reason when it cannot be. A file that is not there is the first run on main: no reason. */
function readBaselineFile(path: string): BaselineResult | undefined {
  try {
    if (statSync(path).size > MAX_BASELINE_BYTES) {
      return { ok: false, reason: `the baseline is larger than ${MAX_BASELINE_BYTES / 1024} KiB` };
    }
    return readBaseline(readFileSync(path, "utf-8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: `the baseline file cannot be read${typeof code === "string" ? ` (${code})` : ""}` };
  }
}

/**
 * The dry run: the plan of the x402 payment checks (L0, L1), printed. Exit 0
 * when a paying run could start as planned, 2 when it would be refused.
 */
async function printPlan(
  resolved: ResolvedRun,
  stdout: (line: string) => void,
  clean: (text: string) => string,
  fail: (message: string) => number,
): Promise<number> {
  let plan;
  const mainnet = resolved.network === STELLAR_PUBNET;
  // MPP-01 is planned on the network MPP pays on, for the plain GET endpoints (D-036).
  const mppCharge = resolved.network === MPP_NETWORK ? mppChargeInputs(resolved) : [];
  try {
    // B5: the dry run of a mainnet run needs no opt-in, because it signs nothing, and reads no key.
    plan = mainnet
      ? await planMainnetDryRun({
          ...(resolved.pinned === undefined ? {} : { pin: resolved.pinned }),
          ...(resolved.maxRunUsd === undefined ? {} : { maxRunUsd: resolved.maxRunUsd }),
          endpoints: planEndpoints(resolved),
        })
      : await planPaymentRun({
          network: resolved.network,
          ...(resolved.pinned === undefined ? {} : { pin: resolved.pinned }),
          ...(resolved.maxRunUsd === undefined ? {} : { maxRunUsd: resolved.maxRunUsd }),
          x402: planEndpoints(resolved),
          mppCharge,
        });
  } catch (error) {
    // L0: a network that is not a test network, refused before any request.
    if (error instanceof ConfigurationError) return fail(`wasit run --dry-run: ${error.message}`);
    throw error;
  }

  const has = { x402: resolved.endpoints.some((endpoint) => endpoint.protocol === "x402"), mppCharge: mppCharge.length > 0 };
  const lines = [...describeRun(resolved).split("\n"), ...(mainnet ? describePlan(plan) : describePaymentPlan(plan, has))];
  for (const endpoint of resolved.endpoints) {
    if (endpoint.protocol === "x402") continue;
    const why = mainnet
      ? "MPP pays on test networks only; a mainnet run pays its x402 endpoints."
      : resolved.network !== MPP_NETWORK
        ? `the MPP checks run on ${MPP_NETWORK} only, and this run is on ${resolved.network}.`
        : mppShapeProblem(endpoint) !== undefined
          ? `${mppShapeProblem(endpoint)}.`
          : endpoint.protocol === "mpp-channel"
            ? "the channel checks sign commitments off-chain, and Wasit sends no transaction for them, so they are not " +
              "charged to the cap. MPP-13 (close) is never run by wasit run."
            : undefined;
    // A plain MPP charge endpoint on the MPP network is in the plan above.
    if (why !== undefined) lines.push(`  ${endpoint.name}: not planned: ${why}`);
  }
  const refused = plan.refusal !== undefined || plan.endpoints.some((endpoint) => endpoint.status === "refused");
  if (!resolved.operatedByMe) {
    lines.push(
      `Refused: operatedByMe is not true for environment ${resolved.environment}, so a paying run would be ` +
        `refused: Wasit pays only a service its operator runs. Nothing was signed.`,
    );
  }
  if (mainnet) {
    lines.push(
      `A paying run on ${STELLAR_PUBNET} needs --mainnet, its key in ${MAINNET_PAYER_KEY_ENV} only (a dry run reads ` +
        `no key), and an https RPC that serves ${STELLAR_PUBNET} (rpcUrl or WASIT_RPC_URL): ` +
        (resolved.rpcUrl === undefined
          ? "no RPC is set, so a paying run would be refused."
          : `the RPC is ${urlOrigin(resolved.rpcUrl)} (not read by a dry run).`),
    );
  }
  for (const line of lines) stdout(clean(line));
  return refused || !resolved.operatedByMe || (mainnet && resolved.rpcUrl === undefined) ? 2 : 0;
}

export async function executeRun(options: RunCommandOptions, context: RunContext): Promise<number> {
  const secrets = deniedEnvValues(context.env);
  const clean = (text: string): string => sanitizeText(text, { redact: secrets });
  const stderr = (text: string): void => context.stderr(clean(text));
  const fail = (message: string): number => {
    stderr(message);
    return 2;
  };

  const mainnet = options.mainnet === true;
  const dryRun = options.dryRun === true;
  if (mainnet && options.readOnly) {
    return fail("wasit run: --mainnet is for a paying run on stellar:pubnet: choose --mainnet or --read-only, not both.");
  }
  if (options.ledgerDir !== undefined && (!mainnet || dryRun)) {
    return fail("wasit run: --ledger-dir is for a --mainnet run that pays: no other run writes a ledger.");
  }
  if (dryRun && options.readOnly) {
    return fail("wasit run: choose --dry-run or --read-only, not both.");
  }
  if (dryRun && (options.json || options.out !== undefined || options.baseline !== undefined)) {
    return fail("wasit run --dry-run prints a plan and writes no report: it takes no --json, --out or --baseline.");
  }
  if (options.start && options.startIfLocal === true) {
    return fail("wasit run: choose --start or --start-if-local, not both.");
  }

  let resolved: ResolvedRun;
  try {
    resolved = resolveRun(
      readConfigFile(options.config),
      {
        ...(options.env === undefined ? {} : { environment: options.env }),
        ...(options.endpoint === undefined || options.endpoint.length === 0 ? {} : { endpoints: options.endpoint }),
      },
      context.env,
    );
  } catch (error) {
    if (error instanceof ConfigError) return fail(error.message);
    throw error;
  }

  // --mainnet is for stellar:pubnet only, the dry run included.
  if (mainnet && resolved.network !== STELLAR_PUBNET) {
    return fail(
      `wasit run --mainnet: A mainnet run is on ${STELLAR_PUBNET} only, and environment ${resolved.environment} is on ` +
        `another network. Nothing was started, sent or signed.`,
    );
  }

  // D-022a: which GitHub events may pay. A key given to a run that may not pay is
  // refused here, before the service of this run (code that may not be reviewed
  // yet) starts in the same job as the key. Every tier, the read-only one too.
  const event = readGithubEvent(context.env);
  const gate = paymentEventGate(context.env, event);
  if (gate.ciOutsideGithub === true) {
    // In a CI that is not GitHub Actions the payment tier does not run at all, and
    // no tier runs beside a payer key (Najmi, 2026-11-17, review R9 a).
    const keys = payerKeyVariables(context.env);
    if (keys.length > 0 || (!options.readOnly && options.dryRun !== true)) return fail(otherCiRefusal(keys));
  } else if (!gate.allowed) {
    const keys = payerKeyVariables(context.env);
    if (keys.length > 0) return fail(keyOnRefusedEvent(keys, gate.reason ?? "this event"));
    // A mainnet run is never turned into the read-only tier: it stops, and says why.
    if (mainnet && !dryRun) {
      return fail(
        `wasit run --mainnet: this run may not pay (${(gate.reason ?? "this event").replace(/^payment checks not run: /, "")}). ` +
          `In GitHub Actions a mainnet run is started by hand (workflow_dispatch) on the default branch. ` +
          `Nothing was started, sent or signed.`,
      );
    }
  }

  // The mainnet run (spec B5): its own path, opened by core before anything is started or sent.
  if (mainnet && !dryRun) return executeMainnetRun(options, context, resolved, event, { clean, stderr, fail, secrets });

  // The payment tier: neither --read-only nor --dry-run. On an event that may not
  // pay it is the read-only tier, and the report says why.
  const paymentAsked = !options.readOnly && !dryRun;
  const paying = paymentAsked && gate.allowed;
  // Without its switch, a paying run on mainnet is refused before anything is started or sent.
  if (paying && resolved.network === STELLAR_PUBNET) {
    return fail(
      `wasit run: ${STELLAR_PUBNET} is Stellar mainnet: a paying run there needs --mainnet, and every rule of the ` +
        `mainnet opt-in (see wasit run --help). Nothing was started, sent or signed.`,
    );
  }
  const chain = paying ? paymentChainFor(resolved.network) : undefined;
  if (paying && (chain !== undefined || resolved.networkClass !== "unknown")) {
    // L0, before the service starts or anything is sent: a test network only.
    try {
      assertPaymentNetworkAllowed("x402", resolved.network);
    } catch (error) {
      if (error instanceof ConfigurationError) return fail(`wasit run: ${error.message} Nothing was started, sent or signed.`);
      throw error;
    }
  }
  const keyEnv = chain?.payerKeyEnv;
  const keyValue = keyEnv === undefined ? undefined : context.env[keyEnv];
  const key = keyValue === undefined || keyValue.trim() === "" ? undefined : keyValue;
  const hasX402 = resolved.endpoints.some((endpoint) => endpoint.protocol === "x402");
  const operatorRefusal =
    paying && !resolved.operatedByMe
      ? `operatedByMe is not true for environment ${resolved.environment}: Wasit pays only a service its operator runs`
      : undefined;
  /** Why the x402 payment checks that were asked for do not pay, on an event that may pay. */
  const notPaid: string | undefined = !paying
    ? undefined
    : (operatorRefusal ?? (hasX402 && chain !== undefined && key === undefined ? `no payer key: set ${keyEnv} on the Wasit step` : undefined));

  // The MPP side (W3-1, D-036): each mode by the same rules, on the network MPP pays on, with its own key variable.
  const mppSteps = paying
    ? {
        charge: mppStep(resolved, context.env, MPP_PAYER_KEY_ENV, "payer key", operatorRefusal),
        channel: mppStep(resolved, context.env, MPP_COMMITMENT_KEY_ENV, "commitment key", operatorRefusal),
      }
    : undefined;
  const mppChargePays = mppSteps?.charge.pay === true && mppChargeInputs(resolved).length > 0;
  const mppChannelPays =
    mppSteps?.channel.pay === true &&
    resolved.endpoints.some((endpoint) => endpoint.protocol === "mpp-channel" && mppShapeProblem(endpoint) === undefined);
  // D-023 for MPP: the payments are built, the commitments prepared and the settlements read through the RPC, so
  // it is checked before the service starts or any endpoint is asked anything.
  if (mppChargePays || mppChannelPays) {
    try {
      await assertMppPaymentRpc(MPP_NETWORK, resolved.rpcUrl, { charge: mppChargePays });
    } catch (error) {
      if (error instanceof ConfigurationError) return fail(`wasit run: ${error.message} The service was not started.`);
      throw error;
    }
  }

  // D-023a+b: a run that will pay checks its RPC before the service starts or
  // anything is sent to it: the payments are built and the settlements read
  // through it, so it must be one the x402 client accepts (https on Stellar)
  // and serve the run's own network.
  if (paying && notPaid === undefined && chain !== undefined && key !== undefined && hasX402) {
    try {
      await assertX402PaymentRpc(resolved.network, chain.resolveRpcUrl(resolved.network, resolved.rpcUrl));
    } catch (error) {
      if (error instanceof RpcIdentityError) return fail(`wasit run: ${error.message} The service was not started.`);
      throw error;
    }
  }

  const decision = startDecision(options, resolved);
  for (const note of decision.notes) stderr(note);
  const started = await startIfAsked(decision.start, resolved, context, fail);
  if (typeof started === "number") return started;
  const service = started;

  if (dryRun) {
    try {
      return await printPlan(resolved, context.stdout, clean, fail);
    } finally {
      await service?.stop();
    }
  }

  const startedAt = (context.now?.() ?? new Date()).toISOString();
  // Lines about money go where the report is not: stderr with --json, else stdout.
  const say = (line: string): void => (options.json ? stderr(line) : context.stdout(clean(line)));
  try {
    let step: PaymentStep;
    let tierNote: string;
    let budget: RunBudget | undefined;
    let mpp: MppRun | undefined;
    if (!paymentAsked) {
      step = { pay: false, kind: "read-only" };
      tierNote = TIER_NOTE;
    } else if (!gate.allowed) {
      const reason = gate.reason ?? "payment checks not run";
      step = { pay: false, kind: "read-only", reason };
      tierNote = `Tier: read-only (${reason}). Nothing was signed.`;
    } else {
      // The payment tier on an event that may pay. L1 first: one plan of everything the run may sign (the x402
      // payment checks it can pay, and MPP-01), read before anything is signed. A run above its cap does not start.
      const x402Pays = hasX402 && notPaid === undefined && chain !== undefined && key !== undefined;
      const charges = mppChargePays ? mppChargeInputs(resolved) : [];
      let plan: RunPlan | undefined;
      if (x402Pays || charges.length > 0) {
        plan = await planPaymentRun({
          network: resolved.network,
          ...(resolved.pinned === undefined ? {} : { pin: resolved.pinned }),
          ...(resolved.maxRunUsd === undefined ? {} : { maxRunUsd: resolved.maxRunUsd }),
          x402: x402Pays ? planEndpoints(resolved) : [],
          mppCharge: charges,
        });
        const has = { x402: x402Pays, mppCharge: charges.length > 0 };
        if (plan.refusal !== undefined) {
          for (const line of describePaymentPlan(plan, has)) stderr(line);
          return fail(`wasit run: ${plan.refusal}`);
        }
        budget = new RunBudget(resolved.maxRunUsd === undefined ? {} : { maxRunUsd: resolved.maxRunUsd });
        const payers = [
          ...(x402Pays && chain !== undefined && key !== undefined ? [`Payer ${payerAddress(chain, key)}`] : []),
          ...(mppSteps?.charge.pay === true && charges.length > 0 ? [`MPP-01 payer ${mppPayerAddress(mppSteps.charge.key)}`] : []),
        ];
        say(
          `Payment tier on ${resolved.network} (test network): test funds. ${payers.join("; ")}; ` +
            `at most ${formatUsd(plan.perPaymentCapUsd)} per payment; this run could spend up to ` +
            `${formatUsd(plan.worstCaseUsd)} of the ${formatUsd(budget.capUsd)} cap.`,
        );
        for (const line of describePaymentPlan(plan, has).slice(1)) say(line);
      }

      if (notPaid !== undefined) {
        step = { pay: false, kind: resolved.operatedByMe ? "needs-payer" : "read-only", reason: `payment checks not run: ${notPaid}` };
        tierNote = `Tier: payment on ${resolved.network}, and the payment checks were not run: ${notPaid}. Nothing was signed.`;
      } else if (!hasX402) {
        // No x402 endpoint: the step is never used for one.
        step = { pay: false, kind: "not-applicable", reason: "payment checks not run: no x402 endpoint" };
        tierNote = "";
      } else if (chain === undefined || key === undefined || plan === undefined || budget === undefined) {
        // No payment adapter for this network: the payment group is unsupported (spec A3), so the
        // endpoint has no verdict (Najmi, 2026-11-15). Nothing is fetched for it beyond the challenge.
        step = { pay: false, kind: "unsupported", reason: new UnsupportedPaymentNetworkError(resolved.network).message };
        tierNote = `Tier: payment on ${resolved.network}, a network Wasit does not pay on. Nothing was signed.`;
      } else {
        step = {
          pay: true,
          network: resolved.network,
          key,
          ...(resolved.rpcUrl === undefined ? {} : { rpcUrl: resolved.rpcUrl }),
          budget,
          ...(resolved.pinned === undefined ? {} : { pin: resolved.pinned }),
          plan,
          progress: say,
        };
        tierNote = "";
      }
      if (mppSteps !== undefined) {
        mpp = {
          network: resolved.network,
          ...(resolved.rpcUrl === undefined ? {} : { rpcUrl: resolved.rpcUrl }),
          charge: mppSteps.charge,
          channel: mppSteps.channel,
          ...(budget === undefined ? {} : { budget }),
          ...(plan === undefined ? {} : { plan }),
        };
      }
    }

    const endpoints = [];
    for (const endpoint of resolved.endpoints) {
      const results = await runEndpoint(endpoint, step, mpp);
      endpoints.push(
        buildEndpointReport({
          name: endpoint.name,
          protocol: endpoint.protocol,
          method: endpoint.method,
          path: endpoint.path,
          results,
        }),
      );
    }

    if (budget !== undefined) {
      // Charged before each signature and never credited back: what the run may have spent.
      tierNote =
        `Tier: payment on ${resolved.network}. The run charged ${formatUsd(budget.spentUsd)} of the ` +
        `${formatUsd(budget.capUsd)} cap, at most $${PER_PAYMENT_CAP_USD}.00 a payment; every signature is counted as if it settled.`;
    } else if (tierNote === "") {
      tierNote = `Tier: payment on ${resolved.network}. No payment was planned, so nothing was charged to the cap.`;
    }

    // The MPP side: what it signed beside the cap, and why a mode the run has did not run.
    const hasCharge = resolved.endpoints.some((endpoint) => endpoint.protocol === "mpp-charge");
    const hasChannel = resolved.endpoints.some((endpoint) => endpoint.protocol === "mpp-channel");
    const mppNotes: string[] = [];
    /** Why a mode the run has did not pay on an event that may pay, for lack of a key or of operatedByMe: not green. */
    const unpaid = new Set<string>(notPaid !== undefined && hasX402 ? [notPaid] : []);
    for (const [has, label, own] of [
      [hasCharge, "MPP charge", mpp?.charge],
      [hasChannel, "MPP channel", mpp?.channel],
    ] as const) {
      if (!has || own === undefined || own.pay) continue;
      if (own.kind === "needs-payer" || own.kind === "read-only") {
        const why = (own.reason ?? "").replace(/^payment checks not run: /, "");
        unpaid.add(why);
        if (notPaid !== why) mppNotes.push(`${label}: the payment checks were not run: ${why}.`);
      }
    }
    if (hasChannel && mpp?.channel.pay === true) mppNotes.push(MPP_CHANNEL_NOTE);
    const firstUnpaid = [...unpaid][0];

    return writeReport(
      { options, context, resolved, startedAt, endpoints, notes: [tierNote, ...mppNotes], secrets, clean, fail },
      (verdict) =>
        // The payment tier was asked for on an event that may pay and did not pay:
        // not green (a FAIL still outranks it).
        firstUnpaid !== undefined && verdict.code === 0
          ? { ...verdict, code: 2, reason: `the payment tier was asked for and its payment checks were not run: ${firstUnpaid}` }
          : verdict,
    );
  } finally {
    await service?.stop();
  }
}

/** Whether this run starts `service.start`, and the notes that say why not. */
function startDecision(options: RunCommandOptions, resolved: ResolvedRun): { readonly start: boolean; readonly notes: string[] } {
  // The decision is the CLI's, in one place: --start always starts, --start-if-local starts only
  // when service.start is set and the environment is on this machine, and says which it did.
  const notes: string[] = [];
  let start = options.start;
  if (options.startIfLocal === true) {
    const origin = urlOrigin(resolved.baseUrl);
    if (resolved.service?.start === undefined) {
      notes.push(`wasit run: service.start is not set, so ${origin} is read as it is.`);
    } else if (!isLoopbackUrl(resolved.baseUrl)) {
      notes.push(
        `wasit run: environment ${resolved.environment} is at ${origin}, not on this machine, ` +
          `so service.start is not used and ${origin} is read as it is.`,
      );
    } else {
      start = true;
    }
  }
  return { start, notes };
}

/** Starts the service when asked: the service, undefined when not asked, or the exit code of a failure. */
async function startIfAsked(
  start: boolean,
  resolved: ResolvedRun,
  context: RunContext,
  fail: (message: string) => number,
): Promise<StartedService | undefined | number> {
  if (!start) return undefined;
  const { start: command, ready } = resolved.service ?? {};
  if (command === undefined) {
    return fail("wasit run --start needs service.start in the config: the command that starts the service.");
  }
  if (ready === undefined) {
    return fail(
      "wasit run --start needs service.ready in the config: the url on this machine to wait for, " +
        'for example { "url": "http://127.0.0.1:3000/", "timeoutSeconds": 60 }.',
    );
  }
  // D-022a option 2: on a GitHub-hosted runner, a service started while a payer key is set runs as its own user.
  const serviceUser = serviceUserFor(context.env);
  try {
    return await startService({
      command,
      ready,
      env: context.env,
      log: (line) => context.stderr(line),
      ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
      ...(serviceUser === undefined ? {} : { separateUser: { name: serviceUser, ...(context.sudo === undefined ? {} : { sudo: context.sudo }) } }),
    });
  } catch (error) {
    if (error instanceof ServiceError) return fail(error.message);
    throw error;
  }
}

interface ReportInput {
  readonly options: RunCommandOptions;
  readonly context: RunContext;
  readonly resolved: ResolvedRun;
  readonly startedAt: string;
  readonly endpoints: ReturnType<typeof buildEndpointReport>[];
  readonly notes: readonly string[];
  readonly secrets: readonly string[];
  readonly clean: (text: string) => string;
  readonly fail: (message: string) => number;
}

/** Builds, writes and prints the report; returns the exit code, after `adjust` has had its say. */
function writeReport(input: ReportInput, adjust: (verdict: RunVerdict) => RunVerdict = (verdict) => verdict): number {
  const { options, context, resolved, startedAt, endpoints, notes, secrets, clean, fail } = input;
  const base = {
    environment: resolved.environment,
    network: resolved.network,
    startedAt,
    versions: readToolVersions(CLI_VERSION, readBuildCommit(context.env)),
    endpoints,
  };
  const preliminary = buildRunReport({ ...base, notes: [...notes] });
  const selected = selectBaseline(
    preliminary,
    options.baseline === undefined ? undefined : readBaselineFile(options.baseline),
  );
  const report = redactReport(
    selected.note === undefined ? preliminary : buildRunReport({ ...base, notes: [...notes, `Baseline not used: ${selected.note}.`] }),
    [...secrets],
  );
  const verdict = adjust(runExitCode(report, selected.baseline?.report));

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out !== undefined) {
    try {
      writeFileSync(options.out, json);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return fail(`wasit run: cannot write ${options.out}${typeof code === "string" ? ` (${code})` : ""}`);
    }
  }
  if (options.json) {
    context.stdout(json.trimEnd());
    // The JSON says what was found; this line says what the exit code is and why, for a log.
    context.stderr(clean(`Result: ${verdict.reason} (exit ${verdict.code}).`));
  } else {
    for (const line of formatRun(resolved, report, verdict)) context.stdout(clean(line));
  }
  return verdict.code;
}

interface Output {
  readonly clean: (text: string) => string;
  readonly stderr: (text: string) => void;
  readonly fail: (message: string) => number;
  readonly secrets: readonly string[];
}

/** What L4 found, in one line for the run's output. */
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

/**
 * `wasit run --mainnet` (spec B5, B18 O2). Core opens the opt-in before a
 * service starts or the target is asked anything; every refusal before that is
 * exit 2 with nothing started, sent or signed. Once it is open, its opt-in is
 * closed on every way out: L4 waits for the run's authorizations to expire,
 * compares the balances after with the ledger, and releases the lock.
 */
async function executeMainnetRun(
  options: RunCommandOptions,
  context: RunContext,
  resolved: ResolvedRun,
  event: unknown,
  output: Output,
): Promise<number> {
  const { clean, stderr, fail, secrets } = output;
  const cwd = context.cwd ?? process.cwd();
  const ledgerDir = path.resolve(cwd, options.ledgerDir ?? ".");
  const decision = startDecision(options, resolved);
  const workspace = context.env["GITHUB_WORKSPACE"];
  const installDirs = [
    ...(workspace === undefined || workspace.trim() === "" ? [] : [{ label: "GITHUB_WORKSPACE", dir: workspace }]),
    { label: "the config's directory", dir: path.dirname(path.resolve(cwd, options.config)) },
  ];

  let optIn: MainnetOptIn;
  try {
    optIn = await openMainnetOptIn({
      frontEnd: "cli",
      env: context.env,
      environment: resolved.environment,
      network: resolved.network,
      operatedByMe: resolved.operatedByMe,
      pin: resolved.pinned,
      rpcUrl: resolved.rpcUrl,
      ledgerDir,
      ...(resolved.maxRunUsd === undefined ? {} : { maxRunUsd: resolved.maxRunUsd }),
      ...(inGithubActions(context.env)
        ? { job: { defaultBranch: githubDefaultBranch(event), startsService: decision.start, baseUrl: resolved.baseUrl, installDirs } }
        : {}),
    });
  } catch (error) {
    if (error instanceof ConfigurationError) return fail(`wasit run --mainnet: ${error.message}`);
    throw error;
  }

  // Lines about money go where the report is not: stderr with --json, else stdout.
  const say = (line: string): void => (options.json ? stderr(line) : context.stdout(clean(line)));
  let service: StartedService | undefined;
  let close: MainnetCloseResult | undefined;
  try {
    // B5: a mainnet run says so in its first line, before a service starts or the target is asked anything.
    say(mainnetOpeningLine(optIn));
    for (const note of decision.notes) stderr(note);
    const started = await startIfAsked(decision.start, resolved, context, fail);
    if (typeof started === "number") return started;
    service = started;

    const startedAt = (context.now?.() ?? new Date()).toISOString();
    let plan: RunPlan;
    try {
      // L1: the payer's balances, the token's decimals and the latest ledger first, then every endpoint.
      plan = await planX402Run({ network: resolved.network, endpoints: planEndpoints(resolved), mainnet: optIn });
    } catch (error) {
      if (error instanceof ConfigurationError || error instanceof CheckSetupError) return fail(`wasit run --mainnet: ${error.message}`);
      throw error;
    }
    if (plan.refusal !== undefined) {
      for (const line of describePlan(plan)) stderr(line);
      return fail(`wasit run --mainnet: ${plan.refusal}`);
    }
    say(mainnetFirstLine(plan));
    for (const line of describePlan(plan).slice(1)) say(line);

    // The ledger's header names the versions flat: "wasit.cli", "sdk.@x402/core" and so on.
    const versions: Record<string, string> = {};
    for (const [group, entries] of Object.entries(readToolVersions(CLI_VERSION, readBuildCommit(context.env)))) {
      for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
        if (value !== undefined) versions[`${group}.${name}`] = String(value);
      }
    }
    let ledgerPath: string;
    try {
      ledgerPath = optIn.openLedger(versions).path;
    } catch (error) {
      if (error instanceof ConfigurationError || error instanceof CheckSetupError) return fail(`wasit run --mainnet: ${error.message}`);
      throw error;
    }
    say(`Ledger: ${ledgerPath}: every signature is written there before the key signs.`);

    // The key, read at the moment of use from its one variable (B5, B6); core holds it to the opt-in's payer.
    const key = (context.env[MAINNET_PAYER_KEY_ENV] ?? "").trim();
    const step: PaymentStep = { pay: true, network: resolved.network, key, budget: optIn.budget, plan, progress: say, mainnet: optIn };
    const endpoints = [];
    for (const endpoint of resolved.endpoints) {
      const results = await runEndpoint(endpoint, step);
      endpoints.push(
        buildEndpointReport({ name: endpoint.name, protocol: endpoint.protocol, method: endpoint.method, path: endpoint.path, results }),
      );
    }

    // L4: every authorization expired, the balances after read, the ledger closed, the lock released.
    close = await closeMainnetRun(optIn, { ...(context.sleep === undefined ? {} : { sleep: context.sleep }), onProgress: say });
    say(ledgerLine(close));
    const stopped = optIn.stopped;
    if (stopped !== undefined) stderr(`wasit run --mainnet: the run stopped: ${stopped}`);

    // Explained: the payer paid more than the verified settlements, within the payments of checks that FAILed.
    const ledgerResult = close.consistency?.result ?? "inconsistent";
    const notes = [
      `Tier: MAINNET payment on ${resolved.network}: real funds. The run charged ${formatUsd(optIn.budget.spentUsd)} of the ` +
        `${formatUsd(optIn.budget.capUsd)} cap, at most $${PER_PAYMENT_CAP_USD}.00 a payment; every signature is counted as if it settled.`,
      `Run ledger ${path.basename(ledgerPath)}: ${ledgerResult} with the payer's balances on public Horizon.`,
      ...(stopped === undefined ? [] : [`The mainnet run stopped: ${stopped}`]),
    ];
    return writeReport({ options, context, resolved, startedAt, endpoints, notes, secrets, clean, fail }, (verdict) => {
      // B3: a mainnet run that stopped exits 2, and so does one whose ledger does not match the chain. An
      // explained ledger exits by the checks: the FAILs that explain it are the run's verdict.
      if (stopped !== undefined) return { ...verdict, code: 2, reason: `the mainnet run stopped: ${stopped}` };
      if (ledgerResult === "inconsistent") return { ...verdict, code: 2, reason: "the run ledger is not consistent with the payer's balances" };
      return verdict;
    });
  } finally {
    // Every way out closes the opt-in; a run that signed waits for its authorizations first.
    if (close === undefined) {
      await closeMainnetRun(optIn, { ...(context.sleep === undefined ? {} : { sleep: context.sleep }), onProgress: say });
    }
    await service?.stop();
  }
}
