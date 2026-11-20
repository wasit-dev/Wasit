# Job 05 — Repo Audit and the 0.2.0 Release

Status: ✅ **DONE** (2026-09-03 → 2026-09-04) · Not a SOW deliverable. An audit
of the repo against what a reviewer actually does — clone it, install it from
npm, follow the docs — rather than against what the docs claim.

## Goal
Find and fix everything that would embarrass the project in front of a Chapter
Lead or SCF reviewer, and get npm back in sync with the source.

## Acceptance criteria
- [x] Every declared dependency is one the package actually imports, and every imported package is declared.
- [x] No build output tracked in git.
- [x] No references left to the pre-rename `@wasit/` scope.
- [x] README leads with the npm install path rather than a five-step source clone.
- [x] npm and the repository agree about what each version contains.
- [x] `CHANGELOG.md` records the release.

## What happened

The headline finding was that **npm was a full feature behind `main` with no
version bump to say so**. `@wasit-dev/cli@0.1.1` had no `checks` subcommand and
no `--json`, and `@wasit-dev/core@0.1.1` shipped no catalogue at all, while
`docs/guides/cli.md` — served on usewasit.dev — documented all three as
available. A reviewer doing the obvious thing (install from npm, follow the
docs) would have hit `unknown command 'checks'`. Worse, the version numbers had
stopped identifying content: the repo at 0.1.1 and npm at 0.1.1 were different
code.

Smaller defects, all verified by scanning imports rather than reading docs:
`@wasit-dev/core` declared `@x402/core`, `@x402/express`, `commander` and
`dotenv` as runtime dependencies while importing none of them; `commander` was
not used anywhere in core at all. `@wasit-dev/cli` declared `@stellar/mpp`,
`@stellar/stellar-sdk` and `mppx`, none of which it imports, and pinned
`commander@^12` / `dotenv@^16` while being built and verified against 15 and
17. `express` was imported by the x402 fixture but declared nowhere, resolving
only because npm hoisted it from a deeper transitive dependency. Two stale
build artifacts (`dist/src/index.{js,d.ts}`) were tracked at the repo root,
still importing the pre-rename `@wasit/core`. `SECURITY.md` asked reporters for
their `@wasit/core` version.

One finding was withdrawn after checking the source: `PREFLIGHT`'s absence from
the typed catalogue is deliberate and documented — `docs/CHECKS.md` says
plainly that it is a diagnostic, not a check.

Fixing the dependencies triggered a real incident. `npm install` pruned the
hoisted `commander` when core stopped declaring it and never installed the copy
cli now needed, leaving a lockfile that declared a workspace dependency with no
resolved node — a state `npm ci` rejects outright, so CI would have failed too.
Reproducing it in an isolated tree showed a second plain `npm install`
reconciles it fully; that was verified end-to-end, including `npm ci` exiting 0,
before the fix was run for real.

## Result

**0.2.0 published** for all three packages (`core`, `cli`, `server`), tagged and
released on GitHub. Commits: `4d64bc0` (stray build output), `b563c33`
(dependencies + release), `48820d3` (README install path, SECURITY.md scope),
`a511ca9` (CHANGELOG + duplicate link).

The audit also produced the third upstream finding. A clean consumer install
resolves **two** copies of `@stellar/stellar-sdk` and **two** of `mppx`, because
`@stellar/mpp@0.7.1` still declares peers of `^15.1.0` and `^0.6.29` while the
ecosystem publishes 17.0.1 and 0.9.2. Since `@stellar/mpp` imports `mppx` at
runtime, objects built from one instance cross into code running the other. The
duplicate SDK also carries six high-severity advisories npm reports as having no
fix available, under a range covering every `@stellar/mpp` from 0.5.0 onward.
Written up as Finding 3 in `docs/findings/upstream-sdk.md` and filed as
[stellar-mpp-sdk#70](https://github.com/stellar/stellar-mpp-sdk/issues/70).

Worth carrying forward: a checkout and a consumer install resolve differently.
With a lockfile npm dedupes to one SDK and merely marks the peer invalid, so
testing from a checkout never shows the duplicate. **The configuration Wasit is
developed against is not the one its users get** — which is why
[issue #2](https://github.com/wasit-dev/wasit/issues/2) now tracks verifying
releases from a clean install.
