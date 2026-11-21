/**
 * The lock file of a mainnet run (spec B4, B17.5), written before the code
 * (B11). The caps hold one run to $5; a second mainnet run started on the same
 * machine while one is open would get its own $5. So a mainnet run takes a
 * lock file in its ledger's folder before it reads its payer's balance, and a
 * second one that finds the file there does not start.
 *
 * Any lock file that is there refuses the run, whoever left it: a run that is
 * still open, one that was stopped or crashed (its authorizations may still be
 * open, so a person reads its ledger before deleting the file), or a file that
 * is not a lock Wasit can read. The lock is never taken over or deleted by
 * another run. It does not see another machine or runner (B4); the account's
 * $10 is the limit there.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { ConfigurationError } from "../../src/errors.js";
import { MAINNET_RUN_LOCK_FILE, MainnetRunLockedError, acquireMainnetRunLock } from "../../src/guard/run-lock.js";

const CORE = fileURLToPath(new URL("../../", import.meta.url));
const MODULE = fileURLToPath(new URL("../../src/guard/run-lock.ts", import.meta.url));
const POSIX = process.platform !== "win32";

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wasit-lock-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function refused(dir: string): MainnetRunLockedError {
  try {
    const lock = acquireMainnetRunLock(dir);
    lock.release();
  } catch (error) {
    assert.ok(error instanceof MainnetRunLockedError, `not a MainnetRunLockedError: ${String(error)}`);
    assert.ok(error instanceof ConfigurationError, "a held lock is a ConfigurationError: it says nothing about the target");
    return error;
  }
  assert.fail("the second mainnet run was not refused");
}

/** A lock file as Wasit writes it, for a process `pid`. */
function lockText(pid: number, token = "someone-else"): string {
  return `${JSON.stringify({ wasit: "mainnet-run-lock", pid, startedAt: "2026-11-21T10:00:00.000Z", token })}\n`;
}

/** The pid of a process that ran and has ended. */
async function endedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  assert.ok(pid !== undefined);
  return pid;
}

/** Runs `source` (an ES module) in a fresh Node process that has tsx, from core's folder. */
function runScript(dir: string, source: string): { readonly done: Promise<{ code: number | null; stdout: string }>; readonly child: ReturnType<typeof spawn> } {
  const script = path.join(dir, `script-${Math.random().toString(36).slice(2)}.mts`);
  writeFileSync(script, source);
  const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: CORE, stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const done = new Promise<{ code: number | null; stdout: string }>((resolve) =>
    child.on("exit", (code) => resolve({ code, stdout })),
  );
  return { done, child };
}

