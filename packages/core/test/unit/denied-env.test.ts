/**
 * The variable names that carry a key or a header value, and what is done with
 * them: removed from the environment of a service Wasit starts (spec A8 #1), and
 * their values kept out of every output (A-A07). The values below are made up;
 * none is a key.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DENIED_ENV_NAMES, deniedEnvValues, isDeniedEnvName, scrubEnv } from "../../src/denied-env.js";

const FIXED = [
  "STELLAR_PRIVATE_KEY",
  "EVM_PRIVATE_KEY",
  "SVM_PRIVATE_KEY",
  "MPP_PAYER_SECRET",
  "COMMITMENT_SECRET_HEX",
  "WASIT_MAINNET_PAYER_SECRET",
];

describe("isDeniedEnvName", () => {
  it("knows the six fixed names", () => {
    assert.deepEqual([...DENIED_ENV_NAMES].sort(), [...FIXED].sort());
    for (const name of FIXED) assert.equal(isDeniedEnvName(name), true, name);
  });

  it("does not care about case: a Windows environment is case-insensitive", () => {
    for (const name of FIXED) assert.equal(isDeniedEnvName(name.toLowerCase()), true, name.toLowerCase());
    assert.equal(isDeniedEnvName("Stellar_Private_Key"), true);
  });

  it("takes the whole WASIT_ namespace: header values, the RPC url and anything added later", () => {
    for (const name of ["WASIT_HEADER_X_API_KEY", "WASIT_HEADER_AUTHORIZATION", "WASIT_RPC_URL", "WASIT_SOMETHING_NEW", "wasit_rpc_url"]) {
      assert.equal(isDeniedEnvName(name), true, name);
    }
  });

  it("leaves the variables a service needs alone, payee addresses included", () => {
    for (const name of ["PATH", "HOME", "NODE_OPTIONS", "PORT", "STELLAR_PAYEE_ADDRESS", "EVM_PAYEE_ADDRESS", "MPP_STELLAR_NETWORK", "CHANNEL_CONTRACT", "WASIT"]) {
      assert.equal(isDeniedEnvName(name), false, name);
    }
  });
});

// The runner gives every step files it reads after the step (GITHUB_ENV, GITHUB_PATH, GITHUB_OUTPUT,
// GITHUB_STATE, GITHUB_STEP_SUMMARY) and tokens. A service that can write the first kind changes the
// environment or the PATH of the later steps, which hold the job's token; the second kind is the job's
// own credentials. Neither is for the service Wasit starts (review of S1, finding 3).
describe("the runner's own variables", () => {
  const RUNNER = [
    "GITHUB_ENV",
    "GITHUB_PATH",
    "GITHUB_OUTPUT",
    "GITHUB_STATE",
    "GITHUB_STEP_SUMMARY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
  ];

  it("are removed from the environment of the service, in any case", () => {
    for (const name of RUNNER) {
      assert.equal(isDeniedEnvName(name), true, name);
      assert.equal(isDeniedEnvName(name.toLowerCase()), true, name.toLowerCase());
    }
    const env = Object.fromEntries(RUNNER.map((name) => [name, "/home/runner/_temp/fake"]));
    assert.deepEqual(scrubEnv({ ...env, PATH: "/usr/bin" }), { PATH: "/usr/bin" });
  });

  it("leave the harmless ones a service may read", () => {
    for (const name of ["CI", "GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF", "RUNNER_OS", "RUNNER_TEMP"]) {
      assert.equal(isDeniedEnvName(name), false, name);
    }
  });

  it("are not among the six fixed key names, whose values every output must hide", () => {
    for (const name of RUNNER) assert.ok(!DENIED_ENV_NAMES.includes(name), name);
  });
});

describe("scrubEnv", () => {
  const env = {
    PATH: "/usr/bin",
    PORT: "3000",
    STELLAR_PAYEE_ADDRESS: "GPUBLIC",
    STELLAR_PRIVATE_KEY: "fake-stellar-key",
    evm_private_key: "fake-evm-key",
    WASIT_HEADER_X_API_KEY: "fake-header-value",
    WASIT_RPC_URL: "https://rpc.example/fake-key",
    UNSET: undefined,
  };

  it("removes the denied names and keeps the rest", () => {
    assert.deepEqual(scrubEnv(env), { PATH: "/usr/bin", PORT: "3000", STELLAR_PAYEE_ADDRESS: "GPUBLIC" });
  });

  it("does not change what it was given", () => {
    const before = JSON.stringify(env);
    scrubEnv(env);
    assert.equal(JSON.stringify(env), before);
  });
});

describe("deniedEnvValues", () => {
  it("lists the values of the fixed names, the header variables and the RPC url", () => {
    const values = deniedEnvValues({
      PATH: "/usr/bin",
      STELLAR_PRIVATE_KEY: "fake-stellar-key",
      MPP_PAYER_SECRET: "fake-mpp-key",
      WASIT_HEADER_X_API_KEY: "fake-header-value",
      WASIT_RPC_URL: "https://rpc.example/fake-key",
    });
    assert.deepEqual(
      [...values].sort(),
      ["fake-header-value", "fake-mpp-key", "fake-stellar-key", "https://rpc.example/fake-key"].sort(),
    );
  });

  it("leaves out empty and unset values, and WASIT_ variables that are not secret", () => {
    const values = deniedEnvValues({
      STELLAR_PRIVATE_KEY: "",
      EVM_PRIVATE_KEY: undefined,
      WASIT_ALLOW_DESTRUCTIVE: "1",
      WASIT_CHECKS_PATH: "/x/CHECKS.md",
    });
    assert.deepEqual(values, []);
  });
});
