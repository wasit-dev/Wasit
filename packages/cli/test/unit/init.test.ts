/**
 * `wasit init --no-read`: the flags only (spec C; W3-2 slice 2;
 * init-skeleton-plan.md section 6, Najmi's fallback table of 2026-11-15).
 * In-process, in a temporary directory. Without reading the route, init sends
 * no request: every test here runs with a `fetch` that fails the test when
 * called. Reading the route (slice 3) is in init-read.test.ts.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { readConfigFile, resolveRun } from "@wasit-dev/core";

import { executeInit, type InitCommandOptions } from "../../src/init-command.js";

/** The example project's config, `dzakwannajmi/x402-example-paywall` `wasit.config.json` at `a77a8b3` (read 2026-11-24). */
const EXAMPLE = {
  version: 1,
  service: { start: "npm start", ready: { url: "http://127.0.0.1:4402/paid", timeoutSeconds: 30 } },
  defaultEnvironment: "local",
  environments: { local: { baseUrl: "http://127.0.0.1:4402", network: "stellar:testnet", operatedByMe: true } },
  endpoints: [
    {
      name: "quote-of-the-day",
      protocol: "x402",
      path: "/paid",
      method: "GET",
      reject: { headers: { "x-quote-lang": "xx" }, note: "a language the quote does not exist in must be refused" },
    },
  ],
};

/** The flags that give the example project's config. */
const EXAMPLE_FLAGS: Partial<InitCommandOptions> = {
  url: "http://127.0.0.1:4402/paid",
  name: "quote-of-the-day",
  start: "npm start",
  readyTimeout: "30",
  rejectHeader: ["x-quote-lang: xx"],
  rejectNote: "a language the quote does not exist in must be refused",
};

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

let dir: string;
let realFetch: typeof fetch;
let requests: number;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "wasit-init-"));
  realFetch = globalThis.fetch;
  requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    throw new Error("init without reading the route must not send a request");
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  assert.equal(requests, 0, "a request was sent");
  await rm(dir, { recursive: true, force: true });
});

async function init(flags: Partial<InitCommandOptions>, env: Record<string, string> = {}): Promise<Outcome> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await executeInit(
    { operatedByMe: true, rejectHeader: [], config: "wasit.config.json", force: false, read: false, ...flags },
    { env, stdout: (line) => out.push(line), stderr: (line) => err.push(line), cwd: dir },
  );
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

const configFile = (): string => path.join(dir, "wasit.config.json");
const written = async (): Promise<unknown> => JSON.parse(await readFile(configFile(), "utf-8"));

describe("wasit init: a new config from flags", () => {
  it("writes the example project's config from the same answers, and says what it filled in and did not read", async () => {
    const { code, stdout, stderr } = await init(EXAMPLE_FLAGS);
    assert.equal(code, 0, stderr);
    assert.deepEqual(await written(), EXAMPLE);
    assert.match(stdout, /^wasit init: wrote wasit\.config\.json: the environment local and the endpoint quote-of-the-day\./);
    // Najmi's words for the network that was not given (2026-11-15).
    assert.ok(stdout.includes("  network: stellar:testnet (default; init does not read the network from your service)"));
    assert.ok(stdout.includes("  method: GET"));
    assert.ok(stdout.includes("  environment: local (the URL is on this machine)"));
    assert.ok(stdout.includes("  ready url: http://127.0.0.1:4402/paid (the route's own URL)"));
    assert.ok(stdout.includes("You gave:\n  url: http://127.0.0.1:4402/paid\n  operated by you: yes (--operated-by-me)"));
    assert.match(stdout, /Not read from your service:\n {2}whether the route answers 402/);
    assert.match(stdout, /\nNext: wasit run --read-only$/);
  });

  it("writes a file wasit run reads back to the same URL", async () => {
    const { code } = await init({ url: "http://localhost:3000/api/weather?city=jakarta" });
    assert.equal(code, 0);
    const run = resolveRun(readConfigFile(configFile()), {}, {});
    assert.equal(run.endpoints[0]?.url, "http://localhost:3000/api/weather?city=jakarta");
    assert.equal(run.endpoints[0]?.name, "weather");
    assert.equal(run.baseUrl, "http://localhost:3000");
    assert.equal(run.operatedByMe, true);
  });

  it("writes a body from a JSON file as a JSON value, for the method given", async () => {
    await writeFile(path.join(dir, "body.json"), '﻿{ "prompt": "hello" }\n');
    const { code, stdout } = await init({ url: "http://127.0.0.1:3000/api/chat", method: "post", bodyFile: "body.json" });
    assert.equal(code, 0);
    const config = (await written()) as { endpoints: Array<Record<string, unknown>> };
    assert.deepEqual(config.endpoints[0], { name: "chat", protocol: "x402", path: "/api/chat", method: "POST", body: { prompt: "hello" } });
    assert.ok(stdout.includes("  method: POST"));
  });

  it("takes a deployed route with --env, and names the environment in the next command only when it is not the default", async () => {
    const { code, stdout } = await init({ url: "https://api.example.com/v1/paid", env: "staging" });
    assert.equal(code, 0);
    const config = (await written()) as { environments: Record<string, { baseUrl: string }> };
    assert.equal(config.environments["staging"]?.baseUrl, "https://api.example.com");
    assert.match(stdout, /\nNext: wasit run --read-only$/);
  });

  it("names a config file that is not the default in the next command, quoted when it has a space", async () => {
    const { code, stdout } = await init({ url: "http://127.0.0.1:3000/paid", config: "my config.json" });
    assert.equal(code, 0);
    assert.ok(existsSync(path.join(dir, "my config.json")));
    assert.match(stdout, /\nNext: wasit run --read-only --config "my config\.json"$/);
  });
});

