/**
 * The versions a result names (SOW D1: "Each result names the Wasit, x402 and
 * SDK versions it used"). They are read at run time from the installed
 * packages' own `package.json`, never typed by hand, and read by path: every
 * SDK package here blocks `require.resolve("<pkg>/package.json")` with an
 * export map (attack finding A-A07, verified below).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { readBuildCommit, readPackageVersion, readToolVersions } from "../../src/versions.js";

const here = dirname(fileURLToPath(import.meta.url));
const coreManifest = JSON.parse(readFileSync(join(here, "../../package.json"), "utf-8")) as { version: string };

/** A scratch tree with `packages` installed under node_modules at `at`. */
function tree(packages: Record<string, unknown>, at = "."): string {
  const root = mkdtempSync(join(tmpdir(), "wasit-versions-"));
  for (const [name, manifest] of Object.entries(packages)) {
    const dir = join(root, at, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  }
  return root;
}

describe("readPackageVersion", () => {
  it("reads a version from the package's own package.json, by path", () => {
    const root = tree({ "@scope/pkg": { name: "@scope/pkg", version: "1.2.3" }, plain: { name: "plain", version: "0.0.1-beta.2" } });
    assert.equal(readPackageVersion("@scope/pkg", root), "1.2.3");
    assert.equal(readPackageVersion("plain", root), "0.0.1-beta.2");
  });

  it("finds a package installed above the start directory", () => {
    const root = tree({ up: { name: "up", version: "4.5.6" } });
    const deep = join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    assert.equal(readPackageVersion("up", deep), "4.5.6");
  });

  it("reads one that an export map hides from require.resolve", () => {
    const require = createRequire(join(here, "../../package.json"));
    assert.throws(() => require.resolve("@x402/core/package.json"), /ERR_PACKAGE_PATH_NOT_EXPORTED|not defined by "exports"/);
    const installed = JSON.parse(readFileSync(require.resolve("@x402/core").replace(/(@x402\/core)\/.*$/, "$1/package.json"), "utf-8")) as { version: string };
    assert.equal(readPackageVersion("@x402/core", here), installed.version);
  });

  it("says unknown, and does not guess, for a package that is not there or has no usable version", () => {
    const root = tree({
      noversion: { name: "noversion" },
      weird: { name: "weird", version: "1.0.0\n::error::pwned" },
      "not-semver": { name: "not-semver", version: "latest" },
      mismatch: { name: "other", version: "9.9.9" },
    });
    for (const name of ["missing", "noversion", "weird", "not-semver", "mismatch"]) {
      assert.equal(readPackageVersion(name, root), "unknown", name);
    }
  });

  it("does not read outside node_modules for a name that climbs out of it", () => {
    const root = tree({});
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    for (const name of ["..", "../..", "a/../..", "/etc", ""]) {
      assert.equal(readPackageVersion(name, root), "unknown", JSON.stringify(name));
    }
  });
});

describe("readToolVersions", () => {
  it("names Wasit core, the CLI as given, x402 version 2 and each SDK, from the installed packages", () => {
    const versions = readToolVersions("9.8.7");
    assert.equal(versions.wasit.cli, "9.8.7");
    assert.equal(versions.wasit.core, coreManifest.version);
    assert.equal(versions.sdk.x402Version, 2);
    for (const name of ["@x402/core", "@x402/stellar", "@stellar/mpp", "mppx", "@stellar/stellar-sdk"] as const) {
      assert.match(versions.sdk[name], /^\d+\.\d+\.\d+/, name);
    }
  });

  it("says unknown for a CLI version it was not given or that is not a version", () => {
    assert.equal(readToolVersions().wasit.cli, "unknown");
    assert.equal(readToolVersions("1.0.0\n::error::x").wasit.cli, "unknown");
  });
});

describe("readBuildCommit", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  it("gives the first seven characters of a full lower-case commit id", () => {
    assert.equal(readBuildCommit({ WASIT_BUILD_COMMIT: sha }), "0123456");
  });

  it("gives nothing for a tag, a branch, a short or upper-case id, a value with a newline, or no value", () => {
    for (const value of ["v0.8.0-beta.1", "main", sha.slice(0, 12), sha.toUpperCase(), `${sha}\n::error::x`, `${sha}0`, ""]) {
      assert.equal(readBuildCommit({ WASIT_BUILD_COMMIT: value }), undefined, JSON.stringify(value));
    }
    assert.equal(readBuildCommit({ WASIT_BUILD_COMMIT: undefined }), undefined);
    assert.equal(readBuildCommit({}), undefined);
  });
});

describe("readToolVersions with a build", () => {
  it("names the build only when it is seven lower-case hex characters", () => {
    assert.equal(readToolVersions("0.7.0", "0123456").wasit.build, "0123456");
    for (const bad of ["0123456789", "ABCDEF0", "main", "012345\n", ""]) {
      assert.equal("build" in readToolVersions("0.7.0", bad).wasit, false, JSON.stringify(bad));
    }
    assert.equal("build" in readToolVersions("0.7.0").wasit, false, "no build given, none named");
  });
});
