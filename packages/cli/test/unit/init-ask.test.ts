/**
 * `wasit init` asking (spec C1) and not asking (C5): with a terminal it asks
 * only what the flags left out; without one it asks nothing and names what is
 * missing. In-process; `--no-read` so no route is needed (reading is tested in
 * init-read.test.ts).
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { executeInit, type InitCommandOptions } from "../../src/init-command.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "wasit-init-ask-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function init(flags: Partial<InitCommandOptions>, answers?: Array<string | "EOF">) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const queue = answers === undefined ? undefined : [...answers];
  const code = await executeInit(
    { operatedByMe: false, rejectHeader: [], config: "wasit.config.json", force: false, read: false, ...flags },
    {
      env: {},
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      cwd: dir,
      ...(queue === undefined
        ? {}
        : {
            ask: async (question: string) => {
              asked.push(question);
              const next = queue.shift();
              if (next === undefined || next === "EOF") throw new Error("closed");
              return next;
            },
          }),
    },
  );
  return { code, stdout: out.join("\n"), stderr: err.join("\n"), asked };
}

const file = (): string => path.join(dir, "wasit.config.json");

describe("wasit init: at a terminal", () => {
  it("asks for what the flags leave out, and writes the answers", async () => {
    await writeFile(path.join(dir, "body.json"), '{"q":1}');
    const { code, stdout, asked } = await init({}, ["http://127.0.0.1:3000/api/chat", "yes", "post", "body.json", "npm start", "no"]);
    assert.equal(code, 0, stdout);
    assert.equal(asked.length, 6);
    // The key question comes last, after the read, before anything is written (C1 step 8).
    assert.match(asked[5] ?? "", /Set up a test payer in \.env \(STELLAR_PRIVATE_KEY\)\?/);
    assert.match(stdout, /Test key: not set up \(you said no\)/);
    const config = JSON.parse(await readFile(file(), "utf-8")) as { service: { start: string }; endpoints: Array<Record<string, unknown>> };
    assert.equal(config.service.start, "npm start");
    assert.deepEqual(config.endpoints[0], { name: "chat", protocol: "x402", path: "/api/chat", method: "POST", body: { q: 1 } });
  });

  it("asks nothing the flags already answer", async () => {
    const { code, asked } = await init({ url: "http://127.0.0.1:3000/paid", operatedByMe: true, method: "GET", start: "npm start", setupKeys: false }, []);
    assert.equal(code, 0);
    assert.deepEqual(asked, []);
  });

  it("asks for the environment's name when the route is not on this machine", async () => {
    const { code, asked } = await init({ url: "https://api.example.com/paid", operatedByMe: true, method: "GET", start: "npm start", readyUrl: "http://127.0.0.1:1/", setupKeys: false }, ["staging"]);
    assert.equal(code, 0);
    assert.match(asked[0] ?? "", /Name for this environment/);
  });

  it("a method typed wrong is asked again, and the right one is used", async () => {
    const { code, stdout, asked } = await init({ start: "npm start", setupKeys: false }, ["http://127.0.0.1:3000/api/weather", "yes", "GTE", "get"]);
    assert.equal(code, 0, stdout);
    assert.equal(asked.filter((question) => question.includes("HTTP method of the route")).length, 2);
    assert.ok(asked.some((question) => question.startsWith('"GTE" is not one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS. HTTP method')));
    assert.match(await readFile(file(), "utf-8"), /"method": "GET"|"path": "\/api\/weather"/);
  });

  it("a method wrong three times: exit 2, nothing written, and never a fourth question", async () => {
    const { code, stderr, asked } = await init({ start: "npm start" }, ["http://127.0.0.1:3000/api/weather", "yes", "GTE", "PSOT", "PUSH"]);
    assert.equal(code, 2);
    assert.equal(asked.filter((question) => question.includes("HTTP method of the route")).length, 3);
    assert.match(stderr, /is not one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS\. Nothing was written\./);
    assert.ok(!existsSync(file()));
  });

  it("an empty answer to the method question is GET, and is not asked again", async () => {
    const { code, asked } = await init({ start: "npm start", setupKeys: false }, ["http://127.0.0.1:3000/api/weather", "yes", ""]);
    assert.equal(code, 0);
    assert.equal(asked.filter((question) => question.includes("HTTP method of the route")).length, 1);
  });

  it("a method given as a flag is never asked", async () => {
    const { asked } = await init({ method: "post", start: "npm start", setupKeys: false }, ["http://127.0.0.1:3000/api/weather", "yes", "", ""]);
    assert.ok(!asked.some((question) => question.includes("HTTP method of the route")));
  });

  it("an answer other than yes: the rule, nothing written", async () => {
    const { code, stderr } = await init({ url: "http://127.0.0.1:3000/paid" }, ["no"]);
    assert.equal(code, 2);
    assert.match(stderr, /Wasit tests only services their operator runs/);
    assert.ok(!existsSync(file()));
  });

  it("input that ends while asking: exit 2, nothing written", async () => {
    const { code, stderr } = await init({}, ["EOF"]);
    assert.equal(code, 2);
    assert.match(stderr, /the input ended/);
    assert.ok(!existsSync(file()));
  });

  it("a URL typed as an answer is checked like the flag, and never echoed with credentials", async () => {
    const { code, stderr } = await init({}, ["http://user:hunter2-secret@127.0.0.1:3000/paid", "yes", "", "", ]);
    assert.equal(code, 2);
    assert.match(stderr, /carries credentials/);
    assert.ok(!stderr.includes("hunter2-secret"));
  });
});

describe("wasit init: not at a terminal", () => {
  it("asks nothing and names both missing flags", async () => {
    const { code, stderr, asked } = await init({});
    assert.equal(code, 2);
    assert.deepEqual(asked, []);
    assert.match(stderr, /--url is required .*and so is --operated-by-me/);
    assert.ok(!existsSync(file()));
  });
});
