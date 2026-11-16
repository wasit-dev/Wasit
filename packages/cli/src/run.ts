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
 * test network (L0; the mainnet opt-in is not part of this version), the
 * environment has `operatedByMe: true`, the chain's key variable is set, and
 * the plan (L1) fits the caps. Then one budget is shared by every endpoint, each
 * endpoint's checks get its entry of the plan, and the pin and `maxRunUsd` come
 * from the config; L2 and L3 hold every signature in core. On a pull request the
 * run is the read-only tier and says so. A key variable that is set on a run that
 * may not pay is refused before the service starts (Najmi, 2026-11-16).
 *
 * `executeRun` does not call `process.exit` and does not read the process: the
 * environment and the output are passed in, so it can be tested in-process.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";

import {
  ConfigError,
  ConfigurationError,
  MAX_BASELINE_BYTES,
  PER_PAYMENT_CAP_USD,
  RunBudget,
  assertPaymentNetworkAllowed,
  buildEndpointReport,
  buildRunReport,
  deniedEnvValues,
  describePlan,
  describeRun,
  errored,
  formatUsd,
  isLoopbackUrl,
  payerKeyVariables,
  paymentChainFor,
  paymentChecksSkipped,
  paymentEventGate,
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
  skippedPaymentChecks,
  urlOrigin,
  type BaselineResult,
  type CheckResult,
  type PaymentChain,
  type PinTerms,
  type ResolvedEndpoint,
  type ResolvedRun,
  type RunPlan,
  type RunVerdict,
  type SkipKind,
  UnsupportedPaymentNetworkError,
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
}

const TIER_NOTE = "Tier: read-only. The payment checks were not run, and nothing was signed.";

const MPP_NOT_IN_RUN =
  "wasit run does not pay MPP in this version: run wasit mpp-charge or wasit mpp-channel against this endpoint";

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
    };

function skippedFor(protocol: ResolvedEndpoint["protocol"], step: Extract<PaymentStep, { pay: false }>): CheckResult[] {
  if (step.reason === undefined && (step.kind === "read-only" || step.kind === "needs-payer")) {
    return skippedPaymentChecks(protocol, step.kind);
  }
  return paymentChecksSkipped(protocol, step.kind, step.reason ?? "the payment checks were not run");
}

/** What the run does for one endpoint. */
async function runEndpoint(endpoint: ResolvedEndpoint, step: PaymentStep): Promise<CheckResult[]> {
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
        ...(step.rpcUrl === undefined ? {} : { rpcUrl: step.rpcUrl }),
        budget: step.budget,
        ...(step.pin === undefined ? {} : { pin: step.pin }),
        plan,
        ...shape,
      });
      return [...challenge, ...payment];
    }
    // Every MPP check pays or signs. The read-only tier has none to run, and the
    // payment tier of wasit run does not run them in this version.
    if (step.pay) return paymentChecksSkipped(endpoint.protocol, "not-applicable", MPP_NOT_IN_RUN);
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
    }));
}

/**
 * A key variable is set on a run that may not pay (Najmi, 2026-11-16): refused
 * before the service starts, because the service would run in the same job as
 * the key. A fork's pull request has empty secrets and is not refused.
 */