describe("wasit init: what it refuses (exit 2, nothing written)", () => {
  async function refused(flags: Partial<InitCommandOptions>, message: RegExp): Promise<string> {
    const { code, stdout, stderr } = await init(flags);
    assert.equal(code, 2, stdout);
    assert.equal(stdout, "");
    assert.match(stderr, message);
    assert.match(stderr, /^wasit init: /);
    assert.ok(!existsSync(configFile()), "a config was written");
    return stderr;
  }

  it("no --url: it guesses nothing", async () => {
    await refused({}, /--url is required/);
  });

  it("no --operated-by-me: it explains the rule, sends nothing and writes nothing", async () => {
    const stderr = await refused(
      { url: "http://127.0.0.1:3000/paid", operatedByMe: false },
      /Wasit tests only services their operator runs/,
    );
    assert.match(stderr, /--operated-by-me\. Nothing was sent and nothing was written\./);
  });

  it("a mainnet network, with the list of test networks it writes", async () => {
    const stderr = await refused({ url: "http://127.0.0.1:3000/paid", network: "stellar:pubnet" }, /Stellar mainnet/);
    assert.match(stderr, /stellar:testnet, eip155:84532, eip155:11155111, solana:/);
  });

  it("a network Wasit does not know", async () => {
    await refused({ url: "http://127.0.0.1:3000/paid", network: "stellar:futurenet" }, /not on Wasit's list of test networks/);
  });

  it("a URL with credentials, without echoing them", async () => {
    const stderr = await refused({ url: "http://user:hunter2-secret@127.0.0.1:3000/paid" }, /carries credentials/);
    assert.ok(!stderr.includes("hunter2-secret"));
  });

  it("a URL that is not http(s), or not a URL", async () => {
    await refused({ url: "ftp://127.0.0.1/paid" }, /must be an http or https URL/);
    await refused({ url: "127.0.0.1:3000/paid" }, /must be an http or https URL|not an absolute URL/);
    await refused({ url: "/paid" }, /not an absolute URL/);
  });

  it("a fragment", async () => {
    await refused({ url: "http://127.0.0.1:3000/paid#x" }, /fragment/);
  });

  it("a path it cannot take a name from, without --name", async () => {
    await refused({ url: "http://127.0.0.1:3000/" }, /give one with --name/);
    await refused({ url: "http://127.0.0.1:3000/%E2%82%AC" }, /give one with --name/);
  });

  it("a bad --name or --env", async () => {
    await refused({ url: "http://127.0.0.1:3000/paid", name: "-paid" }, /--name must be/);
    await refused({ url: "http://127.0.0.1:3000/paid", env: "my env" }, /--env must be/);
  });

  it("a route not on this machine, without --env", async () => {
    await refused({ url: "https://api.example.com/paid" }, /name its environment with --env/);
  });

  it("a method that is not HTTP, or a body on GET", async () => {
    await refused({ url: "http://127.0.0.1:3000/paid", method: "FETCH" }, /--method "FETCH" is not one of/);
    await writeFile(path.join(dir, "body.json"), "{}");
    await refused({ url: "http://127.0.0.1:3000/paid", bodyFile: "body.json" }, /cannot be sent with GET/);
  });

  it("a body file that is missing or not JSON", async () => {
    await refused({ url: "http://127.0.0.1:3000/paid", method: "POST", bodyFile: "absent.json" }, /cannot read "absent\.json" \(ENOENT\)/);
    await writeFile(path.join(dir, "body.txt"), "prompt=hello");
    await refused({ url: "http://127.0.0.1:3000/paid", method: "POST", bodyFile: "body.txt" }, /is not JSON/);
  });

  it("the readiness flags without --start, and --start for a deployed route without --ready-url", async () => {
    await refused({ url: "http://127.0.0.1:3000/paid", readyUrl: "http://127.0.0.1:3000/health" }, /give the command that starts it/);
    await refused({ url: "http://127.0.0.1:3000/paid", readyTimeout: "30" }, /give the command that starts it/);
    await refused({ url: "https://api.example.com/paid", env: "staging", start: "npm start" }, /--start needs --ready-url/);
    await refused({ url: "http://127.0.0.1:3000/paid", start: "npm start", readyTimeout: "0" }, /--ready-timeout must be/);
    await refused({ url: "http://127.0.0.1:3000/paid", start: "npm start", readyTimeout: "1.5" }, /--ready-timeout must be/);
  });

  it("a ready URL that is not on this machine (the writer's validator)", async () => {
    await refused(
      { url: "http://127.0.0.1:3000/paid", start: "npm start", readyUrl: "https://api.example.com/health" },
      /service\.ready\.url: must be an address on this machine/,
    );
  });

  it("a reject note without a request to refuse, and a reject header that is not Name: value", async () => {
    await refused({ url: "http://127.0.0.1:3000/paid", rejectNote: "why" }, /--reject-note describes/);
    await refused({ url: "http://127.0.0.1:3000/paid", rejectHeader: ["no-colon"] }, /is not "Name: value"/);
  });

  it("a reject header with a credential-like name (the writer's validator)", async () => {
    await refused({ url: "http://127.0.0.1:3000/paid", rejectHeader: ["Authorization: Bearer x"] }, /reject\.headers/);
  });
});

describe("wasit init: an existing config", () => {
  const first = { url: "http://127.0.0.1:4402/paid", name: "quote-of-the-day" };

  it("adds the endpoint to it, in the same environment", async () => {
    assert.equal((await init(first)).code, 0);
    const { code, stdout } = await init({ url: "http://127.0.0.1:4402/weather" });
    assert.equal(code, 0);
    assert.match(stdout, /^wasit init: added the endpoint weather to wasit\.config\.json, in the environment local\./);
    // The environment exists: its network is the one it is on, not a default.
    assert.ok(stdout.includes("  network: stellar:testnet (the environment local in the config is on it)"));
    const config = (await written()) as { endpoints: Array<{ name: string; path: string }> };
    assert.deepEqual(
      config.endpoints.map((endpoint) => [endpoint.name, endpoint.path]),
      [
        ["quote-of-the-day", "/paid"],
        ["weather", "/weather"],
      ],
    );
  });

  it("refuses an endpoint name it already has, and leaves the file as it was", async () => {
    assert.equal((await init(first)).code, 0);
    const before = await readFile(configFile(), "utf-8");
    const { code, stderr } = await init({ ...first, url: "http://127.0.0.1:4402/other" });
    assert.equal(code, 2);
    assert.match(stderr, /already has an endpoint named "quote-of-the-day"/);
    assert.equal(await readFile(configFile(), "utf-8"), before);
  });

  it("the same route again, as given: exit 0, and the file is left as it is", async () => {
    assert.equal((await init(EXAMPLE_FLAGS)).code, 0);
    const before = await readFile(configFile(), "utf-8");
    const { code, stdout, stderr } = await init(EXAMPLE_FLAGS);
    assert.equal(code, 0, stderr);
    assert.match(
      stdout,
      /^wasit init: wasit\.config\.json already has the endpoint quote-of-the-day as given, in the environment local: the file was left as it is\./,
    );
    assert.equal(await readFile(configFile(), "utf-8"), before);
    assert.match(stdout, /\nNext: wasit run --read-only$/);
  });

  it("a file in the builder's own layout that holds the route: not rewritten, byte for byte", async () => {
    // Another key order, one line, and the method left to its default: the same route as the loader reads it.
    const own =
      '{"endpoints":[{"path":"/paid","name":"quote-of-the-day","protocol":"x402"}],' +
      '"environments":{"local":{"operatedByMe":true,"baseUrl":"http://127.0.0.1:4402"}},"version":1}';
    await writeFile(configFile(), own);
    const { code, stdout, stderr } = await init({ url: "http://127.0.0.1:4402/paid", name: "quote-of-the-day" });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /already has the endpoint quote-of-the-day as given/);
    assert.equal(await readFile(configFile(), "utf-8"), own);
  });

  it("the same name with another request to refuse: refused, and the file is left as it was", async () => {
    assert.equal((await init(EXAMPLE_FLAGS)).code, 0);
    const before = await readFile(configFile(), "utf-8");
    const { code, stderr } = await init({ ...EXAMPLE_FLAGS, rejectHeader: ["x-quote-lang: zz"] });
    assert.equal(code, 2);
    assert.match(stderr, /already has an endpoint named "quote-of-the-day" whose reject differs/);
    assert.equal(await readFile(configFile(), "utf-8"), before);
  });

  it("replaces it with --force", async () => {
    assert.equal((await init(first)).code, 0);
    const { code, stdout } = await init({ ...first, url: "http://127.0.0.1:5000/paid", force: true });
    assert.equal(code, 0);
    assert.match(stdout, /^wasit init: replaced wasit\.config\.json \(--force\)/);
    const config = (await written()) as { environments: Record<string, { baseUrl: string }>; endpoints: unknown[] };
    assert.equal(config.environments["local"]?.baseUrl, "http://127.0.0.1:5000");
    assert.equal(config.endpoints.length, 1);
  });

  it("refuses a route of another service in the same environment", async () => {
    assert.equal((await init(first)).code, 0);
    const { code, stderr } = await init({ url: "http://127.0.0.1:5000/weather" });
    assert.equal(code, 2);
    assert.match(stderr, /environment "local" with the base URL "http:\/\/127\.0\.0\.1:4402", and this route is not under it/);
  });

  it("refuses another network in the same environment", async () => {
    assert.equal((await init(first)).code, 0);
    const { code, stderr } = await init({ url: "http://127.0.0.1:4402/weather", network: "eip155:84532" });
    assert.equal(code, 2);
    assert.match(stderr, /on "stellar:testnet", and this route is written on "eip155:84532"/);
  });

  it("adds a route under an environment's base path, and keeps the file's own base URL text", async () => {
    await writeFile(
      configFile(),
      JSON.stringify({
        version: 1,
        environments: { local: { baseUrl: "http://127.0.0.1:4402/api/", network: "eip155:84532", operatedByMe: true, maxRunUsd: 2 } },
        endpoints: [{ name: "a", protocol: "x402", path: "/a" }],
      }),
    );
    const { code, stdout, stderr } = await init({ url: "http://127.0.0.1:4402/api/b" });
    assert.equal(code, 0, stderr);
    assert.ok(stdout.includes("  network: eip155:84532 (the environment local in the config is on it)"));
    const config = (await written()) as { environments: Record<string, Record<string, unknown>>; endpoints: Array<Record<string, unknown>> };
    assert.deepEqual(config.environments["local"], {
      baseUrl: "http://127.0.0.1:4402/api/",
      network: "eip155:84532",
      operatedByMe: true,
      maxRunUsd: 2,
    });
    assert.deepEqual(config.endpoints[1], { name: "b", protocol: "x402", path: "/b", method: "GET" });
    assert.equal(resolveRun(readConfigFile(configFile()), {}, {}).endpoints[1]?.url, "http://127.0.0.1:4402/api/b");
  });

  it("refuses an environment without operatedByMe true, and changes nothing in it", async () => {
    await writeFile(
      configFile(),
      JSON.stringify({
        version: 1,
        environments: { local: { baseUrl: "http://127.0.0.1:4402" } },
        endpoints: [{ name: "a", protocol: "x402", path: "/a" }],
      }),
    );
    const { code, stderr } = await init({ url: "http://127.0.0.1:4402/b" });
    assert.equal(code, 2);
    assert.match(stderr, /without operatedByMe true, and init does not change it/);
  });

  it("names the environment in the next command when the file runs another one by default", async () => {
    assert.equal((await init(first)).code, 0);
    const { code, stdout } = await init({ url: "https://api.example.com/paid", env: "staging" });
    assert.equal(code, 0);
    assert.match(stdout, /added the endpoint paid to wasit\.config\.json, with the new environment staging\./);
    assert.match(stdout, /\nNext: wasit run --read-only --env staging$/);
  });

  it("leaves a config that is not valid as it is", async () => {
    await writeFile(configFile(), "{ not json");
    const { code, stderr } = await init({ url: "http://127.0.0.1:4402/b" });
    assert.equal(code, 2);
    assert.match(stderr, /The config already there is not valid, so init does not change it/);
    assert.equal(await readFile(configFile(), "utf-8"), "{ not json");
  });
});

