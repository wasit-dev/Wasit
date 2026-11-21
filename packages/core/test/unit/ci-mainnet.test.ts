/**
 * The rules for a mainnet job in GitHub Actions (spec B17.4), written before
 * the code (B11). Inside one job, code that ran earlier as the runner's user
 * owns every later step, so these rules do not try to detect such code: they
 * refuse the workflows in which it would be there. A mainnet run is started by
 * hand, on the default branch, on a GitHub-hosted runner; it tests a deployed
 * service (no `service.start`, no local `baseUrl`), in a job where nothing was
 * installed before Wasit, with the mainnet key as the only key variable.
 * Outside GitHub Actions (a builder's own machine) none of them applies.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import { ConfigurationError } from "../../src/errors.js";
import {
  MainnetJobRefusedError,
  assertMainnetJob,
  isLocalHost,
  mainnetJobRefusals,
  type MainnetJob,
} from "../../src/guard/ci-mainnet.js";

const HOSTED_DISPATCH = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  RUNNER_ENVIRONMENT: "github-hosted",
  WASIT_MAINNET_PAYER_SECRET: "set",
};

function job(overrides: Partial<MainnetJob> = {}, env: Record<string, string | undefined> = {}): MainnetJob {
  return {
    env: { ...HOSTED_DISPATCH, ...env },
    defaultBranch: "main",
    startsService: false,
    baseUrl: "https://api.example.com",
    installDirs: [],
    ...overrides,
  };
}

const none = () => false;

describe("a mainnet job in GitHub Actions", () => {
  it("passes the job of the mainnet example: by hand, default branch, hosted, a deployed service, nothing installed", () => {
    assert.deepEqual(mainnetJobRefusals(job(), none), []);
    assertMainnetJob(job(), none);
  });

  it("applies none of the rules outside GitHub Actions: the CLI on a builder's machine may test a local service", () => {
    const local = job(
      { startsService: true, baseUrl: "http://127.0.0.1:3000", defaultBranch: undefined },
      { GITHUB_ACTIONS: undefined, GITHUB_EVENT_NAME: undefined, RUNNER_ENVIRONMENT: undefined, GITHUB_REF: undefined },
    );
    assert.deepEqual(mainnetJobRefusals(local, () => true), []);
  });

  const rules: ReadonlyArray<[string, MainnetJob, RegExp]> = [
    ["a push", job({}, { GITHUB_EVENT_NAME: "push" }), /started by hand \(workflow_dispatch\), and this run's event is push/],
    ["a schedule", job({}, { GITHUB_EVENT_NAME: "schedule" }), /this run's event is schedule/],
    ["a self-hosted runner", job({}, { RUNNER_ENVIRONMENT: "self-hosted" }), /GitHub-hosted runner/],
    ["no runner environment", job({}, { RUNNER_ENVIRONMENT: undefined }), /GitHub-hosted runner/],
    ["another branch", job({}, { GITHUB_REF: "refs/heads/feature" }), /default branch \(main\), and this run's ref is refs\/heads\/feature/],
    ["a tag", job({}, { GITHUB_REF: "refs/tags/v1" }), /default branch/],
    ["an unknown default branch", job({ defaultBranch: undefined }), /default branch could not be read/],
    ["a service started in the job", job({ startsService: true }), /service\.start/],
    ["a loopback baseUrl", job({ baseUrl: "http://127.0.0.1:3000" }), /baseUrl is a local address/],
    ["a private baseUrl", job({ baseUrl: "https://10.1.2.3" }), /baseUrl is a local address/],
    ["another key variable set", job({}, { STELLAR_PRIVATE_KEY: "x" }), /only WASIT_MAINNET_PAYER_SECRET .* STELLAR_PRIVATE_KEY is set too/],
  ];
  for (const [name, value, pattern] of rules) {
    it(`refuses ${name}, alone`, () => {
      const refusals = mainnetJobRefusals(value, none);
      assert.equal(refusals.length, 1, refusals.join(" | "));
      assert.match(refusals[0]!, pattern);
    });
  }

  it("refuses a node_modules in the workspace or the config's directory: code was installed before Wasit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wasit-ci-mainnet-"));
    try {
      const workspace = path.join(dir, "ws");
      const configDir = path.join(dir, "cfg");
      mkdirSync(workspace);
      mkdirSync(configDir);
      const value = job({ installDirs: [{ label: "the workspace", dir: workspace }, { label: "the config's directory", dir: configDir }] });
      assert.deepEqual(mainnetJobRefusals(value), []);
      mkdirSync(path.join(configDir, "node_modules"));
      const refusals = mainnetJobRefusals(value);
      assert.equal(refusals.length, 1);
      assert.match(refusals[0]!, /node_modules directory is in the config's directory/);
      assert.ok(!refusals[0]!.includes(dir), "a path was echoed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists every rule a job breaks, in one refusal that says what holds instead", () => {
    const value = job(
      { startsService: true, baseUrl: "http://localhost:3000" },
      { GITHUB_EVENT_NAME: "push", RUNNER_ENVIRONMENT: "self-hosted", GITHUB_REF: "refs/heads/dev", EVM_PRIVATE_KEY: "x" },
    );
    assert.equal(mainnetJobRefusals(value, none).length, 6);
    assert.throws(
      () => assertMainnetJob(value, none),
      (error: unknown) => {
        assert.ok(error instanceof MainnetJobRefusedError);
        assert.ok(error instanceof ConfigurationError, "a configuration error: exit 2");
        assert.equal(error.refusals.length, 6);
        assert.match(error.message, /^This job may not make a mainnet run: /);
        assert.match(error.message, /Nothing was started, sent or signed\./);
        assert.match(error.message, /GitHub environment/);
        return true;
      },
    );
  });

  it("never echoes a key, an odd event name or an odd ref", () => {
    const secret = Keypair.random().secret();
    const value = job({}, { STELLAR_PRIVATE_KEY: secret, MPP_PAYER_SECRET: secret, GITHUB_EVENT_NAME: "push; id", GITHUB_REF: "refs/heads/$(id)" });
    const text = mainnetJobRefusals(value, none).join(" ");
    assert.ok(!text.includes(secret), "a key was echoed");
    assert.ok(!text.includes("push; id") && !text.includes("$(id)"), text);
    assert.match(text, /STELLAR_PRIVATE_KEY and MPP_PAYER_SECRET are set too/);
    assert.match(text, /another event/);
    assert.match(text, /another ref/);
  });
});

describe("isLocalHost", () => {
  const local = [
    "localhost", "api.localhost", "127.0.0.1", "127.9.9.9", "0.0.0.0", "10.0.0.1", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "100.64.0.1", "[::1]", "[::]", "[fd00::1]", "[fc00::1]", "[fe80::1]",
    "[::ffff:7f00:1]", "service", "printer.local", "db.internal",
  ];
  const remote = ["api.example.com", "172.15.0.1", "172.32.0.1", "8.8.8.8", "100.128.0.1", "[2606:4700::1111]"];
  for (const host of local) it(`${host} is local`, () => assert.equal(isLocalHost(host), true));
  for (const host of remote) it(`${host} is not`, () => assert.equal(isLocalHost(host), false));

  it("reads hosts as the URL parser writes them: a decimal IPv4 and a mapped IPv6 are loopback", () => {
    assert.equal(isLocalHost(new URL("http://2130706433/").hostname), true);
    assert.equal(isLocalHost(new URL("http://[::ffff:127.0.0.1]/").hostname), true);
  });
});