function keyOnRefusedEvent(keys: readonly string[], reason: string): string {
  const why = reason.replace(/^payment checks not run: /, "");
  const first = keys[0] ?? "STELLAR_PRIVATE_KEY";
  return (
    `wasit run: ${keys.join(", ")} ${keys.length === 1 ? "is" : "are"} set, and this run may not pay (${why}). ` +
    `Nothing was started or sent: the service of this run would run in the same job as the key. ` +
    `Give the key only to runs that may pay (push to the default branch, schedule, workflow_dispatch), ` +
    `for example in the env: of the Wasit step:\n` +
    `  ${first}: \${{ github.event_name != 'pull_request' && secrets.WASIT_TESTNET_PAYER || '' }}`
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
  try {
    plan = await planX402Run({
      network: resolved.network,
      ...(resolved.pinned === undefined ? {} : { pin: resolved.pinned }),
      ...(resolved.maxRunUsd === undefined ? {} : { maxRunUsd: resolved.maxRunUsd }),
      endpoints: planEndpoints(resolved),
    });
  } catch (error) {
    // L0: a network that is not a test network, refused before any request.
    if (error instanceof ConfigurationError) return fail(`wasit run --dry-run: ${error.message}`);
    throw error;
  }

  const lines = [...describeRun(resolved).split("\n"), ...describePlan(plan)];
  for (const endpoint of resolved.endpoints) {
    if (endpoint.protocol !== "x402") {
      lines.push(`  ${endpoint.name}: not planned: the dry run plans the x402 payment checks; ${endpoint.protocol} is not planned in this version.`);
    }
  }
  const refused = plan.refusal !== undefined || plan.endpoints.some((endpoint) => endpoint.status === "refused");
  if (!resolved.operatedByMe) {
    lines.push(
      `Refused: operatedByMe is not true for environment ${resolved.environment}, so a paying run would be ` +
        `refused: Wasit pays only a service its operator runs. Nothing was signed.`,
    );
  }
  for (const line of lines) stdout(clean(line));
  return refused || !resolved.operatedByMe ? 2 : 0;
}

export async function executeRun(options: RunCommandOptions, context: RunContext): Promise<number> {
  const secrets = deniedEnvValues(context.env);
  const clean = (text: string): string => sanitizeText(text, { redact: secrets });
  const stderr = (text: string): void => context.stderr(clean(text));
  const fail = (message: string): number => {
    stderr(message);
    return 2;
  };

  const dryRun = options.dryRun === true;
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

  // D-022a: which GitHub events may pay. A key given to a run that may not pay is
  // refused here, before the service of this run (code that may not be reviewed
  // yet) starts in the same job as the key. Every tier, the read-only one too.
  const gate = paymentEventGate(context.env, readGithubEvent(context.env));
  if (!gate.allowed) {
    const keys = payerKeyVariables(context.env);
    if (keys.length > 0) return fail(keyOnRefusedEvent(keys, gate.reason ?? "this event"));
  }

  // The payment tier: neither --read-only nor --dry-run. On an event that may not
  // pay it is the read-only tier, and the report says why.
  const paymentAsked = !options.readOnly && !dryRun;
  const paying = paymentAsked && gate.allowed;
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
  /** Why the payment tier that was asked for does not pay, on an event that may pay. */
  const notPaid: string | undefined = !paying
    ? undefined
    : !resolved.operatedByMe
      ? `operatedByMe is not true for environment ${resolved.environment}: Wasit pays only a service its operator runs`
      : chain !== undefined && key === undefined
        ? `no payer key: set ${keyEnv} on the Wasit step`
        : undefined;

  // The decision is the CLI's, in one place: --start always starts, --start-if-local starts only
  // when service.start is set and the environment is on this machine, and says which it did.
  let shouldStart = options.start;
  if (options.startIfLocal === true) {
    const origin = urlOrigin(resolved.baseUrl);
    if (resolved.service?.start === undefined) {
      stderr(`wasit run: service.start is not set, so ${origin} is read as it is.`);
    } else if (!isLoopbackUrl(resolved.baseUrl)) {
      stderr(
        `wasit run: environment ${resolved.environment} is at ${origin}, not on this machine, ` +
          `so service.start is not used and ${origin} is read as it is.`,
      );
    } else {
      shouldStart = true;
    }
  }

  let service: StartedService | undefined;
  // D-022a option 2: on a GitHub-hosted runner, a service started while a payer key is set runs as its own user.
  const serviceUser = serviceUserFor(context.env);
  if (shouldStart) {
    const { start, ready } = resolved.service ?? {};
    if (start === undefined) {
      return fail("wasit run --start needs service.start in the config: the command that starts the service.");
    }
    if (ready === undefined) {
      return fail(
        "wasit run --start needs service.ready in the config: the url on this machine to wait for, " +
          'for example { "url": "http://127.0.0.1:3000/", "timeoutSeconds": 60 }.',
      );
    }
    try {
      service = await startService({
        command: start,
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
    if (!paymentAsked) {
      step = { pay: false, kind: "read-only" };
      tierNote = TIER_NOTE;
    } else if (!gate.allowed) {
      const reason = gate.reason ?? "payment checks not run";
      step = { pay: false, kind: "read-only", reason };
      tierNote = `Tier: read-only (${reason}). Nothing was signed.`;
    } else if (notPaid !== undefined) {
      step = { pay: false, kind: resolved.operatedByMe ? "needs-payer" : "read-only", reason: `payment checks not run: ${notPaid}` };
      tierNote = `Tier: payment on ${resolved.network}, and the payment checks were not run: ${notPaid}. Nothing was signed.`;
    } else if (chain === undefined || key === undefined) {
      // No payment adapter for this network: the payment group is unsupported (spec A3), so the
      // endpoint has no verdict (Najmi, 2026-11-15). Nothing is fetched for it beyond the challenge.
      step = { pay: false, kind: "unsupported", reason: new UnsupportedPaymentNetworkError(resolved.network).message };
      tierNote = `Tier: payment on ${resolved.network}, a network Wasit does not pay on. Nothing was signed.`;
    } else {
      // L1: the plan, read before anything is signed. A run above its cap does not start.
      const plan = await planX402Run({
        network: resolved.network,
        ...(resolved.pinned === undefined ? {} : { pin: resolved.pinned }),
        ...(resolved.maxRunUsd === undefined ? {} : { maxRunUsd: resolved.maxRunUsd }),
        endpoints: planEndpoints(resolved),
      });
      if (plan.refusal !== undefined) {
        for (const line of describePlan(plan)) stderr(line);
        return fail(`wasit run: ${plan.refusal}`);
      }
      budget = new RunBudget(resolved.maxRunUsd === undefined ? {} : { maxRunUsd: resolved.maxRunUsd });
      say(
        `Payment tier on ${resolved.network} (test network): test funds. Payer ${payerAddress(chain, key)}; ` +
          `at most ${formatUsd(plan.perPaymentCapUsd)} per payment; this run could spend up to ` +
          `${formatUsd(plan.worstCaseUsd)} of the ${formatUsd(budget.capUsd)} cap.`,
      );
      for (const line of describePlan(plan).slice(1)) say(line);
      step = {
        pay: true,
        network: resolved.network,
        key,
        ...(resolved.rpcUrl === undefined ? {} : { rpcUrl: resolved.rpcUrl }),
        budget,
        ...(resolved.pinned === undefined ? {} : { pin: resolved.pinned }),
        plan,
      };
      tierNote = "";
    }

    const endpoints = [];
    for (const endpoint of resolved.endpoints) {
      const results = await runEndpoint(endpoint, step);
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
    }

    const input = {
      environment: resolved.environment,
      network: resolved.network,
      startedAt,
      versions: readToolVersions(CLI_VERSION, readBuildCommit(context.env)),
      endpoints,
    };
    const preliminary = buildRunReport({ ...input, notes: [tierNote] });
    const selected = selectBaseline(
      preliminary,
      options.baseline === undefined ? undefined : readBaselineFile(options.baseline),
    );
    const report = redactReport(
      selected.note === undefined
        ? preliminary
        : buildRunReport({ ...input, notes: [tierNote, `Baseline not used: ${selected.note}.`] }),
      secrets,
    );
    let verdict: RunVerdict = runExitCode(report, selected.baseline?.report);
    // The payment tier was asked for on an event that may pay and did not pay:
    // not green (a FAIL still outranks it).
    if (notPaid !== undefined && hasX402 && verdict.code === 0) {
      verdict = { ...verdict, code: 2, reason: `the payment tier was asked for and its payment checks were not run: ${notPaid}` };
    }

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
  } finally {
    await service?.stop();
  }
}
