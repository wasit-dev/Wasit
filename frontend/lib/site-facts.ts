import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The two numbers the landing page and nav print — the published version
 * and how many checks there are — read from the repo at build time rather
 * than typed into the page. A release bumps packages/cli/package.json and
 * the next deploy says so; a check added to docs/CHECKS.md is counted
 * without anyone remembering the homepage. Same repo-root resolution as
 * readRepoDoc in lib/content.ts, and the same Vercel setting behind it.
 */
// Both paths are spelled out in full rather than passed through a helper:
// a path built from a parameter makes Turbopack trace the whole project
// into the server bundle.
export const WASIT_VERSION: string = JSON.parse(
  readFileSync(join(process.cwd(), "..", "packages", "cli", "package.json"), "utf-8"),
).version;

/** One row per check in the catalogue's tables: "| `X402-01` | ...". */
export const CHECK_COUNT: number = (
  readFileSync(join(process.cwd(), "..", "docs", "CHECKS.md"), "utf-8").match(/^\| `(?:X402|MPP)-\d+`/gm) ?? []
).length;
