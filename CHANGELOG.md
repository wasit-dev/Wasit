# Changelog

All notable changes to Wasit are recorded here. Versions follow [Semantic Versioning](https://semver.org/): patch releases are fixes, minor releases add checks or features without breaking existing usage, major releases break something.

## Unreleased

Planned for 0.5.0. Recorded here rather than in an issue because two of the
three change what a check *proves*, and anyone reading this file to decide
whether to upgrade needs to see that before the version lands. These three were
earmarked for 0.4.0 before 0.4.0 was spent on the two correctness fixes below;
they are unchanged, only renumbered.

**Will change results — `X402-06` gains on-chain verification.** The check
currently passes on any 2xx, which means it establishes that the target accepted
the payment, not that the payment landed. `MPP-01` already reads the token
contract's CAP-46 transfer event; the same verification belongs here. A service
that answers 200 without settling passes today and will fail after this. If a
run goes red on upgrade, the check got stronger — the service did not change.
Found by running against `stellar/x402-stellar`'s reference implementation; see
`docs/evidence/2026-09-06-reference-implementation-run.md`.

**Will change results — `X402-07` will corrupt only the signature.** Today the
corruption drops the base64 padding, so the decoded envelope grows by two bytes
and fails XDR decoding before signature verification is reached. A target that
parsed the envelope and skipped verification entirely passes. Corrupting a
signature byte while preserving a decodable envelope makes the rejection mean
what `docs/CHECKS.md` says it means. Same evidence document.

**`wasit wallet status --role <role>` will exit 2 on an unreadable key.** It
exits 0 today while `--role mpp-channel` exits 2 for the same class of
configuration error, so `wasit wallet status --role x402 && deploy` proceeds on
a key that could not be read. `status` with no `--role` keeps exiting 0: there,
one unreadable key is a row in a table, not a failed question.

## [0.4.0] — 2026-09-17

All three packages, versioned together as usual. Two correctness fixes, both in
how a run reports what it actually established. Neither adds a check; both
change what existing checks report in situations where the old answer was
wrong.

**Fixed — a charge-mode payment client no longer breaks every later
channel-mode check.** `Mppx.create` replaces `globalThis.fetch` with a wrapper
bound to one payment method unless `polyfill: false` is passed. Once `MPP-01`
created a charge client, every later channel-mode 402 in the same process was
refused by that wrapper with "No method found for challenges: stellar.channel.
Available: stellar.charge", reported as a defect in a target that was in fact
conformant. The CLI hid this because each invocation is a fresh process; the
MCP server did not, because one process answers many tool calls in a row. Only
the first payment-mode check in a process produced a trustworthy verdict.
`fetchTarget` now resolves the underlying fetch through mppx's own
`Symbol.for("mppx.fetch.wrapper")` tag, so a check observes the target rather
than whatever a previous check installed on the global. `packages/core`'s
charge client also passes `polyfill: false`, which is necessary but not
sufficient on its own: one stale build or one new caller brings the leak back.
Regression test: `test/unit/fetch-target-isolation.test.ts`.

**Changed — a failed setup is reported as no verdict, not as a defect.**
`MPP-11`, `MPP-12` and `MPP-14` each need one correctly advancing commitment
accepted before they can probe anything. That submission used to be attempted
once, and a refusal was reported as FAIL. Two very different worlds produce that
refusal identically: a target that wrongly rejects valid vouchers, and a channel
whose cumulative moved between the challenge being issued and the credential
being submitted, because something else is paying through it. The submission is
now retried up to three times, each against a freshly issued challenge, so
ordinary contention clears on its own. When every attempt is refused the result
is ERROR with the new error kind `setup`, carrying all three refusals verbatim,
and the run exits `2` (`no-verdict`) instead of `1` (`non-conformant`).

**Added — `CheckSetupError` and the `setup` error kind**, exported from
`@wasit-dev/core`. `errorKind` in `--json` and in the MCP server's
`structuredContent` can now carry `"setup"` alongside `unreachable`,
`configuration` and `harness`. A consumer that switches exhaustively on that
field needs a branch for it.

**Added — `scripts/fixtures.sh`**, which starts, stops and reports on the four
local fixture servers so a full local run needs one terminal instead of four.
Also adds `packages/core/test/fixtures/mpp-channel-refusing-server.ts`, a target
that issues valid challenges and refuses every credential, which reproduces a
setup failure on demand rather than by racing two runs.

## [0.3.0] — 2026-09-05

All three packages. Adds an interactive dashboard and testnet wallet tooling to
the CLI, a wallet layer to core, and a runtime version lookup in the MCP server.
All three are versioned together so they always resolve the same
`@wasit-dev/core`, rather than the MCP server quietly running a version behind
the CLI.

| Package | Version |
|---|---|
| `@wasit-dev/core` | 0.2.0 → 0.3.0 |
| `@wasit-dev/cli` | 0.2.0 → 0.3.0 |
| `@wasit-dev/server` | 0.2.0 → 0.3.0 |

**Added — an interactive dashboard.** Running `wasit` with no arguments in a
terminal opens a menu: the three check runners, a catalogue browser, and a
testnet wallet screen, driven by arrow keys. A run shows a live elapsed timer
and per-check progress, ends with total and average timing, and can be saved to
`wasit-<protocol>-<timestamp>.json` with `s` — the same shape as `--json`. A
misconfigured run gets its own error screen rather than a red line under an
otherwise-empty checklist. Piped or in CI, `wasit` still prints help, so nothing
that scripts it today changes behaviour.

**Added — `wasit wallet`.** `status`, `create` and `fund` for the testnet payer
keys the other subcommands read from `.env`. There is deliberately no
`--network` flag: Friendbot, the printed USDC issuer and the whole idea of a
disposable generated key only make sense on testnet. XLM funding via Friendbot
is fully automatic. USDC is not, and the tool says so rather than pretending
otherwise: the trustline is created automatically, but a balance needs one
manual visit to Circle's faucet or a configured
`WASIT_USDC_DISTRIBUTOR_SECRET`, because no scriptable testnet USDC faucet
exists for Stellar.

**Changed — core classifies its own wallet failures.** Every wallet function in
core now throws the taxonomy in `errors.ts` (`ConfigurationError`,
`TargetUnreachableError`) instead of leaking raw Stellar SDK errors, with
Horizon's result codes (`op_underfunded`, `op_no_trust`) folded into the
message. Callers render `error.message` and never inspect an SDK error type,
which is what stopped the CLI and the dashboard reporting the same failure two
different ways. Horizon and Friendbot requests are now bounded by a timeout;
previously a stalled request had no way back.

**Fixed — a malformed key in `.env` no longer kills the process.** A truncated
paste, a `G...` public key in a secret's slot, or a hex commitment seed in a
Stellar-secret slot reached `Keypair.fromSecret` unguarded. In the dashboard
that escaped as an unhandled rejection and terminated the process from under
Ink's renderer, leaving the wallet screen frozen on its loading spinner; from
`wasit wallet` it printed an SDK stack trace instead of the CLI's own error
contract. All three now report the offending variable by name and exit 2, and
the message never echoes the rejected value.

**Fixed — `wasit wallet status --role mpp-channel` is rejected up front.**
`COMMITMENT_SECRET_HEX` is a raw hex seed with no on-chain account, which the
help text and docs already said; the command accepted the role anyway and then
crashed deriving an address for it.

**Fixed — `.env` written by the dashboard is owner-only and atomic.** The
confirm-to-save flow wrote with Node's default permissions, which under a
typical umask produces a world-readable `0644` file holding Stellar secrets. It
is now written `0600` via a temp file and a rename, so an interrupted write
cannot truncate the file, and an existing world-readable `.env` is tightened on
the next write.

**Fixed — Friendbot no longer claims a transfer that did not happen.** A "this
account already exists" response is treated as success, correctly, but every
caller reported it as "Funded: 10,000 XLM." regardless.

**Added — releases are verified from a clean install.** `npm run
verify:clean-install` packs the three packages, installs the tarballs into an
empty project, and drives the result as a user would — the CLI's own binary and
the MCP server over stdio, with no keys and no target. Everything else in CI
runs against the working tree, where npm has deduplicated one dependency graph
across all three workspaces; that is not the tree an installer gets, which is
how `0.1.1` shipped without the `checks` subcommand its own docs described. Now
part of CI. See [#2](https://github.com/wasit-dev/Wasit/issues/2).

**Fixed — the MCP server reported the wrong version.** It announced `0.1.0` in
the initialize handshake through two releases, because the string was
hardcoded. It now reads the package's own manifest at runtime, the same way
`wasit --version` does, so a client cannot report a bug against a version that
was never published.

**Fixed — quitting the dashboard restores the terminal.** `q` called
`process.exit` directly, skipping Ink's unmount and leaving the cursor hidden.
Ctrl+C still exits 130 immediately, by design.

## [0.2.0] — 2026-09-04

All three packages. Adds a machine-readable surface to every check runner, and
brings each package's declared dependencies in line with what its code actually
imports.

| Package | Version |
|---|---|
| `@wasit-dev/core` | 0.1.1 → 0.2.0 |
| `@wasit-dev/cli` | 0.1.1 → 0.2.0 |
| `@wasit-dev/server` | 0.1.2 → 0.2.0 |

**Added — `wasit checks`.** Lists every check the tool can run, grouped by
protocol and annotated with the subcommand that runs it, plus flags for
negative, destructive and funds-spending checks. `--protocol` narrows it to one
suite. The catalogue behind it is exported from core as `CHECK_CATALOGUE` and
stays a short-form companion to `docs/CHECKS.md`, which remains the source of
truth for pass criteria and spec citations.

**Added — `--json` on every check runner.** `test`, `mpp-charge`, `mpp-channel`
and `checks` all take it. A run emits `outcome`, per-status counts, and a
`results` array carrying each check's id, name, status, detail, destructive
flag and — when a check could not run — its `errorKind`. Human-readable output
goes to stderr when `--json` is set, so stdout stays parseable.

**Changed — MCP `structuredContent` is now the same reshape as `--json`.**
`@wasit-dev/server` builds it from core's `toStructuredRun()` verbatim instead
of assembling its own object, so the CLI and an agent can no longer report the
same run in two different shapes. Anything parsing the old `structuredContent`
should re-read it: the field set is close, but it is no longer hand-built here.

**Changed — dependencies now match imports.** `@wasit-dev/core` dropped
`@x402/core`, `@x402/express`, `commander` and `dotenv` from its runtime
dependencies; none are imported by its source, and the first two are only used
by the bundled fixtures, which are not published. `express` moved in as a
devDependency — the x402 fixture imports it directly but it had never been
declared anywhere, resolving only because npm happened to hoist it from a
deeper transitive dependency. `@wasit-dev/cli` dropped `@stellar/mpp`,
`@stellar/stellar-sdk` and `mppx`, which it never imports, and its `commander`
and `dotenv` ranges now name the versions the code is actually built and
verified against rather than two majors behind.

**Known issue — a clean install still resolves two Stellar SDKs.**
`@stellar/mpp@0.7.1` declares the peers `@stellar/stellar-sdk@^15.1.0` and
`mppx@^0.6.29`; Wasit uses `^16.1.0` and `^0.8.14`, outside both ranges. A
fresh `npm install` satisfies that peer by nesting an older SDK alongside the
one Wasit uses, and that older SDK carries open axios advisories with no fix
available upstream. A repository checkout dedupes to a single SDK instead, so
`npm audit` reports differently depending on which tree you are in — meaning
the configuration Wasit is developed against is not the one its users get.
Being reported upstream; nothing in this release changes that chain.

## 2026-09-01 — READMEs

README only, no code changes. Each package now ships a `README.md`
(previously absent, so the npm listing page for all three was empty).
`@wasit-dev/cli` and `@wasit-dev/server` also pick up a fresh build — their
published `dist/` predated some already-merged source changes.

| Package | Version |
|---|---|
| `@wasit-dev/core` | 0.1.0 → 0.1.1 |
| `@wasit-dev/cli` | 0.1.0 → 0.1.1 |
| `@wasit-dev/server` | 0.1.1 → 0.1.2 |

## [0.1.1] — 2026-09-01

`@wasit-dev/server` only. `core` and `cli` are unchanged and stay at 0.1.0 —
only the package that actually changed gets a version bump.

Fixed: the `wasit://checks` MCP resource located `docs/CHECKS.md` by walking
up from the server's own installed location, which found it in a local git
checkout but not in an `npx @wasit-dev/server` install with no repo present.
The resource was silently absent rather than erroring. `docs/CHECKS.md` is
now copied into the package at publish time (a `prepack` script) and shipped
under `files`, so it resolves the same way whether Wasit is run from a
checkout or installed straight from npm. The four test tools were never
affected by this — only the check catalogue resource was.

## [0.1.0] — 2026-09-01

First public release. All three packages are now live on npm under the `@wasit-dev` organization.

| Package | Version | npm | What it is |
|---|---|---|---|
| `@wasit-dev/core` | 0.1.0 | https://www.npmjs.com/package/@wasit-dev/core | The check-suite library. x402 and MPP conformance logic, on-chain settlement verification, no CLI or MCP dependency of its own. |
| `@wasit-dev/cli` | 0.1.0 | https://www.npmjs.com/package/@wasit-dev/cli | The `wasit` command. Thin adapter over `@wasit-dev/core` for running checks from a terminal or CI. |
| `@wasit-dev/server` | 0.1.0 | https://www.npmjs.com/package/@wasit-dev/server | The `wasit-mcp` command. Exposes the same checks as MCP tools so an agent (Claude or otherwise) can run them directly. |

Anyone can now install and run Wasit without cloning the repository:

```bash
npm install -g @wasit-dev/cli
wasit test <target-url>
```

or wire the MCP server into an agent:

```bash
npx @wasit-dev/server
```

### What Wasit checks in this release

**x402.** Seven checks (`X402-01` through `X402-07`) covering the full flow: the 402 status itself, the payment header, its base64/JSON payload, the required fields inside that payload (version-aware, since v1 and v2 use different field names for price), the CAIP-2 network identifier, a real signed payment that must be accepted, and a deliberately corrupted signature that must be rejected. The two payment checks settle real testnet funds and are skipped automatically when no payer key is configured, or explicitly with `--read-only`.

**MPP, charge mode.** One check (`MPP-01`) that pays the target and then verifies the settlement independently on-chain, by reading the token contract's own CAP-46 `transfer` event via Stellar RPC rather than trusting the response the target returns. This catches a target whose response claims a payment succeeded when the on-chain event says otherwise.

**MPP, channel mode.** Five checks (`MPP-10`, `MPP-11`, `MPP-12`, `MPP-14`, and `MPP-13`). The first four are non-destructive: channel deployment and state, cumulative-commitment ordering, challenge replay rejection, and commitment replay rejection against a fresh challenge — the double-spend case the official client SDK cannot even express, since it always re-signs. `MPP-13` verifies that closing a channel actually settles on-chain and permanently ends the channel, so it is gated behind an explicit opt-in (`--allow-destructive` on the CLI, `WASIT_ALLOW_DESTRUCTIVE=1` on the MCP server) and refuses to run unless the operator names the exact channel being closed.

**Reporting.** Every run distinguishes four outcomes rather than a simple pass/fail: PASS, FAIL (the target answered and didn't conform), SKIP (a check that legitimately didn't apply, e.g. a destructive check that wasn't opted into), and ERROR (no verdict at all, because the target was unreachable or misconfigured — never treated as a finding about the target). CLI exit codes follow the same distinction: `0` clean, `1` at least one real conformance failure, `2` at least one check produced no verdict.

**Interfaces.** Both the CLI and the MCP server run the identical check code in `@wasit-dev/core`, so the two can never disagree about the same target. MCP exposes four tools: `wasit_x402_test`, `wasit_mpp_charge_test`, `wasit_mpp_channel_test` (non-destructive channel checks, with `MPP-13` reported as SKIP), and `wasit_mpp_channel_test_with_close` (registered only when destructive mode is explicitly enabled at server startup).

### Known gaps going into the next release

Two items from the original SOW scope are still open. A completion-summary/demo video has not been started. Third-party validation — at least one service outside this project actually running Wasit against itself with explicit authorization — is in progress via outreach to teams building on x402/MPP (RouteDock, stellarpay, stellar-pay), with no confirmed run back yet as of this release.

Two defects were found in the upstream `@stellar/mpp` SDK while building the channel-mode checks and were filed against `stellar/stellar-mpp-sdk`: issue #66 (channel-mode rejections collapse to one generic error instead of the SDK's own precise error taxonomy) and issue #67 (`feePayer.envelopeSigner` names the wrong concept and produces `[object Object]` on a mismatched key). Both are documented in `docs/findings/upstream-sdk.md`.
