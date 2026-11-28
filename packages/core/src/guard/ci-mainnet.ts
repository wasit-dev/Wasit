/**
 * The rules for a mainnet job in GitHub Actions (spec B17.4).
 *
 * Inside one job, code that ran earlier as the runner's user can reach every
 * later step: it can put a program of its own first on PATH, change files on
 * disk, or leave a process running that reads the environment of the step
 * that holds the key (and a GitHub-hosted runner's user has passwordless sudo).
 * No check inside the job holds against such code, since that code can change
 * the check. So these rules do not look for it: they refuse the workflows in
 * which it would be there. A mainnet run in GitHub Actions is started by hand,
 * on the default branch, on a GitHub-hosted runner (a fresh machine per job);
 * it tests a deployed service, so no code of the service runs in the job; it
 * runs where nothing was installed before Wasit; and the mainnet key is the
 * only key variable set.
 *
 * They stop a wrong workflow, not a person or code that sets out to get past
 * them. What holds against those is GitHub's: the mainnet key kept as the
 * secret of a GitHub environment limited to the default branch, with a
 * required reviewer. Outside GitHub Actions none of these rules applies: on a
 * builder's own machine the CLI may test a local service.
 *
 * The opt-in (`openMainnetOptIn`) calls {@link assertMainnetJob} whenever
 * `GITHUB_ACTIONS` is true, before the lock is taken and anything is sent.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { DENIED_ENV_NAMES } from "../denied-env.js";
import { ConfigurationError } from "../errors.js";
import { inGithubActions } from "./ci-event.js";

/** The variable a mainnet run reads its key from (spec B5). */
const MAINNET_KEY = "WASIT_MAINNET_PAYER_SECRET";

/** An event name as GitHub writes them; anything else is never echoed. */
const EVENT_NAME = /^[a-z_]{1,64}$/;
/** A branch or tag ref, and a branch name, in a shape that is safe to echo. */
const REF = /^refs\/(heads|tags)\/[A-Za-z0-9._/-]{1,200}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

export interface MainnetJob {
  /** The process environment. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The repository's default branch, from the event; undefined when it cannot be read. */
  readonly defaultBranch: string | undefined;
  /** The run's environment starts a service in the job (`service.start`). */
  readonly startsService: boolean;
  /** The run's `baseUrl`. */
  readonly baseUrl: string;
  /** Where a `node_modules` would show that something was installed before Wasit, with a label for the message. */
  readonly installDirs: ReadonlyArray<{ readonly label: string; readonly dir: string }>;
}

/** A job that may not make a mainnet run, with every rule it breaks. */
export class MainnetJobRefusedError extends ConfigurationError {
  public readonly refusals: readonly string[];

  public constructor(refusals: readonly string[]) {
    super(
      `This job may not make a mainnet run: ${refusals.join("; ")}. Nothing was started, sent or signed. These ` +
        `rules stop a wrong workflow, not code that already ran in this job: keep the mainnet key as the secret of ` +
        `a GitHub environment limited to the default branch, with a required reviewer.`,
    );
    this.name = "MainnetJobRefusedError";
    this.refusals = refusals;
  }
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function listed(names: readonly string[]): string {
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}

function isLocalIpv4(a: number, b: number): boolean {
  return (
    a === 127 || // loopback
    a === 0 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) || // link-local
    (a === 100 && b >= 64 && b <= 127) // shared address space
  );
}

function isLocalIpv6(address: string): boolean {
  if (address === "::1" || address === "::") return true;
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (mappedHex !== null) {
    const high = Number.parseInt(mappedHex[1]!, 16);
    return isLocalIpv4(high >> 8, high & 0xff);
  }
  const mappedDotted = /^::ffff:(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(address);
  if (mappedDotted !== null) return isLocalIpv4(Number(mappedDotted[1]), Number(mappedDotted[2]));
  const first = Number.parseInt(address.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // unique local, link-local
}

/**
 * A host only this machine or its own network reaches, as `URL.hostname`
 * writes it: a loopback, private, link-local or shared address, `localhost`,
 * a single-label name, or a `.local` or `.internal` name.
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) return isLocalIpv6(host.slice(1, -1));
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 !== null) return isLocalIpv4(Number(v4[1]), Number(v4[2]));
  if (!host.includes(".")) return true;
  return host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
}

/**
 * Every rule of a mainnet job that `job` breaks, one clause each; empty when it
 * breaks none, and always empty outside GitHub Actions. No key, and no event
 * name, ref or path in an odd shape, is echoed.
 */
export function mainnetJobRefusals(job: MainnetJob, exists: (file: string) => boolean = existsSync): string[] {
  if (!inGithubActions(job.env)) return [];
  const refusals: string[] = [];

  const event = job.env["GITHUB_EVENT_NAME"] ?? "";
  if (event !== "workflow_dispatch") {
    refusals.push(
      `a mainnet run is started by hand (workflow_dispatch), and this run's event is ${EVENT_NAME.test(event) ? event : "another event"}`,
    );
  }

  if (job.env["RUNNER_ENVIRONMENT"] !== "github-hosted") {
    refusals.push(
      "a mainnet run needs a GitHub-hosted runner (RUNNER_ENVIRONMENT github-hosted): a self-hosted runner keeps " +
        "files and processes between jobs",
    );
  }

  const ref = job.env["GITHUB_REF"] ?? "";
  if (job.defaultBranch === undefined || !BRANCH.test(job.defaultBranch)) {
    refusals.push("the repository's default branch could not be read from the event, so this run cannot be shown to be on it");
  } else if (ref !== `refs/heads/${job.defaultBranch}`) {
    refusals.push(
      `a mainnet run runs on the default branch (${job.defaultBranch}), and this run's ref is ${REF.test(ref) ? ref : "another ref"}`,
    );
  }

  if (job.startsService) {
    refusals.push(
      "the environment starts a service in the job (service.start): a mainnet run tests a deployed service, so that " +
        "no code of the service runs in the job that holds the key",
    );
  }

  let host: string | undefined;
  try {
    host = new URL(job.baseUrl).hostname;
  } catch {
    host = undefined;
  }
  if (host === undefined || isLocalHost(host)) {
    refusals.push(
      "baseUrl is a local address (a loopback, private or single-label host): a mainnet run tests a deployed service",
    );
  }

  for (const { label, dir } of job.installDirs) {
    if (exists(path.join(dir, "node_modules"))) {
      refusals.push(
        `a node_modules directory is in ${label}: code was installed in this job before Wasit, and a mainnet job ` +
          `holds only checkout, setup-node and Wasit`,
      );
    }
  }

  const others = DENIED_ENV_NAMES.filter((name) => name !== MAINNET_KEY && nonEmpty(job.env[name]));
  if (others.length > 0) {
    refusals.push(
      `only ${MAINNET_KEY} may be set on a mainnet run, and ${listed(others)} ${others.length === 1 ? "is" : "are"} set too`,
    );
  }
  return refusals;
}

/** Throws {@link MainnetJobRefusedError} when `job` breaks any rule of a mainnet job. */
export function assertMainnetJob(job: MainnetJob, exists: (file: string) => boolean = existsSync): void {
  const refusals = mainnetJobRefusals(job, exists);
  if (refusals.length > 0) throw new MainnetJobRefusedError(refusals);
}
