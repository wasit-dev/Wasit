import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getEnvironmentStatus } from "../../src/dashboard/environment.js";

const ENV_KEYS = [
  "STELLAR_PRIVATE_KEY",
  "EVM_PRIVATE_KEY",
  "SVM_PRIVATE_KEY",
  "COMMITMENT_SECRET_HEX",
  "MPP_PAYER_SECRET",
] as const;

describe("getEnvironmentStatus", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) saved[key] = value;
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value !== undefined) process.env[key] = value;
      delete saved[key];
    }
  });

  it("reports not ready when no key is set", () => {
    const statuses = getEnvironmentStatus();
    assert.equal(
      statuses.every((status) => !status.ready),
      true,
    );
  });

  it("reports a key as ready once it's set", () => {
    process.env.COMMITMENT_SECRET_HEX = "deadbeef";
    const statuses = getEnvironmentStatus();
    const commitment = statuses.find((status) => status.label.includes("COMMITMENT_SECRET_HEX"));
    assert.equal(commitment?.ready, true);
  });

  it("covers every payer role the wallet screen can configure", () => {
    // The panel silently omitting a role it can otherwise create and fund
    // reads as that role not existing, which is how x402 went missing.
    const labels = getEnvironmentStatus().map((status) => status.label);
    for (const key of ENV_KEYS) {
      assert.ok(
        labels.some((label) => label.includes(key)),
        `expected the environment panel to cover ${key}`,
      );
    }
  });
});
