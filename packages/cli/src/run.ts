/**
 * `wasit run`: the endpoints of a `wasit.config.json`, one after another, with
 * one report (spec A2, A8).
 *
 * In this version every run is read-only. The payment tier is refused before a
 * config is read or anything is sent; the flags that would open it (`--dry-run`,
 * `--mainnet`, a key) are not registered. An x402 endpoint gets its unpaid
 * challenge checks (X402-01..05) and nothing else; its payment checks, and every
 * MPP check, are reported as skipped for the tier, so the report says which
 * checks need a payer instead of leaving them out.
 *
 * `executeRun` does not call `process.exit` and does not read the process: the
 * environment and the output are passed in, so it can be tested in-process.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";

import {
  ConfigError,
  MAX_BASELINE_BYTES,
  buildEndpointReport,
  buildRunReport,
  deniedEnvValues,
  errored,
  isLoopbackUrl,
  readBaseline,
  readConfigFile,
  readToolVersions,
  redactReport,
  resolveRun,
  runExitCode,
  runX402ReadChecks,
  sanitizeText,
  selectBaseline,
  skippedPaymentChecks,
  urlOrigin,
  type BaselineResult,
  type CheckResult,
  type ResolvedEndpoint,
  type ResolvedRun,
} from "@wasit-dev/core";

import { formatRun } from "./run-format.js";
import { ServiceError, startService, type StartedService } from "./service.js";
import { CLI_VERSION } from "./version.js";

export interface RunCommandOptions {
  readonly config: string;
  readonly env?: string;
  readonly endpoint?: readonly string[];
  readonly readOnly: boolean;
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
}

const TIER_NOTE = "Tier: read-only. The payment checks were not run, and nothing was signed.";

/** What the read-only tier does for one endpoint. */
async function runEndpoint(endpoint: ResolvedEndpoint): Promise<CheckResult[]> {
  try {
    if (endpoint.protocol === "x402") {
      const challenge = await runX402ReadChecks({
        target: endpoint.url,
        method: endpoint.method,
        ...(endpoint.body === undefined ? {} : { body: endpoint.body }),
        ...(Object.keys(endpoint.headers).length === 0 ? {} : { headers: endpoint.headers }),
      });
      return [...challenge, ...skippedPaymentChecks("x402", "read-only")];
    }
    // Every MPP check pays or signs: the read-only tier has none to run.
    return skippedPaymentChecks(endpoint.protocol, "read-only");
  } catch (error) {
    // A check that throws is a defect in Wasit, not a finding about the service.
    return [errored("PREFLIGHT", "Run Preflight", error)];
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

export async function executeRun(options: RunCommandOptions, context: RunContext): Promise<number> {
  const secrets = deniedEnvValues(context.env);
  const clean = (text: string): string => sanitizeText(text, { redact: secrets });
  const stderr = (text: string): void => context.stderr(clean(text));
  const fail = (message: string): number => {
    stderr(message);
    return 2;
  };

  if (!options.readOnly) {
    return fail(
      "wasit run: the payment tier is not available in this version. Pass --read-only to run the " +
        "unpaid challenge checks, which send no payment and sign nothing.",
    );
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
      });
    } catch (error) {
      if (error instanceof ServiceError) return fail(error.message);
      throw error;
    }
  }

  const startedAt = (context.now?.() ?? new Date()).toISOString();
  try {
    const endpoints = [];
    for (const endpoint of resolved.endpoints) {
      const results = await runEndpoint(endpoint);
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

    const input = {
      environment: resolved.environment,
      network: resolved.network,
      startedAt,
      versions: readToolVersions(CLI_VERSION),
      endpoints,
    };
    const preliminary = buildRunReport({ ...input, notes: [TIER_NOTE] });
    const selected = selectBaseline(
      preliminary,
      options.baseline === undefined ? undefined : readBaselineFile(options.baseline),
    );
    const report = redactReport(
      selected.note === undefined
        ? preliminary
        : buildRunReport({ ...input, notes: [TIER_NOTE, `Baseline not used: ${selected.note}.`] }),
      secrets,
    );
    const verdict = runExitCode(report, selected.baseline?.report);

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
