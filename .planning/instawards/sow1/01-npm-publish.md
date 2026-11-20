# Job 01 — Publish npm Packages

Status: ✅ **DONE** (2026-09-01) · Not a direct SOW deliverable (confirmed:
"npm" is never mentioned in `WASIT_SOW.docx`), but README's own roadmap
promised it and it's what makes the CLI/MCP server actually installable by
anyone rather than only usable from a clone.

## Goal
Publish `@wasit-dev/core`, `@wasit-dev/cli`, and `@wasit-dev/server` to npm,
publicly, so `npm install -g @wasit-dev/cli` and `npx @wasit-dev/server` work
for someone who has never seen this repo.

## Acceptance criteria
- [x] All three packages build cleanly in dependency order (core → cli → server).
- [x] `npm pack --dry-run` shows correct package names and full `dist/` contents.
- [x] All three publish successfully and are installable via a clean `npx`/`npm install -g`.
- [x] The MCP server's `wasit://checks` resource resolves even without a local checkout.

## What happened
Full troubleshooting chain, resolved across several rounds: missing
`npm install` before the first build; workspace builds not running in
dependency order (fixed with explicit `--workspace=packages/core` then `cli`
then `server`); npm's E403 2FA/security-token requirement (fixed by enabling
2FA on the npm account); E404 because the `@wasit` scope had no npm
Organization backing it. Tried the builder's own username first
(`najmiimut`), reverted in favor of project branding; `wasit` alone was
unavailable as an org name; considered `wasit-protocol` (rejected — Wasit
tests protocols, it isn't one); settled on and created the `wasit-dev` org.
One more round of `TS2307` after the rename, caused by stale workspace
symlinks (`npm install` at root fixed it — npm only refreshes those on
install, not on a manual `package.json` name edit).

Each `package.json` was hardened before the first publish: `files`,
`repository`, `homepage`, `bugs`, `keywords`, `license: "Apache-2.0"`,
`engines.node`, `publishConfig.access: "public"`.

## Result

**2026-09-01, first publish:** `@wasit-dev/core@0.1.0`, `@wasit-dev/cli@0.1.0`,
`@wasit-dev/server@0.1.0` all live.

- https://www.npmjs.com/package/@wasit-dev/core
- https://www.npmjs.com/package/@wasit-dev/cli
- https://www.npmjs.com/package/@wasit-dev/server

**2026-09-01, same day, patch:** while writing `docs/guides/mcp.md`, found
that `wasit://checks` couldn't locate `docs/CHECKS.md` on an `npx`-only
install (no `docs/` directory ships next to `node_modules/@wasit-dev/server`
by default) — the resource was silently absent, no error. Fixed by adding a
`prepack` script to `packages/server/package.json` that copies
`docs/CHECKS.md` into the package before it's packed, and adding `docs` to
`files`. Only `server` needed the fix and the version bump — `core` and `cli`
are untouched, so they stay at `0.1.0`. Published
**`@wasit-dev/server@0.1.1`**.

Recorded in `CHANGELOG.md` at the repo root (both entries).

## Updating later
Any of the three can be republished any time: bump that package's version
(semver — patch for a fix, minor for a new check/feature, major for a
breaking change), rebuild in dependency order, `npm pack --dry-run` to
verify, then `npm publish --workspace=packages/<name>`. The one thing that
can never happen is republishing an already-live version number — only a new
one supersedes it.
