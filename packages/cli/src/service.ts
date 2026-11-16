/**
 * `wasit run --start`: start the builder's service, wait until it answers, and
 * stop it again (spec A8 #1, A-A02).
 *
 * Why this lives in the CLI and not in the Action: a composite action is one
 * step for the workflow that uses it, so a variable set on the action reaches
 * every step inside, the one that starts the service included. Here the
 * child's environment is built in one place, from the parent's with the
 * variables Wasit keeps away from a service removed (see `denied-env.ts` in
 * core), and the same code runs on a laptop and in CI.
 *
 * Stopping is the part that must not fail quietly. A service is a shell command
 * (`npm start`), so the process that starts is a shell and the service is its
 * child or grandchild. On POSIX the command is started in a process group of
 * its own and the whole group is signalled: SIGTERM first, SIGKILL after a grace
 * period. The service is stopped when a run ends normally, when it fails, on
 * SIGINT, SIGTERM and SIGHUP, and, as a last synchronous resort, when the Node
 * process exits. A SIGKILL of Wasit itself cannot be caught.
 *
 * Windows: the group kill is `taskkill /pid <pid> /T /F`. That path has NOT been
 * run on Windows; no Windows machine was available.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";

import { deniedEnvValues, isLoopbackUrl, payerKeyVariables, sanitizeText, scrubEnv, urlOrigin } from "@wasit-dev/core";

/**
 * The OS user a service runs as when it must not share a user with the payer
 * key (D-022a option 2). Fixed in code: a config or a variable never chooses it.
 */
export const SERVICE_USER = "wasit-service";

/**
 * The user to run the service as, or undefined for the runner's own user.
 *
 * Najmi, 2026-11-16: a separate user only when a payer key variable is set AND
 * the runner is GitHub-hosted (`RUNNER_ENVIRONMENT`, which GitHub documents as
 * `github-hosted` or `self-hosted`; not re-read on the day). A hosted runner's
 * user has passwordless sudo, which makes the user; a self-hosted runner or a
 * laptop may not, and there the service runs as today. What this separates is
 * the service's own processes from the Wasit process that holds the key: on
 * Linux the environment of a process (`/proc/<pid>/environ`) is readable by its
 * own user and root only. It does NOT separate code that ran earlier in the job
 * as the runner's user (install scripts), which the guide says.
 */
export function serviceUserFor(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return payerKeyVariables(env).length > 0 && env["RUNNER_ENVIRONMENT"] === "github-hosted" ? SERVICE_USER : undefined;
}

/** The service runs as `name`, through `sudo -n`. `sudo` is the program to run: a test passes a stand-in. */
export interface SeparateUser {
  readonly name: string;
  readonly sudo?: string;
}

/** The service did not start, did not answer, or exited. Nothing was learned about the target: exit 2. */
export class ServiceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface ServiceOptions {
  /** `service.start`: one shell command, as trusted as the repository's own code. */
  readonly command: string;
  /** `service.ready`: any HTTP answer counts. Held to this machine. */
  readonly ready: { readonly url: string; readonly timeoutSeconds: number };
  /** The environment to derive the child's from. The denied variables are removed. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  /** Where the service's output goes, one line at a time. Default `console.error`: stdout stays for `--json`. */
  readonly log?: (line: string) => void;
  /** How long SIGTERM gets before SIGKILL. Default 5000. */
  readonly stopGraceMs?: number;
  /** After this many bytes of output, the rest is not printed (the service is not blocked). Default 256 KiB. */
  readonly maxLogBytes?: number;
  /** Default 250. */
  readonly pollIntervalMs?: number;
  /** Run the service as this user (see {@link serviceUserFor}). POSIX only; no fallback when it cannot be had. */
  readonly separateUser?: SeparateUser;
}

const SUDO_TIMEOUT_MS = 120_000;

/**
 * Runs as the service's user: reads `{ command, env }` as JSON from stdin, runs
 * the command with `sh -c` and exactly that environment, passes signals on and
 * exits with the command's code. CommonJS, for `node -e`.
 */
const SERVICE_LAUNCHER = [
  'let input = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (chunk) => { input += chunk; });',
  'process.stdin.on("end", () => {',
  '  let request;',
  '  try { request = JSON.parse(input); } catch { process.exit(64); }',
  '  const child = require("node:child_process").spawn("sh", ["-c", String(request.command)], { env: request.env, stdio: ["ignore", "inherit", "inherit"] });',
  '  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => { try { child.kill(signal); } catch {} });',
  '  child.on("error", () => process.exit(127));',
  '  child.on("exit", (code) => process.exit(code === null ? 1 : code));',
  '});',
].join("\n");

