/**
 * The mainnet opt-in switches of this version (spec B5, B12): `--mainnet` of
 * `wasit run`, and the MCP server's start-up variables `WASIT_MAINNET_OPT_IN`
 * and `WASIT_MAINNET_CONFIG`. Each exists only to refuse, with the sentence of
 * B12, so a run or a server that asks for mainnet is stopped and told why,
 * never run on what else it was given.
 *
 * The module has no function that answers "allowed": every function either
 * throws or only says which switches are set.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigurationError } from "../../src/errors.js";
import * as optin from "../../src/guard/mainnet-optin.js";
import {
  MAINNET_OPT_IN_ABSENT,
  MainnetOptInRefusedError,
  mainnetStartupSwitches,
  refuseMainnetSwitch,
  type MainnetSwitch,
} from "../../src/guard/mainnet-optin.js";
import { NETWORK_CLASSES } from "../../src/guard/networks.js";

const SWITCHES: readonly MainnetSwitch[] = ["--mainnet", "WASIT_MAINNET_OPT_IN", "WASIT_MAINNET_CONFIG"];
const TEST_NETWORKS = [...NETWORK_CLASSES].filter(([, kind]) => kind === "test").map(([network]) => network);

function refusal(name: MainnetSwitch, context?: { event?: string }): MainnetOptInRefusedError {
  try {
    refuseMainnetSwitch(name, context);
  } catch (error) {
    assert.ok(error instanceof MainnetOptInRefusedError, `${name}: a MainnetOptInRefusedError`);
    return error;
  }
  assert.fail(`${name} was not refused`);
}

describe("the mainnet opt-in switches of this version (B12)", () => {
  it("says the sentence of B12", () => {
    assert.equal(MAINNET_OPT_IN_ABSENT, "the mainnet opt-in is not part of this version");
  });

  it("refuses --mainnet, names the test networks it pays on, and says nothing was done", () => {
    const error = refusal("--mainnet");
    assert.ok(error instanceof ConfigurationError, "a ConfigurationError: the front ends exit 2 on it");
    assert.equal(error.switchName, "--mainnet");
    assert.match(error.message, /^--mainnet is refused: the mainnet opt-in is not part of this version\./);
    for (const network of TEST_NETWORKS) assert.ok(error.message.includes(network), network);
    assert.match(error.message, /Nothing was read, started, sent or signed\.$/);
    assert.doesNotMatch(error.message, /workflow_dispatch/, "no event rule outside GitHub Actions");
  });

  it("adds the event rule on a GitHub event that is not workflow_dispatch, and names the event", () => {
    for (const event of ["push", "schedule", "pull_request", "pull_request_target", "merge_group"]) {
      const error = refusal("--mainnet", { event });
      assert.ok(
        error.message.includes(`--mainnet is also refused on every GitHub event but workflow_dispatch, and this run's event is ${event}.`),
        error.message,
      );
      assert.match(error.message, /Nothing was read, started, sent or signed\.$/);
    }
  });

  it("still refuses on workflow_dispatch, without the event rule", () => {
    const error = refusal("--mainnet", { event: "workflow_dispatch" });
    assert.match(error.message, /the mainnet opt-in is not part of this version/);
    assert.doesNotMatch(error.message, /also refused/);
  });

  it("never echoes an event name it cannot read", () => {
    for (const event of ["push; rm -rf /", "x".repeat(65), "Push", "pu\u001bsh", ""]) {
      const error = refusal("--mainnet", { event });
      assert.ok(!error.message.includes(event) || event === "", JSON.stringify(event));
      if (event !== "") assert.match(error.message, /and this run's event is another event\./);
    }
  });

  it("refuses each MCP start-up variable: the server does not start", () => {
    for (const name of ["WASIT_MAINNET_OPT_IN", "WASIT_MAINNET_CONFIG"] as const) {
      const error = refusal(name);
      assert.equal(error.switchName, name);
      assert.match(error.message, new RegExp(`^${name} is set: the mainnet opt-in is not part of this version, so this server does not start\\.`));
      for (const network of TEST_NETWORKS) assert.ok(error.message.includes(network), network);
      assert.match(error.message, new RegExp(`Remove ${name} from the server's environment to start it\\.$`));
    }
  });

  it("finds the MCP start-up switches: any value that is not blank, in any letter case on the name, and --mainnet among the arguments", () => {
    assert.deepEqual(mainnetStartupSwitches({}, []), []);
    assert.deepEqual(mainnetStartupSwitches({ WASIT_MAINNET_OPT_IN: "", WASIT_MAINNET_CONFIG: "  " }, []), []);
    assert.deepEqual(mainnetStartupSwitches({ WASIT_MAINNET_OPT_IN: "1" }, []), ["WASIT_MAINNET_OPT_IN"]);
    assert.deepEqual(mainnetStartupSwitches({ WASIT_MAINNET_OPT_IN: "0" }, []), ["WASIT_MAINNET_OPT_IN"], "0 is set: remove it");
    assert.deepEqual(mainnetStartupSwitches({ wasit_mainnet_config: "/tmp/x.json" }, []), ["WASIT_MAINNET_CONFIG"]);
    assert.deepEqual(
      mainnetStartupSwitches({ WASIT_MAINNET_OPT_IN: "1", WASIT_MAINNET_CONFIG: "/x" }, ["--mainnet"]),
      ["--mainnet", "WASIT_MAINNET_OPT_IN", "WASIT_MAINNET_CONFIG"],
    );
    assert.deepEqual(mainnetStartupSwitches({}, ["--mainnet=true"]), ["--mainnet"]);
    assert.deepEqual(mainnetStartupSwitches({}, ["--allow-destructive"]), []);
  });

  it("has no function that answers allowed: each one throws, or only lists the switches that are set", () => {
    const functions = Object.entries(optin).filter(([, value]) => typeof value === "function");
    const names = functions.map(([name]) => name).sort();
    assert.deepEqual(names, ["MainnetOptInRefusedError", "mainnetStartupSwitches", "refuseMainnetSwitch"]);
    for (const name of SWITCHES) {
      for (const context of [undefined, {}, { event: "workflow_dispatch" }, { event: "push" }]) {
        assert.throws(() => refuseMainnetSwitch(name, context), MainnetOptInRefusedError);
      }
    }
    for (const env of [{}, { WASIT_MAINNET_OPT_IN: "1" }]) {
      const result = mainnetStartupSwitches(env, ["--mainnet"]);
      assert.ok(Array.isArray(result) && result.every((entry) => SWITCHES.includes(entry)), "a list of switch names, nothing else");
    }
  });
});
