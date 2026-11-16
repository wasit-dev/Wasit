/**
 * The inputs of the Action and the command lines built from them (spec A4,
 * A8 #1, #8): every input reaches the CLI as one argument of an argument list,
 * never as shell text, and the tier that pays is refused in this version.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InputError,
  TOKEN_VARIABLES,
  buildReportArgs,
  buildRunArgs,
  parseInputs,
  scrubTokens,
} from "../scripts/inputs.mjs";

const env = (overrides = {}) => ({ INPUT_CONFIG: "wasit.config.json", INPUT_ENVIRONMENT: "", INPUT_TIER: "read-only", INPUT_ENDPOINTS: "", GITHUB_EVENT_NAME: "pull_request", ...overrides });

describe("parseInputs", () => {
  it("takes the defaults: the config file in the working directory, read-only, every endpoint", () => {
    assert.deepEqual(parseInputs(env()), { config: "wasit.config.json", environment: undefined, tier: "read-only", endpoints: [] });
  });

  it("reads an environment and a list of endpoints, separated by line breaks or commas", () => {
    const inputs = parseInputs(env({ INPUT_ENVIRONMENT: "staging", INPUT_ENDPOINTS: "weather, summarize\nchat\r\n\n , raw" }));
    assert.equal(inputs.environment, "staging");
    assert.deepEqual(inputs.endpoints, ["weather", "summarize", "chat", "raw"]);
  });

  it("falls back to the defaults when the workflow passes an empty value", () => {
    assert.equal(parseInputs(env({ INPUT_CONFIG: "", INPUT_TIER: "" })).config, "wasit.config.json");
    assert.equal(parseInputs(env({ INPUT_TIER: "" })).tier, "read-only");
  });

  describe("tier", () => {
    it("takes payment, on any event: the CLI decides whether the event may pay (D-022a)", () => {
      for (const name of ["push", "pull_request", "schedule", "workflow_dispatch"]) {
        assert.equal(parseInputs(env({ INPUT_TIER: "payment", GITHUB_EVENT_NAME: name })).tier, "payment", name);
      }
    });

    it("refuses anything that is not read-only or payment, without quoting the value", () => {
      for (const tier of ["Payment", "full", "read-only; id", "mainnet", "payment\n"]) {
        if (tier.trim() === "payment") continue;
        assert.throws(
          () => parseInputs(env({ INPUT_TIER: tier })),
          (error) => error instanceof InputError && /tier must be read-only or payment/.test(error.message) && !error.message.includes(tier),
          tier,
        );
      }
    });
  });

  it("refuses pull_request_target: it would give a fork's code the base repository's token", () => {
    assert.throws(
      () => parseInputs(env({ GITHUB_EVENT_NAME: "pull_request_target" })),
      (error) => error instanceof InputError && /pull_request_target/.test(error.message),
    );
  });

  it("allows push, pull_request, workflow_dispatch and schedule", () => {
    for (const name of ["push", "pull_request", "workflow_dispatch", "schedule"]) assert.doesNotThrow(() => parseInputs(env({ GITHUB_EVENT_NAME: name })), name);
  });

  describe("names that would be shell text", () => {
    const bad = ["a; rm -rf /", "$(whoami)", "`id`", "a b", "../x", "-r", "--flag", "a|b", "x".repeat(65), "é"];
    for (const name of bad) {
      it(`refuses the endpoint ${JSON.stringify(name)} and the environment of the same name`, () => {
        assert.throws(() => parseInputs(env({ INPUT_ENDPOINTS: name })), InputError);
        assert.throws(() => parseInputs(env({ INPUT_ENVIRONMENT: name })), InputError);
      });
    }

    it("refuses more than 50 endpoints", () => {
      assert.throws(() => parseInputs(env({ INPUT_ENDPOINTS: Array.from({ length: 51 }, (_, index) => `e${index}`).join(",") })), InputError);
    });

    it("refuses a config path with a control character or over 300 characters", () => {
      assert.throws(() => parseInputs(env({ INPUT_CONFIG: "a\nb" })), InputError);
      assert.throws(() => parseInputs(env({ INPUT_CONFIG: "x".repeat(301) })), InputError);
      assert.throws(() => parseInputs(env({ INPUT_CONFIG: "-rf" })), InputError);
    });
  });
});

describe("buildRunArgs", () => {
  const cli = "/opt/wasit/packages/cli/dist/index.js";
  const paths = { cli, report: "/tmp/w/report.json" };

  it("is one call: run --read-only --start --json --out, with the config", () => {
    assert.deepEqual(buildRunArgs(parseInputs(env()), paths), [cli, "run", "--read-only", "--start-if-local", "--json", "--out", "/tmp/w/report.json", "--config", "wasit.config.json"]);
  });

  it("adds --baseline, --env and --endpoint once per name, in a fixed order", () => {
    const args = buildRunArgs(parseInputs(env({ INPUT_ENVIRONMENT: "staging", INPUT_ENDPOINTS: "a,b" })), { ...paths, baseline: "/tmp/w/baseline/baseline.json" });
    assert.deepEqual(args, [
      cli, "run", "--read-only", "--start-if-local", "--json", "--out", "/tmp/w/report.json",
      "--baseline", "/tmp/w/baseline/baseline.json",
      "--config", "wasit.config.json", "--env", "staging", "--endpoint", "a", "--endpoint", "b",
    ]);
  });

  it("offers no flag that opts in or carries a key, on either tier", () => {
    for (const tier of ["read-only", "payment"]) {
      const joined = buildRunArgs(parseInputs(env({ INPUT_TIER: tier })), paths).join(" ");
      assert.ok(!/--dry-run|--mainnet|--payer-key|--commitment-key|--allow-destructive/.test(joined), tier);
    }
  });

  it("drops --read-only for the payment tier, and changes nothing else", () => {
    const read = buildRunArgs(parseInputs(env()), paths);
    const pay = buildRunArgs(parseInputs(env({ INPUT_TIER: "payment" })), paths);
    assert.deepEqual(pay, read.filter((arg) => arg !== "--read-only"));
  });

  it("keeps a value that looks like a flag a single argument after its option", () => {
    const args = buildRunArgs({ config: "wasit.config.json", environment: "staging", tier: "read-only", endpoints: ["a"] }, paths);
    assert.equal(args[args.indexOf("--env") + 1], "staging");
  });
});

describe("buildReportArgs", () => {
  const paths = { cli: "/opt/wasit/packages/cli/dist/index.js", report: "/tmp/w/report.json", comment: "/tmp/w/comment.md", baselineOut: "/tmp/w/baseline-next.json" };

  it("reads the report and writes the comment and the next baseline", () => {
    assert.deepEqual(buildReportArgs(paths), [paths.cli, "ci-report", "--report", paths.report, "--comment", paths.comment, "--baseline-out", paths.baselineOut]);
  });

  it("adds --history and --baseline-run when there are, after the baseline (D-022b)", () => {
    const args = buildReportArgs({ ...paths, baseline: "/tmp/w/baseline/baseline.json", history: "/tmp/w/history/baseline.json", baselineRun: "200" });
    assert.deepEqual(args.slice(-6), ["--baseline", "/tmp/w/baseline/baseline.json", "--history", "/tmp/w/history/baseline.json", "--baseline-run", "200"]);
    const none = buildReportArgs({ ...paths, history: "", baselineRun: "" });
    assert.ok(!none.includes("--history") && !none.includes("--baseline-run"));
  });

  it("adds --baseline only when there is one", () => {
    assert.deepEqual(buildReportArgs({ ...paths, baseline: "/tmp/w/baseline/baseline.json" }).slice(-2), ["--baseline", "/tmp/w/baseline/baseline.json"]);
    assert.ok(!buildReportArgs({ ...paths, baseline: "" }).includes("--baseline"));
  });
});

describe("scrubTokens", () => {
  it("removes every variable that carries the job's token, in any spelling of the name", () => {
    const clean = scrubTokens({
      PATH: "/usr/bin",
      GH_TOKEN: "t1",
      GITHUB_TOKEN: "t2",
      gh_token: "t3",
      ACTIONS_RUNTIME_TOKEN: "t4",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t5",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid",
      ACTIONS_CACHE_URL: "https://example.invalid",
      KEEP_ME: "kept",
    });
    assert.deepEqual(clean, { PATH: "/usr/bin", KEEP_ME: "kept" });
    for (const name of TOKEN_VARIABLES) assert.equal(clean[name], undefined, name);
  });

  it("does not change what it was given", () => {
    const given = { GH_TOKEN: "t", A: "1" };
    scrubTokens(given);
    assert.deepEqual(given, { GH_TOKEN: "t", A: "1" });
  });
});
