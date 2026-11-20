/**
 * `startService`: the code behind `wasit run --start` (spec A8 #1, A-A02).
 *
 * Runs real child processes (small Node scripts written to a temporary
 * directory) on 127.0.0.1. The child's environment is the point: the parent's
 * environment here holds made-up keys, and none may reach the child. Process
 * groups are POSIX; the tests that depend on them are skipped on Windows, where
 * `startService` uses `taskkill /T /F` instead and has NOT been run (no Windows
 * machine was available).
 *
 * No key is real, nothing leaves 127.0.0.1.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { ServiceError, startService, type StartedService } from "../../src/service.js";

const POSIX = process.platform !== "win32";

/** A free port: bind 0, read it, close. Nothing else listens there for the length of a test. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

describe("startService", { skip: !POSIX && "needs POSIX process groups; not run on Windows" }, () => {
  let dir: string;
  const started: StartedService[] = [];

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wasit-service-"));
  });
  after(async () => {
    await Promise.all(started.map((service) => service.stop()));
    await rm(dir, { recursive: true, force: true });
  });

  /** A script that serves on `port`, answers `status`, writes its pid, and serves its environment at /env. */
  async function serverScript(name: string, options: { port: number; status?: number; delayMs?: number; ignoreTerm?: boolean }): Promise<string> {
    const file = path.join(dir, `${name}.mjs`);
    await writeFile(
      file,
      `import http from "node:http";
import { writeFileSync } from "node:fs";
${options.ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
writeFileSync(${JSON.stringify(path.join(dir, `${name}.pid`))}, String(process.pid));
setTimeout(() => {
  http.createServer((req, res) => {
    if (req.url === "/env") { res.writeHead(200); res.end(JSON.stringify(process.env)); return; }
    res.writeHead(${options.status ?? 200}); res.end("hello");
  }).listen(${options.port}, "127.0.0.1");
}, ${options.delayMs ?? 0});
`,
    );
    return file;
  }

  const logs = (): { lines: string[]; log: (line: string) => void } => {
    const lines: string[] = [];
    return { lines, log: (line) => lines.push(line) };
  };

  it("starts the command, waits for the first answer, and stops it", async () => {
    const port = await freePort();
    const script = await serverScript("basic", { port, delayMs: 400 });
    const { log } = logs();
    const before = Date.now();
    const service = await startService({
      command: `node ${JSON.stringify(script)}`,
      ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 10 },
      env: process.env,
      log,
    });
    started.push(service);
    assert.ok(Date.now() - before >= 300, "it waited for the service");
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    const pid = Number(await readFile(path.join(dir, "basic.pid"), "utf-8"));
    assert.ok(alive(pid));
    await service.stop();
    assert.equal(await waitUntil(() => !alive(pid), 3000), true, "the service is gone");
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
  });

  it("counts any HTTP answer as ready, a 500 and a 404 included", async () => {
    for (const status of [500, 404]) {
      const port = await freePort();
      const script = await serverScript(`status-${status}`, { port, status });
      const service = await startService({
        command: `node ${JSON.stringify(script)}`,
        ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 10 },
        env: process.env,
        log: () => {},
      });
      started.push(service);
      await service.stop();
    }
  });

  it("never gives the service a key, a header value or the RPC url: a made-up one of each in the parent", async () => {
    const port = await freePort();
    const script = await serverScript("env", { port });
    const parent: Record<string, string> = {
      PATH: process.env["PATH"] ?? "",
      HOME: dir,
      KEEP_ME: "kept",
      STELLAR_PAYEE_ADDRESS: "GPUBLICADDRESS",
      STELLAR_PRIVATE_KEY: "canary-stellar-key",
      EVM_PRIVATE_KEY: "canary-evm-key",
      SVM_PRIVATE_KEY: "canary-svm-key",
      MPP_PAYER_SECRET: "canary-mpp-payer",
      COMMITMENT_SECRET_HEX: "canary-commitment",
      WASIT_MAINNET_PAYER_SECRET: "canary-mainnet-payer",
      WASIT_HEADER_X_API_KEY: "canary-header",
      WASIT_HEADER_AUTHORIZATION: "canary-authorization",
      WASIT_RPC_URL: "https://rpc.example/canary-rpc-key",
      WASIT_SOMETHING_NEW: "canary-new",
      stellar_private_key: "canary-lowercase",
    };
    const service = await startService({
      command: `node ${JSON.stringify(script)}`,
      ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 10 },
      env: parent,
      log: () => {},
    });
    started.push(service);
    const text = await (await fetch(`http://127.0.0.1:${port}/env`)).text();
    const seen = JSON.parse(text) as Record<string, string>;
    assert.equal(seen["KEEP_ME"], "kept", "the service still gets what it needs");
    assert.equal(seen["STELLAR_PAYEE_ADDRESS"], "GPUBLICADDRESS", "a payee address is not a key");
    for (const [name, value] of Object.entries(parent)) {
      if (!name.toUpperCase().startsWith("WASIT_") && !/PRIVATE_KEY|SECRET/.test(name.toUpperCase())) continue;
      assert.equal(seen[name], undefined, `${name} reached the service`);
      assert.ok(!text.includes(value), `the value of ${name} reached the service`);
    }
    await service.stop();
  });

  it("fails with a ServiceError, and leaves no process, when nothing answers in time", async () => {
    const pidFile = path.join(dir, "silent.pid");
    const script = path.join(dir, "silent.mjs");
    await writeFile(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const port = await freePort();
    const before = Date.now();
    await assert.rejects(
      startService({
        command: `node ${JSON.stringify(script)}`,
        ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 1 },
        env: process.env,
        log: () => {},
      }),
      (error: unknown) => error instanceof ServiceError && /no answer/i.test(error.message) && /1 second/.test(error.message),
    );
    assert.ok(Date.now() - before < 8000);
    const pid = Number(await readFile(pidFile, "utf-8"));
    assert.equal(await waitUntil(() => !alive(pid), 3000), true, "the silent service was stopped");
  });

  it("fails at once, with the exit code, when the service exits before it answers", async () => {
    const port = await freePort();
    const before = Date.now();
    await assert.rejects(
      startService({
        command: `node -e "process.stderr.write('boom\\n'); process.exit(3)"`,
        ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 30 },
        env: process.env,
        log: () => {},
      }),
      (error: unknown) => error instanceof ServiceError && /exited/.test(error.message) && /3/.test(error.message),
    );
    assert.ok(Date.now() - before < 5000, "it did not wait for the whole timeout");
  });

  it("stops a process the shell left in the background, not only the shell", async () => {
    const port = await freePort();
    const script = await serverScript("background", { port });
    const service = await startService({
      command: `node ${JSON.stringify(script)} & wait`,
      ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 10 },
      env: process.env,
      log: () => {},
    });
    started.push(service);
    const pid = Number(await readFile(path.join(dir, "background.pid"), "utf-8"));
    assert.ok(alive(pid));
    await service.stop();
    assert.equal(await waitUntil(() => !alive(pid), 3000), true, "the backgrounded service is gone");
  });

  it("kills a service that ignores SIGTERM, after the grace period", async () => {
    const port = await freePort();
    const script = await serverScript("stubborn", { port, ignoreTerm: true });
    const service = await startService({
      command: `node ${JSON.stringify(script)}`,
      ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 10 },
      env: process.env,
      log: () => {},
      stopGraceMs: 300,
    });
    started.push(service);
    const pid = Number(await readFile(path.join(dir, "stubborn.pid"), "utf-8"));
    await service.stop();
    assert.equal(await waitUntil(() => !alive(pid), 3000), true, "the stubborn service is gone");
  });

  it("can be stopped twice, and puts the signal handlers back", async () => {
    const before = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal));
    const port = await freePort();
    const script = await serverScript("twice", { port });
    const service = await startService({
      command: `node ${JSON.stringify(script)}`,
      ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 10 },
      env: process.env,
      log: () => {},
    });
    assert.ok(process.listenerCount("SIGTERM") > before[1]!, "it listens for signals while the service runs");
    await service.stop();
    await service.stop();
    assert.deepEqual(["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => process.listenerCount(signal)), before);
  });

  it("refuses a ready url that is not on this machine, before it starts anything", async () => {
    const marker = path.join(dir, "should-not-exist");
    await assert.rejects(
      startService({
        command: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"`,
        ready: { url: "http://example.com/", timeoutSeconds: 5 },
        env: process.env,
        log: () => {},
      }),
      (error: unknown) => error instanceof ServiceError && /this machine/.test(error.message),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(existsSync(marker), false);
  });

  it("passes the service's output on with a prefix, through the sanitiser: no escape character, no line that starts ::", async () => {
    const port = await freePort();
    const script = path.join(dir, "chatty.mjs");
    await writeFile(
      script,
      `import http from "node:http";
console.log("hello \\u001b[2J there");
console.log("::set-output name=pwn::1");
console.error("##[warning]careless STELLAR_KEY=S${"A".repeat(55)}");
http.createServer((q, r) => { r.writeHead(200); r.end("x"); }).listen(${port}, "127.0.0.1");
`,
    );
    const { lines, log } = logs();
    const service = await startService({
      command: `node ${JSON.stringify(script)}`,
      ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 10 },
      env: process.env,
      log,
    });
    started.push(service);
    await waitUntil(() => lines.length >= 3, 2000);
    await service.stop();
    const text = lines.join("\n");
    assert.ok(lines.length >= 3);
    for (const line of lines) assert.ok(line.startsWith("[service] "), line);
    assert.ok(!text.includes("\u001b"));
    assert.ok(!text.includes("A".repeat(55)));
    for (const line of lines) assert.ok(!/^(::|##\[)/.test(line));
    assert.match(text, /hello \[2J there/);
  });

  it("stops printing a service's output after the cap, and the service keeps running", async () => {
    const port = await freePort();
    const script = path.join(dir, "flood.mjs");
    await writeFile(
      script,
      `import http from "node:http";
for (let i = 0; i < 400; i += 1) console.log("line " + i + " " + "x".repeat(40));
http.createServer((q, r) => { r.writeHead(200); r.end("x"); }).listen(${port}, "127.0.0.1");
`,
    );
    const { lines, log } = logs();
    const service = await startService({
      command: `node ${JSON.stringify(script)}`,
      ready: { url: `http://127.0.0.1:${port}/`, timeoutSeconds: 10 },
      env: process.env,
      log,
      maxLogBytes: 2000,
    });
    started.push(service);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(lines.length < 100, `printed ${lines.length} lines`);
    assert.ok(lines.some((line) => /output cut/.test(line)));
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200, "the service was not blocked");
    await service.stop();
  });
});
