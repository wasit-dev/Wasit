/**
 * `wasit init` as the built binary (`npm run build` first): the flags as
 * commander reads them, and the exit codes a script sees. Runs in an empty
 * temporary directory with an empty HOME; the one route it reads is on
 * 127.0.0.1.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
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
  it("writes the example project's config from its flags with --no-read, exit 0", async () => {
    const { code, stdout, stderr } = await wasit(
      [
        "init",
        "--url",
        "http://127.0.0.1:4402/paid",
        "--operated-by-me",
        "--no-read",
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

  it("reads the route by default: one unpaid request, exit 0; --protocol is checked before it", async () => {
    let requests = 0;
    const accepts = [
      {
        scheme: "exact",
        network: "stellar:testnet",
        amount: "10000",
        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        payTo: "GDQ2NVWFGVLUCCGCFGWUWDA75EZ2KYNWUQAPEJKFQGMW5UOA7DAM5JD5",
        maxTimeoutSeconds: 60,
      },
    ];
    const server = http.createServer((_request, response) => {
      requests += 1;
      response.writeHead(402, { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64") });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const bogus = await wasit(["init", "--url", `http://127.0.0.1:${port}/paid`, "--operated-by-me", "--protocol", "lightning"], dir);
      assert.equal(bogus.code, 2);
      assert.match(bogus.stderr, /--protocol "lightning" is not one of x402, mpp-charge, mpp-channel/);
      assert.equal(requests, 0);

      const { code, stdout, stderr } = await wasit(["init", "--url", `http://127.0.0.1:${port}/paid`, "--operated-by-me"], dir);
      assert.equal(code, 0, stderr);
      assert.equal(requests, 1);
      assert.match(stdout, /written: protocol x402, network stellar:testnet/);
      const config = JSON.parse(await readFile(path.join(dir, "wasit.config.json"), "utf-8")) as {
        environments: Record<string, { pinned?: unknown }>;
      };
      assert.deepEqual(config.environments["local"]?.pinned, { payTo: accepts[0]!.payTo, asset: accepts[0]!.asset });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("exit 2 on a flag it does not know", async () => {
    const { code, stderr } = await wasit(["init", "--url", "http://127.0.0.1:4402/paid", "--operated-by-me", "--mainnet"], dir);
    assert.equal(code, 2);
    assert.match(stderr, /unknown option '--mainnet'/);
    assert.ok(!existsSync(path.join(dir, "wasit.config.json")));
  });
});