/** Runs `sudo -n <args>`, collects its stderr, and never throws: a sudo that cannot be run is code 127. */
function runSudo(sudo: string, args: readonly string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(sudo, ["-n", ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    const timer = setTimeout(() => child.kill("SIGKILL"), SUDO_TIMEOUT_MS);
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 2000) stderr += chunk;
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: 127, stderr: "sudo could not be run" });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr });
    });
  });
}

/**
 * Makes the user when it does not exist, and lets it reach the working
 * directory, by ACL for that one user: traverse (`x`) on each directory above
 * it, read and write inside it, nothing on its `.git` (where actions/checkout
 * keeps the job's token unless persist-credentials is false). Write access is
 * given to the working directory only; beyond it the user can read what the
 * directories already let any user read.
 */
async function prepareUser(user: SeparateUser, cwd: string, secrets: readonly string[]): Promise<string> {
  const sudo = user.sudo ?? "sudo";
  const home = `/home/${user.name}`;
  const refuse = (what: string, result: { code: number; stderr: string }): never => {
    const said = sanitizeText(result.stderr.trim().replace(/\s+/g, " "), { redact: secrets }).slice(0, 300);
    throw new ServiceError(
      `the service must run as a separate user (${user.name}) on a GitHub-hosted runner when a payer key is set, ` +
        `and ${what} failed (sudo -n, exit ${result.code}${said === "" ? "" : `: ${said}`}). It was not started as ` +
        `the runner's own user instead. This needs passwordless sudo, useradd and setfacl, as GitHub-hosted Linux runners have.`,
    );
  };

  const exists = await runSudo(sudo, ["id", "-u", user.name]);
  if (exists.code === 127) refuse("running sudo", exists);
  if (exists.code !== 0) {
    const made = await runSudo(sudo, [
      "useradd",
      "--system",
      "--create-home",
      "--home-dir",
      home,
      "--shell",
      "/usr/sbin/nologin",
      user.name,
    ]);
    if (made.code !== 0) refuse(`making the user (useradd)`, made);
  }

  let directory: string;
  try {
    directory = realpathSync(cwd);
  } catch {
    throw new ServiceError(`the working directory of the service cannot be read, so the separate user ${user.name} cannot be given it`);
  }
  const above: string[] = [];
  for (let parent = path.dirname(directory); parent !== path.dirname(parent); parent = path.dirname(parent)) {
    above.push(parent);
  }
  if (above.length > 0) {
    const traverse = await runSudo(sudo, ["setfacl", "-m", `u:${user.name}:x`, ...above]);
    if (traverse.code !== 0) refuse("letting the user reach the working directory (setfacl)", traverse);
  }
  const grant = await runSudo(sudo, ["setfacl", "-R", "-m", `u:${user.name}:rwX,d:u:${user.name}:rwX`, directory]);
  if (grant.code !== 0) refuse("giving the user the working directory (setfacl)", grant);
  const git = path.join(directory, ".git");
  if (existsSync(git)) {
    const deny = await runSudo(sudo, ["setfacl", "-R", "-m", `u:${user.name}:---`, git]);
    if (deny.code !== 0) refuse("keeping the user out of .git (setfacl)", deny);
  }
  return home;
}

export interface StartedService {
  readonly pid: number;
  /** Stops the service and everything it started. Safe to call twice. */
  readonly stop: () => Promise<void>;
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const PROBE_TIMEOUT_MS = 2000;
const KILL_WAIT_MS = 2000;
const MAX_PENDING_LINE = 8192;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() >= end) return false;
    await sleep(25);
  }
  return true;
}