describe("wasit init: output", () => {
  it("never prints a value of a denied variable, even in a file name it echoes", async () => {
    const secret = "canary-header-value-0123456789";
    await writeFile(path.join(dir, `body-${secret}.json`), "{}");
    const { code, stdout } = await init(
      { url: "http://127.0.0.1:3000/chat", method: "POST", bodyFile: `body-${secret}.json` },
      { WASIT_HEADER_X_API: secret },
    );
    assert.equal(code, 0);
    assert.ok(stdout.includes("  body: from body-"), stdout);
    assert.ok(!stdout.includes(secret));
  });

  it("never writes a value of a denied variable into the config, and does not print it", async () => {
    const secret = "canary-header-value-0123456789";
    const hex = "cd".repeat(32);
    for (const flags of [
      { start: `npm start -- --token ${secret}` },
      { rejectHeader: [`x-probe: ${secret}`] },
      { rejectHeader: [`x-probe: ${hex}`] },
    ]) {
      const { code, stdout, stderr } = await init(
        { url: "http://127.0.0.1:3000/paid", ...flags },
        { WASIT_HEADER_X_API: secret, COMMITMENT_SECRET_HEX: hex },
      );
      assert.equal(code, 2, JSON.stringify(flags));
      assert.match(stderr, /would write the value of a variable Wasit keeps secret/);
      assert.ok(!stdout.includes(secret) && !stderr.includes(secret) && !stderr.includes(hex));
      assert.ok(!existsSync(configFile()));
    }
  });

  it("adds to a file that already holds such a value, which it did not write", async () => {
    const secret = "canary-header-value-0123456789";
    assert.equal((await init({ url: "http://127.0.0.1:3000/a", rejectHeader: [`x-probe: ${secret}`] })).code, 0);
    const { code, stderr } = await init({ url: "http://127.0.0.1:3000/b" }, { WASIT_HEADER_X_API: secret });
    assert.equal(code, 0, stderr);
  });

  it("strips control characters and breaks a workflow command in a file name it echoes", { skip: process.platform === "win32" }, async () => {
    const name = "body\u001b[2J\n::error::x.json";
    await writeFile(path.join(dir, name), "{}");
    const { code, stdout, stderr } = await init({ url: "http://127.0.0.1:3000/chat", method: "POST", bodyFile: name });
    assert.equal(code, 0, stderr);
    assert.ok(!stdout.includes("\u001b"));
    assert.ok(!/^\s*::/m.test(stdout), stdout);
    assert.ok(stdout.includes("\n: :error::x.json"), stdout);
  });
});
