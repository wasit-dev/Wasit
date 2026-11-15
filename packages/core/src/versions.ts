/**
 * The versions a result names: Wasit core and the CLI, the x402 version Wasit
 * grades, and the SDK packages the checks run through.
 *
 * Read at run time from the installed packages' own `package.json`, by path,
 * never typed by hand: a constant drifts from what is installed, and the point
 * of printing a version is that it is the one that ran. They are read by path
 * and not through `require.resolve("<pkg>/package.json")` because the SDK
 * packages' export maps do not list it (checked on 2026-11-15 for all five:
 * ERR_PACKAGE_PATH_NOT_EXPORTED).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** What is printed when a version cannot be established. Never a guess. */
const UNKNOWN = "unknown";

/** A version as npm publishes it. Anything else is not printed: these strings reach a pull request comment. */
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;

/** An npm package name, scoped or not: no path segment can climb out of node_modules. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

function versionIn(manifestPath: string, expectedName: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { name?: unknown; version?: unknown };
    return manifest.name === expectedName && typeof manifest.version === "string" && VERSION.test(manifest.version)
      ? manifest.version
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The installed version of `name`, found the way Node finds a dependency: in
 * `node_modules` of `from` or of any directory above it.
 *
 * Returns "unknown" when the package is not there, its name does not match, or
 * its version is not a version.
 */
export function readPackageVersion(name: string, from: string): string {
  if (!PACKAGE_NAME.test(name)) return UNKNOWN;
  let directory = resolve(from);
  for (;;) {
    const version = versionIn(join(directory, "node_modules", name, "package.json"), name);
    if (version !== undefined) return version;
    const parent = dirname(directory);
    if (parent === directory) return UNKNOWN;
    directory = parent;
  }
}

/** This package's own version: the `package.json` above this file, in `src/` and in `dist/` alike. */
function ownVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const version = versionIn(join(directory, "package.json"), "@wasit-dev/core");
    if (version !== undefined) return version;
    const parent = dirname(directory);
    if (parent === directory) return UNKNOWN;
    directory = parent;
  }
}

export interface ToolVersions {
  readonly wasit: { readonly cli: string; readonly core: string };
  readonly sdk: {
    /** The x402 version Wasit grades. */
    readonly x402Version: 2;
    readonly "@x402/core": string;
    readonly "@x402/stellar": string;
    readonly "@stellar/mpp": string;
    readonly mppx: string;
    readonly "@stellar/stellar-sdk": string;
  };
}

/**
 * The versions of this run. The CLI knows its own version (core cannot read the
 * CLI's `package.json`), so it passes it in.
 */
export function readToolVersions(cliVersion?: string): ToolVersions {
  const here = dirname(fileURLToPath(import.meta.url));
  // `@x402/core` is a dependency of `@x402/fetch`; when npm does not hoist it, it sits under that package.
  const fetchDir = (() => {
    for (let directory = here; ; directory = dirname(directory)) {
      const candidate = join(directory, "node_modules", "@x402", "fetch");
      if (versionIn(join(candidate, "package.json"), "@x402/fetch") !== undefined) return candidate;
      if (dirname(directory) === directory) return undefined;
    }
  })();
  const read = (name: string): string => {
    for (const start of fetchDir === undefined ? [here] : [here, fetchDir]) {
      const version = readPackageVersion(name, start);
      if (version !== UNKNOWN) return version;
    }
    return UNKNOWN;
  };

  return {
    wasit: {
      cli: cliVersion !== undefined && VERSION.test(cliVersion) ? cliVersion : UNKNOWN,
      core: ownVersion(),
    },
    sdk: {
      x402Version: 2,
      "@x402/core": read("@x402/core"),
      "@x402/stellar": read("@x402/stellar"),
      "@stellar/mpp": read("@stellar/mpp"),
      mppx: read("mppx"),
      "@stellar/stellar-sdk": read("@stellar/stellar-sdk"),
    },
  };
}
