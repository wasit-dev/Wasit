/**
 * The shared fixture config, read the way the CLI will read it: through the
 * built `@wasit-dev/core`. The same file backs the core tests and, later, the
 * Action's, so a change to the schema that breaks one breaks all three.
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { ConfigError, describeRun, readConfigFile, resolveRun } from "@wasit-dev/core";

const FIXTURE = fileURLToPath(new URL("../../../core/test/fixtures/wasit.config.json", import.meta.url));

describe("the fixture wasit.config.json, through @wasit-dev/core", () => {
  it("loads, and resolves the default environment to URLs on its own origin", () => {
    const run = resolveRun(readConfigFile(FIXTURE), {}, {});
    assert.equal(run.environment, "local");
    assert.deepEqual(run.endpoints.map((endpoint) => new URL(endpoint.url).origin), Array(5).fill("http://127.0.0.1:3000"));
    assert.match(describeRun(run), /Endpoints: 5/);
  });

  it("names the environments when one is asked for that is not there", () => {
    assert.throws(
      () => resolveRun(readConfigFile(FIXTURE), { environment: "prod" }, {}),
      (error: unknown) => error instanceof ConfigError && /local, staging, mainnet/.test(error.message),
    );
  });
});
