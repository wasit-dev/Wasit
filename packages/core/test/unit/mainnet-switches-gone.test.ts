/**
 * The switches of 0.8.0-beta.1 that only refused (`refuseMainnetSwitch`,
 * `mainnetStartupSwitches`, `MainnetOptInRefusedError`, `MAINNET_OPT_IN_ABSENT`)
 * are gone with the opt-in (spec B18 O3): every front end now opens a mainnet
 * run through `openMainnetOptIn`, and no text says the opt-in is not part of
 * this version.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import * as core from "../../src/index.js";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(path.join(dir, entry.name)) : entry.name.endsWith(".ts") ? [path.join(dir, entry.name)] : [],
  );
}

describe("the mainnet switches that only refused (B18 O3)", () => {
  it("are not exported from core", () => {
    for (const name of ["refuseMainnetSwitch", "mainnetStartupSwitches", "MainnetOptInRefusedError", "MAINNET_OPT_IN_ABSENT"]) {
      assert.equal(name in core, false, name);
    }
    assert.equal(typeof core.openMainnetOptIn, "function");
  });

  it("have no module left, and no source says the opt-in is not part of this version", () => {
    assert.equal(existsSync(path.join(SRC, "guard", "mainnet-optin.ts")), false);
    for (const file of sources(SRC)) {
      assert.ok(!/not part of this version/.test(readFileSync(file, "utf-8")), path.relative(SRC, file));
    }
  });
});
