/**
 * `wasit init` as the built binary (`npm run build` first): the flags as
 * commander reads them, and the exit codes a script sees. Runs in an empty
 * temporary directory with an empty HOME; no service, no request.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

interface Finished {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function wasit(args: string[], cwd: string): Promise<Finished> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", HOME: cwd, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "wasit-init-cli-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("wasit init (built binary)", () => {
  it("writes the example project's config from its flags, exit 0", async () => {
    const { code, stdout, stderr } = await wasit(
      [
        "init",
        "--url",
        "http://127.0.0.1:4402/paid",
        "--operated-by-me",
        "--name",
        "quote-of-the-day",
        "--start",
        "npm start",
        "--ready-timeout",
        "30",
        "--reject-header",
        "x-quote-lang: xx",
        "--reject-note",
        "a language the quote does not exist in must be refused",
      ],
      dir,
    );
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Next: wasit run --read-only\n$/);
    const config = JSON.parse(await readFile(path.join(dir, "wasit.config.json"), "utf-8")) as Record<string, unknown>;
    assert.deepEqual(config["service"], { start: "npm start", ready: { url: "http://127.0.0.1:4402/paid", timeoutSeconds: 30 } });
    assert.deepEqual(config["endpoints"], [
      {
        name: "quote-of-the-day",
        protocol: "x402",
        path: "/paid",
        method: "GET",
        reject: { headers: { "x-quote-lang": "xx" }, note: "a language the quote does not exist in must be refused" },
      },
    ]);
  });

  it("exit 2 without --url, and without --operated-by-me, writing nothing", async () => {
    const bare = await wasit(["init"], dir);
    assert.equal(bare.code, 2);
    assert.match(bare.stderr, /--url is required/);
    const notMine = await wasit(["init", "--url", "http://127.0.0.1:4402/paid"], dir);
    assert.equal(notMine.code, 2);
    assert.match(notMine.stderr, /Wasit tests only services their operator runs/);
    assert.ok(!existsSync(path.join(dir, "wasit.config.json")));
  });

  it("exit 2 on a flag it does not know", async () => {
    const { code, stderr } = await wasit(["init", "--url", "http://127.0.0.1:4402/paid", "--operated-by-me", "--mainnet"], dir);
    assert.equal(code, 2);
    assert.match(stderr, /unknown option '--mainnet'/);
    assert.ok(!existsSync(path.join(dir, "wasit.config.json")));
  });
});