describe("the lock file of a mainnet run (B4, B17.5)", () => {
  it("is taken in the ledger's folder, created when missing, readable by its owner only, and released", () => {
    const dir = path.join(freshDir(), "ledgers", "nested");
    const lock = acquireMainnetRunLock(dir);
    const file = path.join(dir, MAINNET_RUN_LOCK_FILE);
    assert.equal(lock.path, file);
    assert.equal(MAINNET_RUN_LOCK_FILE, "wasit-mainnet.lock");
    assert.ok(existsSync(file));
    const content = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(content["wasit"], "mainnet-run-lock");
    assert.equal(content["pid"], process.pid);
    assert.match(String(content["startedAt"]), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(typeof content["token"], "string");
    if (POSIX) assert.equal(statSync(file).mode & 0o777, 0o600);
    lock.release();
    assert.ok(!existsSync(file), "release left the lock file");
  });

  it("refuses a second run while the first holds it, and leaves the first one's lock as it was", () => {
    const dir = freshDir();
    const first = acquireMainnetRunLock(dir);
    const before = readFileSync(first.path, "utf8");
    const error = refused(dir);
    assert.equal(error.holder, "running");
    assert.equal(error.lockPath, first.path);
    assert.ok(error.message.includes(`process ${process.pid}`), error.message);
    assert.match(error.message, /One mainnet run at a time on this machine/);
    assert.match(error.message, /\$5\.00/);
    assert.match(error.message, /Nothing was signed\./);
    assert.equal(readFileSync(first.path, "utf8"), before, "the refused run changed the lock");
    first.release();
    assert.ok(!existsSync(first.path));
    acquireMainnetRunLock(dir).release();
  });

  it("can be released more than once, and after the file is gone", () => {
    const dir = freshDir();
    const lock = acquireMainnetRunLock(dir);
    lock.release();
    lock.release();
    const again = acquireMainnetRunLock(dir);
    unlinkSync(again.path);
    again.release();
  });

  it("is not deleted on release when the file there is no longer this run's", () => {
    const dir = freshDir();
    const lock = acquireMainnetRunLock(dir);
    writeFileSync(lock.path, lockText(process.pid, "another-run"));
    lock.release();
    assert.ok(existsSync(lock.path), "release deleted a lock that was not its own");
  });

  it("refuses a lock left by a process that has ended, and leaves it for a person to read and delete", async () => {
    const dir = freshDir();
    const pid = await endedPid();
    const file = path.join(dir, MAINNET_RUN_LOCK_FILE);
    writeFileSync(file, lockText(pid));
    const error = refused(dir);
    assert.equal(error.holder, "gone");
    assert.ok(error.message.includes(`process ${pid}`), error.message);
    assert.match(error.message, /no longer running/);
    assert.match(error.message, /authorizations it signed may still be open/);
    assert.match(error.message, /ledger/);
    assert.match(error.message, /then delete/);
    assert.match(error.message, /Nothing was signed\./);
    assert.equal(readFileSync(file, "utf8"), lockText(pid), "the lock was taken over");
  });

  it("refuses a file there that is not a lock it can read, and leaves it", () => {
    for (const text of ["", "not json", "{}", JSON.stringify({ wasit: "mainnet-run-lock", pid: -1 }), JSON.stringify({ wasit: "other", pid: process.pid }), JSON.stringify({ wasit: "mainnet-run-lock", pid: "12" }), "x".repeat(10_000)]) {
      const dir = freshDir();
      const file = path.join(dir, MAINNET_RUN_LOCK_FILE);
      writeFileSync(file, text);
      const error = refused(dir);
      assert.equal(error.holder, "unknown", JSON.stringify(text.slice(0, 40)));
      assert.match(error.message, /not a lock Wasit can read/);
      assert.match(error.message, /Nothing was signed\./);
      assert.equal(readFileSync(file, "utf8"), text, "the file was changed");
    }
  });

  it("reads a lock as Wasit's only when every field is: one field off makes it unknown, and nothing odd is echoed", () => {
    const valid = { wasit: "mainnet-run-lock", pid: process.pid, startedAt: "2026-11-21T10:00:00.000Z", token: "t" };
    const cases: Array<[string, string]> = [
      ["another tag", JSON.stringify({ ...valid, wasit: "other" })],
      ["pid 0 (the process group)", JSON.stringify({ ...valid, pid: 0 })],
      ["a negative pid", JSON.stringify({ ...valid, pid: -1 })],
      ["a pid as text", JSON.stringify({ ...valid, pid: String(process.pid) })],
      ["a start time in another shape", JSON.stringify({ ...valid, startedAt: "\u001b]0;x\u0007" })],
      ["no token", JSON.stringify({ ...valid, token: undefined })],
      ["larger than a lock", `${JSON.stringify(valid)}${" ".repeat(5000)}`],
    ];
    for (const [label, text] of cases) {
      const dir = freshDir();
      writeFileSync(path.join(dir, MAINNET_RUN_LOCK_FILE), text);
      const error = refused(dir);
      assert.equal(error.holder, "unknown", label);
      // eslint-disable-next-line no-control-regex
      assert.ok(!/[\u0000-\u001f\u007f]/.test(error.message), `${label}: a control character reached the message`);
    }
    // The control: the same lock with every field right reads as held by this process.
    const dir = freshDir();
    writeFileSync(path.join(dir, MAINNET_RUN_LOCK_FILE), JSON.stringify(valid));
    assert.equal(refused(dir).holder, "running");
  });

  it("reads a lock of a process it may not signal (EPERM) as running", { skip: !POSIX || process.getuid?.() === 0 }, () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, MAINNET_RUN_LOCK_FILE), lockText(1));
    assert.equal(refused(dir).holder, "running");
  });

  it("does not read a lock through a symbolic link, even to a valid lock", { skip: !POSIX }, () => {
    const dir = freshDir();
    const target = path.join(dir, "elsewhere.lock");
    writeFileSync(target, lockText(process.pid));
    symlinkSync(target, path.join(dir, MAINNET_RUN_LOCK_FILE));
    assert.equal(refused(dir).holder, "unknown");
  });

  it("refuses a directory in the lock's place", () => {
    const dir = freshDir();
    mkdirSync(path.join(dir, MAINNET_RUN_LOCK_FILE));
    assert.equal(refused(dir).holder, "unknown");
  });

  it("refuses a symbolic link in the lock's place and never writes through it", { skip: !POSIX }, () => {
    const dir = freshDir();
    const target = path.join(dir, "elsewhere.txt");
    writeFileSync(target, "untouched");
    symlinkSync(target, path.join(dir, MAINNET_RUN_LOCK_FILE));
    assert.equal(refused(dir).holder, "unknown");
    assert.equal(readFileSync(target, "utf8"), "untouched");
    assert.ok(lstatSync(path.join(dir, MAINNET_RUN_LOCK_FILE)).isSymbolicLink());
    // A dangling link is refused the same way, and nothing is created at its target.
    rmSync(target);
    assert.equal(refused(dir).holder, "unknown");
    assert.ok(!existsSync(target), "the lock was written through a dangling link");
  });

  it("refuses to start when the lock cannot be created, as a setup problem, not a held lock", () => {
    const parent = freshDir();
    const notADir = path.join(parent, "file");
    writeFileSync(notADir, "a file where the folder should be");
    let error: unknown;
    try {
      acquireMainnetRunLock(notADir);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof ConfigurationError, `not a ConfigurationError: ${String(error)}`);
    assert.ok(!(error instanceof MainnetRunLockedError), "a lock that could not be created read as a held one");
    assert.match(error.message, /could not be created/);
    assert.match(error.message, /Nothing was signed\./);
  });

  it("refuses to start in a folder it cannot write to", { skip: !POSIX || process.getuid?.() === 0 }, () => {
    const dir = freshDir();
    chmodSync(dir, 0o500);
    assert.throws(() => acquireMainnetRunLock(dir), (error: unknown) => error instanceof ConfigurationError && !(error instanceof MainnetRunLockedError) && /could not be created/.test(error.message));
    chmodSync(dir, 0o700);
    assert.ok(!existsSync(path.join(dir, MAINNET_RUN_LOCK_FILE)));
  });

  it("keeps control characters of the folder's name out of the message", { skip: !POSIX }, () => {
    const dir = path.join(freshDir(), "a\u001b]0;x\u0007b");
    mkdirSync(dir);
    const first = acquireMainnetRunLock(dir);
    const error = refused(dir);
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\u0000-\u001f\u007f]/.test(error.message), "a control character reached the message");
    first.release();
  });

  it("adds one exit listener while held and removes it on release", () => {
    const before = process.listenerCount("exit");
    const lock = acquireMainnetRunLock(freshDir());
    assert.equal(process.listenerCount("exit"), before + 1);
    lock.release();
    assert.equal(process.listenerCount("exit"), before);
    // A refused run adds none.
    const held = acquireMainnetRunLock(freshDir());
    const count = process.listenerCount("exit");
    refused(path.dirname(held.path));
    assert.equal(process.listenerCount("exit"), count);
    held.release();
  });

  it("is released when the process exits without calling release", async () => {
    const dir = freshDir();
    const { done } = runScript(
      dir,
      `import { acquireMainnetRunLock } from ${JSON.stringify(MODULE)};\n` +
        `acquireMainnetRunLock(${JSON.stringify(dir)});\nconsole.log("held");\nprocess.exitCode = 0;\n`,
    );
    const { code, stdout } = await done;
    assert.equal(code, 0);
    assert.match(stdout, /held/);
    assert.ok(!existsSync(path.join(dir, MAINNET_RUN_LOCK_FILE)), "the exit left the lock file");
  });

  it("is left behind by a process that is killed, and the next run is refused with 'no longer running'", { skip: !POSIX }, async () => {
    const dir = freshDir();
    const { done, child } = runScript(
      dir,
      `import { acquireMainnetRunLock } from ${JSON.stringify(MODULE)};\n` +
        `acquireMainnetRunLock(${JSON.stringify(dir)});\nconsole.log("held");\nsetInterval(() => {}, 1000);\n`,
    );
    await new Promise<void>((resolve) => {
      child.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("held")) resolve();
      });
    });
    child.kill("SIGKILL");
    await done;
    assert.ok(existsSync(path.join(dir, MAINNET_RUN_LOCK_FILE)), "a killed run removed its lock");
    assert.equal(refused(dir).holder, "gone");
  });

  it("lets exactly one of several runs started at once take it", async () => {
    const dir = freshDir();
    const source =
      `import { acquireMainnetRunLock, MainnetRunLockedError } from ${JSON.stringify(MODULE)};\n` +
      `try { const lock = acquireMainnetRunLock(${JSON.stringify(dir)}); console.log("won"); ` +
      `setTimeout(() => lock.release(), 4000); } catch (error) { ` +
      `console.log(error instanceof MainnetRunLockedError ? "refused" : "other " + String(error)); }\n`;
    const runs = Array.from({ length: 4 }, () => runScript(dir, source).done);
    const outputs = (await Promise.all(runs)).map((run) => run.stdout.trim());
    assert.equal(outputs.filter((line) => line === "won").length, 1, outputs.join(" | "));
    assert.equal(outputs.filter((line) => line === "refused").length, 3, outputs.join(" | "));
    assert.ok(!existsSync(path.join(dir, MAINNET_RUN_LOCK_FILE)), "the winner's release left the lock");
  });
});
