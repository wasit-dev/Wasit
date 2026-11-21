/**
 * Which GitHub events may run the payment tier (D-022a option 2, D-032).
 *
 * The payment tier runs only where the code that runs is code that was merged:
 * a push to the default branch, a schedule (GitHub runs it on the default
 * branch), and workflow_dispatch on the default branch. Every pull request event
 * is refused, a same-repository one too: its branch's code and new dependencies
 * would run in the same job as the payer key before anyone reviewed them. Every
 * other event is refused as well (merge_group and workflow_run run code that is
 * not on the default branch yet). Outside GitHub Actions the gate is open: a run
 * on a laptop is the builder's own choice.
 *
 * What this stops is a mistake in a workflow, not its author (B-A10): a step
 * can hide the runner's variables from the CLI. The control that holds is
 * where the workflow gives the secret, which the guide explains.
 */

import { readFileSync, statSync } from "node:fs";

import { DENIED_ENV_NAMES } from "../denied-env.js";

export interface PaymentEventGate {
  readonly allowed: boolean;
  /** Set when not allowed: the reason a skipped payment check gives, "payment checks not run: ...". */
  readonly reason?: string;
  /**
   * Not allowed because the run is in a CI that is not GitHub Actions (`CI`
   * set): there the service of the run would share its job with the key, and
   * nothing keeps them apart. `wasit run` refuses the payment tier there.
   */
  readonly ciOutsideGithub?: true;
}

const ALLOWED_EVENTS = "Wasit pays on push to the default branch, schedule and workflow_dispatch only";
/** An event name or a branch, as far as it is ever printed. Anything else is not echoed. */
const PRINTABLE_EVENT = /^[a-z_]{1,64}$/;
const PRINTABLE_REF = /^[A-Za-z0-9._/-]{1,200}$/;
const MAX_EVENT_BYTES = 1024 * 1024;

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value !== "";
}

function shownEvent(event: string): string {
  return PRINTABLE_EVENT.test(event) ? event : "(an event name Wasit does not print)";
}

function shownRef(ref: string): string {
  if (ref === "") return "no ref";
  return PRINTABLE_REF.test(ref) ? ref : "(a ref Wasit does not print)";
}

/**
 * The default branch the event payload names (`repository.default_branch`),
 * in a shape that is safe to echo; undefined otherwise. The mainnet job rules
 * hold the run's ref to it (spec B17.4).
 */
export function githubDefaultBranch(event: unknown): string | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const repository = (event as { repository?: unknown }).repository;
  if (repository === null || typeof repository !== "object") return undefined;
  const branch = (repository as { default_branch?: unknown }).default_branch;
  return typeof branch === "string" && PRINTABLE_REF.test(branch) ? branch : undefined;
}

/**
 * True when the process runs as a step of GitHub Actions, or says it does.
 * Fail closed: either variable counts, with any value that is not empty, as
 * the CLI's own CI test reads `GITHUB_ACTIONS`.
 */
export function inGithubActions(env: Readonly<Record<string, string | undefined>>): boolean {
  return nonEmpty(env["GITHUB_ACTIONS"]) || nonEmpty(env["GITHUB_EVENT_NAME"]);
}

/**
 * May this run pay? `event` is the parsed payload of `GITHUB_EVENT_PATH`
 * ({@link readGithubEvent}), or undefined when there is none.
 */
export function paymentEventGate(env: Readonly<Record<string, string | undefined>>, event: unknown): PaymentEventGate {
  if (!inGithubActions(env)) {
    // Najmi, 2026-11-17 (review R9 a): outside GitHub Actions only a run outside CI pays.
    if (nonEmpty(env["CI"])) {
      return { allowed: false, reason: "payment checks not run: CI is set, and this is not GitHub Actions", ciOutsideGithub: true };
    }
    return { allowed: true };
  }

  const name = env["GITHUB_EVENT_NAME"] ?? "";
  if (name.startsWith("pull_request")) return { allowed: false, reason: "payment checks not run: pull request" };
  if (name !== "push" && name !== "schedule" && name !== "workflow_dispatch") {
    return {
      allowed: false,
      reason: `payment checks not run: the ${shownEvent(name)} event (${ALLOWED_EVENTS})`,
    };
  }

  const ref = env["GITHUB_REF"] ?? "";
  const branch = githubDefaultBranch(event);
  if (branch === undefined) {
    // GitHub runs a schedule on the default branch, and its payload may not name
    // the repository; its ref must still be a branch.
    if (name === "schedule" && ref.startsWith("refs/heads/")) return { allowed: true };
    return {
      allowed: false,
      reason: `payment checks not run: the ${name} event does not name the default branch, so Wasit cannot tell that ${shownRef(ref)} is it`,
    };
  }
  if (ref !== `refs/heads/${branch}`) {
    return {
      allowed: false,
      reason: `payment checks not run: ${name} on ${shownRef(ref)}, not the default branch ${branch} (${ALLOWED_EVENTS})`,
    };
  }
  return { allowed: true };
}

/**
 * The payload of the event that started the workflow, from the file
 * `GITHUB_EVENT_PATH` names; undefined when there is none, it cannot be read,
 * it is not JSON, or it is above 1 MiB.
 */
export function readGithubEvent(env: Readonly<Record<string, string | undefined>>): unknown {
  const file = env["GITHUB_EVENT_PATH"];
  if (!nonEmpty(file)) return undefined;
  try {
    if (statSync(file).size > MAX_EVENT_BYTES) return undefined;
    return JSON.parse(readFileSync(file, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The key variables that hold a value, by their fixed names in upper case. A
 * blank value is not a key: a pull request from a fork gets every secret as an
 * empty string.
 */
export function payerKeyVariables(env: Readonly<Record<string, string | undefined>>): string[] {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (DENIED_ENV_NAMES.includes(upper) && typeof value === "string" && value.trim() !== "") names.add(upper);
  }
  return [...names];
}
