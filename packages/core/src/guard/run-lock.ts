/**
 * The lock file of a mainnet run (spec B4, B17.5).
 *
 * The caps hold one run to $5 (`budget.ts`). A second mainnet run started on
 * the same machine while one is open would get its own $5. So a mainnet run
 * takes this lock in its ledger's folder before it reads its payer's balance,
 * and a run that finds a lock there does not start.
 *
 * Any file in the lock's place refuses the run, whoever left it: a run that is
 * still open; a run that was stopped or crashed, whose authorizations may still
 * be open, so a person reads its ledger before deleting the file; or a file
 * that is not a lock Wasit can read. No run takes over or deletes another's
 * lock. The file is created exclusively (it fails when anything is at its path,
 * a symbolic link included), so two runs started at once cannot both take it.
 *
 * What it does not see: a run on another machine or runner, and a run whose
 * ledger is in another folder (spec B4). The payer account's $10
 * (`mainnet-payer.ts`) is the limit there.
 *
 * This version has no mainnet opt-in (spec B12): nothing calls this yet. The
 * opt-in takes the lock before L1 and releases it when the run has ended.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

import { ConfigurationError } from "../errors.js";
import { sanitizeText } from "../sanitize.js";
import { PER_RUN_CAP_USD, formatUsd, usdFromDollars } from "./budget.js";

/** The lock's name in the ledger's folder. */
export const MAINNET_RUN_LOCK_FILE = "wasit-mainnet.lock";

/** What the lock file says it is. */
const TAG = "mainnet-run-lock";

/** A lock Wasit writes is far smaller; a larger file is not read. */
const MAX_LOCK_BYTES = 4096;

/** A start time as `Date.toISOString` writes it; anything else is never echoed. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** An error code as Node writes them; anything else is never echoed. */
const ERROR_CODE = /^E[A-Z]{2,20}$/;

/** Who holds the lock a run found. */
export type LockHolder =
  /** A process that is still running. */
  | "running"
  /** A process that has ended without releasing it. */
  | "gone"
  /** The file is not a lock Wasit can read. */
  | "unknown";

/**
 * A mainnet run does not start: a lock is already in its ledger's folder. A
 * `ConfigurationError`: it says nothing about the target. Nothing was signed.
 */
export class MainnetRunLockedError extends ConfigurationError {
  public readonly lockPath: string;
  public readonly holder: LockHolder;

  public constructor(lockPath: string, holder: LockHolder, message: string) {
    super(`${message} Nothing was signed.`);
    this.name = "MainnetRunLockedError";
    this.lockPath = lockPath;
    this.holder = holder;
  }
}

/** A lock this run holds. */
export interface MainnetRunLock {
  /** The lock file. */
  readonly path: string;
  /**
   * Deletes the lock file when it is still this run's. Safe to call more than
   * once, and after the file is gone. It is also called when the process exits
   * (`exit`), but not when the process is killed: then the file stays, and the
   * next run is refused until a person deletes it.
   */
  release(): void;
}

interface LockContent {
  readonly pid: number;
  readonly startedAt: string;
  readonly token: string;
}

/** The lock at `file`, when it is a regular file Wasit wrote; undefined otherwise. */
function readLock(file: string): LockContent | undefined {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { wasit, pid, startedAt, token } = parsed as Record<string, unknown>;
    if (wasit !== TAG || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
    if (typeof startedAt !== "string" || !ISO_TIME.test(startedAt) || typeof token !== "string") return undefined;
    return { pid, startedAt, token };
  } catch {
    return undefined;
  }
}

/** Whether process `pid` runs on this machine; undefined when that cannot be told. */
function isRunning(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return undefined;
  }
}

function lockedError(file: string): MainnetRunLockedError {
  const shownFile = sanitizeText(file);
  const lock = readLock(file);
  const running = lock === undefined ? undefined : isRunning(lock.pid);
  if (lock === undefined || running === undefined) {
    return new MainnetRunLockedError(
      file,
      "unknown",
      `${shownFile} is there and is not a lock Wasit can read, so this mainnet run does not start. If no mainnet run ` +
        `is open, read the latest ledger in that folder, wait until the last authorization in it has expired, then ` +
        `delete ${shownFile}.`,
    );
  }
  const holder = `process ${lock.pid}, started ${lock.startedAt}`;
  if (running) {
    return new MainnetRunLockedError(
      file,
      "running",
      `Another mainnet run (${holder}) holds ${shownFile}. One mainnet run at a time on this machine: the ` +
        `${formatUsd(usdFromDollars(PER_RUN_CAP_USD))} cap holds each run, not two at once on one account. Wait until ` +
        `it has ended.`,
    );
  }
  return new MainnetRunLockedError(
    file,
    "gone",
    `${shownFile} was left by a mainnet run (${holder}) that is no longer running: it ended without releasing the ` +
      `lock, and authorizations it signed may still be open. Read that run's ledger, wait until the last ` +
      `authorization in it has expired, then delete ${shownFile}.`,
  );
}

function notCreated(dir: string, error: unknown): ConfigurationError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return new ConfigurationError(
    `The lock file of a mainnet run could not be created in ${sanitizeText(dir)}` +
      `${typeof code === "string" && ERROR_CODE.test(code) ? ` (${code})` : ""}, so the run does not start. ` +
      `Nothing was signed.`,
  );
}

/**
 * Takes the lock of a mainnet run in `dir`, the folder of the run's ledger,
 * creating the folder when it is missing.
 *
 * @throws {MainnetRunLockedError} When anything is already at the lock's path.
 * @throws {ConfigurationError} When the lock cannot be created.
 */
export function acquireMainnetRunLock(dir: string): MainnetRunLock {
  const file = path.join(dir, MAINNET_RUN_LOCK_FILE);
  const token = randomUUID();
  const content = `${JSON.stringify({ wasit: TAG, pid: process.pid, startedAt: new Date().toISOString(), token })}\n`;

  try {
    // Apart from the open: mkdir also says EEXIST, for a file where the folder should be.
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw notCreated(dir, error);
  }
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw lockedError(file);
    throw notCreated(dir, error);
  }
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(file);
    } catch {
      // nothing more to do: the run does not start either way
    }
    throw notCreated(dir, error);
  }
  closeSync(fd);

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    if (readLock(file)?.token !== token) return;
    try {
      unlinkSync(file);
    } catch {
      // gone already
    }
  };
  process.once("exit", release);
  return { path: file, release };
}