/** Any HTTP answer, whatever the status. Never follows a redirect. */
async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await response.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export async function startService(options: ServiceOptions): Promise<StartedService> {
  const { command, ready } = options;
  const origin = urlOrigin(ready.url);
  // Defence in depth: the config loader holds the url to this machine, and so does this.
  if (!isLoopbackUrl(ready.url)) {
    throw new ServiceError(
      "service.ready.url must be an address on this machine (localhost, 127.x.x.x or [::1]): " +
        "the wait probes the service the run starts, nothing else",
    );
  }

  const log = options.log ?? ((line: string) => console.error(line));
  const secrets = deniedEnvValues(options.env);
  const posix = process.platform !== "win32";
  const maxLogBytes = options.maxLogBytes ?? 256 * 1024;

  const separate = options.separateUser;
  const sudo = separate?.sudo ?? "sudo";
  const childEnv = scrubEnv(options.env);
  let child: ChildProcess;
  if (separate === undefined) {
    child = spawn(command, {
      shell: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so the whole tree can be signalled at once.
      detached: posix,
      windowsHide: true,
    });
  } else {
    if (!posix) throw new ServiceError("a separate user for the service is built for Linux runners only");
    const home = await prepareUser(separate, options.cwd ?? process.cwd(), secrets);
    log(`[wasit] the service runs as the user ${separate.name}, not as the user that holds the payer key`);
    // The service's environment and its command go on stdin, as JSON, to a small launcher
    // that runs as that user: sudo resets the environment, and the hosted runner's sudo
    // ignores -E (run 43815743541, 2026-11-16). A command line can be read by any user;
    // stdin cannot. The launcher's own code is the only thing on the command line.
    child = spawn(sudo, ["-n", "-u", separate.name, "--", process.execPath, "-e", SERVICE_LAUNCHER], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { PATH: childEnv["PATH"] ?? "/usr/local/bin:/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(
      JSON.stringify({
        command,
        env: {
          ...childEnv,
          PATH: childEnv["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: home,
          USER: separate.name,
          LOGNAME: separate.name,
        },
      }),
    );
  }

  let spawnError: Error | undefined;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("exit", (code, signal) => {
    exitInfo = { code, signal };
  });

  // The service's output, line by line, through the sanitiser and behind a
  // prefix: it is text the repository chose, and a line that starts with `::`
  // is a command to the GitHub runner.
  let printed = 0;
  let cut = false;
  const emitLine = (raw: string): void => {
    if (cut) return;
    printed += raw.length + 1;
    if (printed > maxLogBytes) {
      cut = true;
      log(`[service] output cut: more than ${Math.round(maxLogBytes / 1024)} KiB, the rest is not shown`);
      return;
    }
    log(`[service] ${sanitizeText(raw, { redact: secrets })}`);
  };
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) continue;
    let pending = "";
    stream.setEncoding("utf-8");
    stream.on("data", (chunk: string) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        emitLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_PENDING_LINE) {
        emitLine(pending);
        pending = "";
      }
    });
    stream.on("end", () => {
      if (pending !== "") emitLine(pending);
      pending = "";
    });
    stream.on("error", () => undefined);
  }

  const pid = child.pid;
  if (pid === undefined) {
    await sleep(0);
    throw new ServiceError(
      `could not start the service${spawnError === undefined ? "" : ` (${(spawnError as NodeJS.ErrnoException).code ?? "spawn failed"})`}`,
    );
  }

  // A service of another user is signalled through sudo, by user: the user is the
  // service's alone, so this reaches everything it started, a process that left
  // the group included.
  const userAlive = (name: string): boolean =>
    spawnSync(sudo, ["-n", "pgrep", "-u", name], { stdio: "ignore", timeout: 10_000 }).status === 0;
  const signalUser = (name: string, signal: NodeJS.Signals): void => {
    spawnSync(sudo, ["-n", "pkill", `-${signal.replace(/^SIG/, "")}`, "-u", name], { stdio: "ignore", timeout: 10_000 });
  };
  const groupAlive = (): boolean => {
    if (separate !== undefined) return userAlive(separate.name);
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (separate !== undefined) {
      signalUser(separate.name, signal);
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  };
  const taskkill = (): void => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => undefined);
  };

  const terminate = async (): Promise<void> => {
    const grace = options.stopGraceMs ?? 5000;
    if (posix) {
      if (!groupAlive()) return;
      signalGroup("SIGTERM");
      if (await waitFor(() => !groupAlive(), grace)) return;
      signalGroup("SIGKILL");
      await waitFor(() => !groupAlive(), KILL_WAIT_MS);
      return;
    }
    if (exitInfo !== undefined) return;
    taskkill();
    await waitFor(() => exitInfo !== undefined, grace);
  };

  // Last resort, synchronous: Node is exiting and a service is still there.
  const onProcessExit = (): void => {
    if (posix) {
      signalGroup("SIGKILL");
    } else if (exitInfo === undefined) {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }
  };
  const signalHandlers = SIGNALS.map((signal) => {
    const handler = (): void => {
      // Stop the service, then leave with the conventional code for the signal.
      void stop().finally(() => process.exit(128 + (osConstants.signals[signal] ?? 0)));
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  process.on("exit", onProcessExit);

  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    stopping ??= terminate().finally(() => {
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
      process.removeListener("exit", onProcessExit);
    });
    return stopping;
  }

  const fail = async (message: string): Promise<never> => {
    await stop();
    throw new ServiceError(message);
  };

  const deadline = Date.now() + ready.timeoutSeconds * 1000;
  const interval = options.pollIntervalMs ?? 250;
  for (;;) {
    if (exitInfo !== undefined) {
      const how =
        exitInfo.code !== null ? `exited with code ${exitInfo.code}` : `was ended by ${exitInfo.signal ?? "a signal"}`;
      return fail(`the service ${how} before it answered at ${origin}; its output is above`);
    }
    if (spawnError !== undefined) return fail("could not start the service");
    if (await answers(ready.url)) return { pid, stop };
    if (Date.now() >= deadline) {
      const seconds = ready.timeoutSeconds;
      return fail(`no answer from ${origin} within ${seconds} second${seconds === 1 ? "" : "s"}; the service was stopped`);
    }
    await sleep(interval);
  }
}
