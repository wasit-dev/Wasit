# Changelog

All notable changes to Wasit are recorded here. Versions follow [Semantic Versioning](https://semver.org/): patch releases are fixes, minor releases add checks or features without breaking existing usage, major releases break something.

## [Unreleased]

**Changed — `X402-04` and `X402-05` read every payment option, on any chain.**
Both read only `accepts[0]`, and `X402-05` accepted only `stellar:testnet` and
`stellar:pubnet`, so a conformant x402 service on another chain failed it, and
a challenge offering several networks was judged on whichever came first. Both
now check every option and name the one at fault by its index. `X402-05`
requires CAIP-2, as x402 v2 does, and applies each namespace's own rules where
its CAIP-2 definition fixes them: `stellar` is `testnet` or `pubnet`, `eip155`
is a base-10 chain id, `solana` is the first 32 characters of the base58
genesis hash. A well-formed id in another namespace passes, and the result says
only the format was checked. A challenge with no options now fails `X402-04`
with that reason instead of three missing fields.

**Changed — the payment checks pay only on the network the run names.** A
challenge offering several options is paid on the option for `--network`
(MCP: `network`), instead of the first option the client supports, which could
be the other Stellar network. A challenge with no option on that network, or
only one in a scheme other than `exact`, gets `X402-06` and `X402-07` skipped
with the networks it offers; nothing is sent. A `--network` other than
`stellar:testnet` or `stellar:pubnet`, or pubnet without `--rpc-url`, now stops
the run at preflight, before any payment, rather than after paying with no way
to verify the settlement.

**Added — every failure says what to change.** A FAIL now carries a `Fix`
line and a `Docs` link, in the CLI's text output, in `--json` and in the MCP
server's `structuredContent` (`fix`, `docs`). Where a check can tell the cause,
the fix is specific to it: `eip155:0x14a34` is told to write `eip155:84532`, a
200 on an unpaid request is told to put the payment middleware in front of the
route, a missing `PAYMENT-RESPONSE` is told what to return. Otherwise it is the
check's general fix, now part of every catalogue entry (`fix`). Only a FAIL
carries one; a skip or a no-verdict is not a defect. New in core: `fixFor()`,
`catalogueEntry()`, `docsUrlFor()`, and an optional `hint` on `CheckResult`.
The check catalogue gains "Common failures and fixes"
(`/docs/checks/common-failures`): the failures builders hit most, by check, with
the reasoning, the CAIP-2 ids of common networks, and links to where each was
met in a real implementation.

**Changed — `X402-04` checks every field the advertised version requires.**
It checked three: the price, `network` and `payTo`. x402 v2 requires `scheme`,
`network`, `amount`, `asset`, `payTo` and `maxTimeoutSeconds` in every option;
v1 also requires `resource` and `description`. A field present with the wrong
type, such as a numeric `amount` or a `maxTimeoutSeconds` that is not a positive
number, is reported as such instead of as missing. Challenges built with the
official x402 server SDK carry every field, so they are unaffected.

**Added — the x402 payment checks pay on Base Sepolia.** `--network
eip155:84532` (MCP: `network`) runs `X402-06` and `X402-07` there, with the payer key
in `EVM_PRIVATE_KEY`. Payment uses the `exact` scheme's EIP-3009 method, so the
facilitator pays the gas and a payer needs Base Sepolia USDC and no ETH. `X402-06`
holds the settlement to the receipt's ERC-20 `Transfer` log by the Stellar rules;
`X402-07` forges only the payer's signature. Both EVM transfer methods are paid:
EIP-3009, and Permit2 with its approval signed as a gas-sponsored EIP-2612 permit
(a Permit2 target without sponsoring, where the payer never approved Permit2, is
`ERROR (setup)`, not a failure). Against Wasit's own Base Sepolia fixtures, both
methods pass with `X402-06` settled on-chain and the payer holding no ETH; against `wasit serve` posing on Base
Sepolia, the lying modes fail both checks
([evidence](docs/evidence/2026-10-05-base-sepolia-verification-run.md)). Stellar stays
the default; MPP is Stellar only. Under the hood, the payment checks now go through a
per-chain adapter, and the x402 SDK moves from 2.19 to 2.28.

**Added — the x402 payment checks pay on Ethereum Sepolia.** `--network
eip155:11155111` runs `X402-06` to `X402-10` there with the same `EVM_PRIVATE_KEY`,
paying in Circle's Sepolia USDC through EIP-3009, so the payer needs no ETH. The SDK
ships no default asset for this network, and its client's spend controls refuse other
assets: Wasit allows Circle's Sepolia USDC there, with the SDK's own $1 cap. The wait
for a settled transaction is now per network: 10 blocks on Sepolia, whose blocks are 12
seconds apart. No public facilitator settles Ethereum Sepolia, so Wasit's own fixture
runs the SDK's facilitator itself. Against it, all ten pass with the settlement read back
independently; against `wasit serve` there, the lying modes fail
([evidence](docs/evidence/2026-10-06-ethereum-sepolia-verification-run.md)). BNB Smart
Chain testnet stays read-only.

**Added — the x402 payment checks pay on Solana devnet.** `--network
solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (MCP: `network`) runs `X402-06` to `X402-10`
there, with the payer key in `SVM_PRIVATE_KEY` (base58 of the 64-byte keypair, as
wallets export it). The payer signs a transaction with one `TransferChecked`, and the
facilitator signs as fee payer, so a payer needs devnet USDC and no SOL. `X402-06` holds
the settlement to the confirmed transaction's token balances: exactly one transfer, of
the advertised amount and mint, to an account `payTo` owns, from this run's payer.
`X402-07` forges only the payer's signature; `X402-10` builds the payment on a blockhash
the RPC confirms has expired, since on Solana the blockhash, not `maxTimeoutSeconds`,
sets a payment's lifetime. Against Wasit's own Solana fixture, all ten pass with the
settlement read back independently and the payer holding no SOL; against `wasit serve`
on devnet, the lying modes fail
([evidence](docs/evidence/2026-10-05-solana-devnet-verification-run.md)). The payee's
token account must exist before the payment. Library users with TypeScript 6 or 7 see
npm peer warnings from `@solana/kit` 5 at install; the install succeeds and core runs.

**Added — three negative payment checks: `X402-08` Payment Replay Rejected, `X402-09`
Underpayment Rejected, `X402-10` Expired Authorization Rejected.** Each sends a payment the
target must refuse: the exact payment `X402-06` was accepted for, sent again; a validly
signed payment for half the price that still claims the full price; and a payment signed
with a one-second lifetime, sent once it has expired (on Solana, one built on an expired
blockhash). They run on Stellar, Base Sepolia and Solana devnet. A refusal now shows the
target's stated reason, when it gives one. Against Wasit's own fixtures all three pass on
all three chains, refused for the reason each is about
(`invalid_exact_stellar_payload_wrong_amount`, `invalid_exact_evm_payload_authorization_value_mismatch`,
`invalid_exact_evm_payload_authorization_valid_before`, `invalid_exact_svm_payload_amount_mismatch`,
...); against `wasit serve --mode no-settle` all three fail. `X402-08` is skipped when the challenge advertises the
`payment-identifier` extension, whose cached replies are legitimate. The catalogue grows
from 13 to 16 checks. `X402-10` waits about 20 seconds on Stellar for the authorization
to expire.

**Changed — the negative payment checks need an accepted baseline.** When the target
refuses `X402-06`'s valid payment, `X402-07` to `X402-10` are skipped rather than passed:
a target that refuses everything proves nothing by refusing a bad payment. `X402-07` used
to pass in that case.

**Changed — a price the official client will not pay gets no verdict.** The official x402
client, which Wasit pays through, pays only the SDK's default assets and at most $1 a
payment. A target above that used to get `X402-06` ERROR (harness) with the SDK's own
configuration advice; it now gets `ERROR (setup)` naming the price or the asset, and
nothing is sent. Wasit keeps the cap: it pays automatically, and on `stellar:pubnet`
with real money.

**Fixed — a failed settlement names its reason.** A valid payment that verified but did
not settle read `got 402.`. The official SDK server reports why in a `PAYMENT-RESPONSE`
with `success: false`, which Wasit now reads: `got 402 (settlement failed:
invalid_exact_evm_transaction_failed)`. The same reason now shows on refused negative
payments, which is how the public facilitator was seen refusing a replay at settlement
rather than at verify.

**Changed — a payer that cannot cover the price gets no verdict.** `X402-06` reads the
payer's balance of the advertised asset before it signs; below the price, it reports
`ERROR (setup)` naming the key to fund, sends nothing, and skips `X402-07`–`10`. An
unfunded payer used to fail `X402-06` on Solana devnet, for a reason real defects give
too, and to stop on Stellar with only the token's error code. A balance that cannot be
read pays as before. Measured on all three chains with fresh payers
([evidence](docs/evidence/2026-10-05-payer-balance-check-run.md)).

**Changed — a payer key for the wrong chain, or a malformed one, stops the run at
preflight.** It used to surface mid-payment as a harness error. The message never
echoes the key.

**Added — `wasit serve`, a paywall that misbehaves on purpose.** The checks
test a service that sells; this tests an agent that pays. It runs a local x402
paywall in one of four modes: `no-settle` serves without settling,
`wrong-settlement` cites a transaction that is not the payment, `wrong-network`
asks for mainnet, `overprice` asks for one million USDC. The server reports
what the agent did. It never settles or forwards anything, so no funds move.
Every mode's challenge is well-formed (`wasit test --read-only` passes it), and
the two settlement modes reproduce the servers built for the 0.6.0 A/B:
`X402-06` and `X402-07` fail against them. `--network eip155:84532` poses the same
modes on Base Sepolia, and `--network solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` on Solana
devnet. Two more modes are about the challenge: `v1-challenge` sends only an x402 v1
challenge (Base Sepolia and Solana devnet; v1 names no Stellar network), and
`malformed-header` a `PAYMENT-REQUIRED` header that does not decode; both answer a
payment with 402 and log which header it came in. The official SDK client pays the
first as v1 and refuses the second without paying
([evidence](docs/evidence/2026-10-05-wallet-network-and-serve-modes-run.md)).

**Added — `wasit wallet --network` for the Base Sepolia and Solana devnet payers.**
`wasit wallet create --role x402 --network eip155:84532` (or Solana devnet) generates the
payer key in the form the payment checks read and prints its `.env` line and the
address to fund at faucet.circle.com; `status --network` shows that payer's USDC
balance, and `fund --network` prints the faucet step, since the payer needs nothing
else. Testnets only; the MPP roles stay on Stellar. The dashboard's environment panel
lists `EVM_PRIVATE_KEY` and `SVM_PRIVATE_KEY`.

**Changed — the CLI's payment warning says when it applies.** It said funds
would move before every payment run, including runs where the target offered
no option on the run's network and nothing was paid.

**Results can change on upgrade.** A service on a chain other than Stellar now
passes `X402-05` where it failed. A challenge with a broken second option now
fails `X402-04` or `X402-05` where it passed. A challenge without `scheme`,
`asset` or `maxTimeoutSeconds`, or with a wrongly typed field, now fails
`X402-04`. A target that accepts replayed, underpaid or expired payments now fails
`X402-08`, `X402-09` or `X402-10`; one that refuses even a valid payment now gets
`X402-07` skipped instead of passed.

## [0.6.0] — 2026-09-30

All three packages, versioned together as usual. The two x402 payment checks
now prove what their names say: `X402-06` verifies the settlement on-chain, and
`X402-07` forges only the signature. `MPP-01` reads the newer form of the
transfer event and stops blaming a target for a slow RPC. Node.js 22 is
supported. No check was added or removed.

**Results can change on upgrade.** A target that serves without settling,
reports a transaction that is not its settlement, or answers without a
`PAYMENT-RESPONSE` header now fails `X402-06`. A target that decodes a payment
without verifying its signature, or accepts a forged one with 201 or 204, now
fails `X402-07`. In the other direction, an MPP payment to a muxed recipient no
longer fails `MPP-01`, and an RPC that stops advancing now gives no verdict
instead of a FAIL. Against Stellar's official reference paywall
(`stellar/x402-stellar`), this build passes 7/7, with `X402-06` verified
on-chain.

**Changed — `X402-06` verifies settlement on-chain.** It passed
on any 2xx, which established that the target served the resource, not that
the payment landed. It now reads the settlement from the `PAYMENT-RESPONSE`
header and holds the reported transaction to the advertised terms on Stellar
RPC, as `MPP-01` does: one `transfer` from this run's payer to `payTo`, for
`amount` of `asset`. A target that serves without settling, or reports a
transaction that is not its settlement, now fails; against a server built to
do exactly that, 0.5.0 passed and this build fails both variants. A
`settlement_pending` response is reconciled on chain, as the spec directs.
`wasit test` gains `--rpc-url`, and the MCP tool `rpcUrl`. Settlement
verification moved to a shared module so both checks apply identical rules.
If a run goes red on upgrade, the check got stronger, not the service worse.

**Fixed — `X402-07` corrupts only the signature.** It
overwrote the tail of the base64 envelope, which broke XDR decoding, so a
target that decoded the envelope and never verified the signature still
refused it and passed. It now flips one byte of the client's Soroban
authorization-entry signature and leaves the rest of the transaction intact.
Against a server that decodes but never verifies, 0.5.0 passed and this build
fails; the `x402.org` facilitator now rejects at simulation
(`…_simulation_failed`) rather than at decoding (`…_malformed`). Acceptance is
now any 2xx, not only 200, so a target that answers 201 or 204 to a forged
payment no longer passes. Two offline tests, each mutation-checked.

**Fixed — `MPP-01` reads CAP-67 transfer events.** Since CAP-67,
a SEP-41 `transfer` to a muxed address (`M...`) emits its data as a map
`{ amount, to_muxed_id }` instead of a bare `i128`, with the base address in
the topic. `MPP-01` read only the bare form, so a settlement to a muxed
recipient would have been reported as no transfer at all. It now reads both,
and matches an advertised muxed recipient on the base account and the id.
Verified against a real testnet transfer to a muxed address; seven offline
tests, each mutation-checked. Checking this end to end also showed that the
official `@stellar/mpp` charge server cannot verify a payment to a muxed
recipient either (its verification throws on the same map), so no MPP service
built on it can accept one today.

**Fixed — `MPP-01` no longer blames the target for a slow RPC.**
It gave RPC twelve seconds to show the settled transaction, then reported it
as never broadcast. On a lagging RPC that is a FAIL against a target that did
nothing wrong. The wait is now measured in ledgers: the transaction is reported
missing only once RPC has closed ten more ledgers without it, and an RPC that
stops advancing gives no verdict (`ERROR (harness)`) instead of a FAIL. Four
offline tests, each mutation-checked.

**Fixed — `MPP-01` no longer says it paid when the target refused.**
When the target answered with an error instead of the resource, the FAIL read
"Paid the advertised … base units", although a target that refuses may never
broadcast the transaction, and in the run that found this none was. The
verdict is unchanged; the wording now claims only that a payment was
submitted.

**Changed — Node.js 22 is supported.** All three packages now declare
`"node": ">=22"` instead of `>=24`. Nothing required 24: the full test suite,
the CLI, the MCP server and a run against the fixtures all pass on Node 22,
and no runtime dependency requires more. Node 22 is still a maintained LTS, and
CI environments such as the official MPP SDK's run on it. CI now tests the
packages on both Node 22 and Node 24.

**Fixed — `wasit wallet status --role <role>` exits 2 when it could
not check that role.** It exited 0 on an unreadable key, so
`wasit wallet status --role x402 && deploy` went ahead on a key that was never
checked, although `docs/guides/cli.md` already said a malformed key exits 2. With
`--role` it now exits 2 whenever the role could not be checked: key not set,
unreadable, or its balance lookup failed. An unfunded account is an answer and
exits 0. Without `--role`, one unchecked role stays a row and the command exits
0. Three offline tests, each mutation-checked.

**Added, repository only — `scripts/run-all.sh`.** Starts the fixtures if they
are not already up, runs the x402, MPP charge and MPP channel suites, prints one
summary and stops the fixtures it started. Free checks by default; `--full` adds
the checks that move testnet funds, and `--npm` runs the published CLI. Not
part of any npm package.

## [0.5.0] — 2026-09-28

All three packages, versioned together as usual. Two reporting fixes found by
running Wasit against code it did not write, and one addition that brings the
MCP server level with the CLI. No check was added or removed.

**Results can change on upgrade**, in two situations only: a target that issues
an x402 v1 challenge (see below), and an MPP channel target that refuses a
replay with a status other than 402 and 2xx, whose FAIL no longer calls it a
double-spend. Against a conformant v2 target nothing changes: Wasit's own x402
fixture passes 7/7 with this build, as it did with 0.4.0.

**Fixed — `MPP-12` and `MPP-14` no longer call a refused replay a
double-spend.** Both reported any non-402 response as "accepted twice ... This
is a double-spend." The official SDK's channel server on `main` refuses replays
with HTTP 500, so the check claimed a double-spend while the server had in fact
refused. The verdict stays FAIL, since the required status is 402, but the
double-spend wording now appears only for a 2xx. Found running against the
SDK's own example servers; see
`docs/evidence/2026-09-24-official-sdk-reference-run.md`.

**Added — `wasit_x402_test` accepts `method`, `body` and `headers`.** The
CLI's `--method`, `--body` and `--header` have existed since 0.1.0, but the MCP
tool could only send a `GET`, so an agent could not test a paid `POST`
endpoint at all. The same request shape is applied to every probe, including
`X402-06` and `X402-07`. A body sent with `GET` or `HEAD` is refused as a
configuration error. Header values travel through the agent's transcript, which
the tool description and `docs/guides/mcp.md` say plainly.

**Fixed — an x402 v1 challenge is read, and an unpayable challenge no longer
fails the payment checks.** Run with the operator's written authorization
against a service that speaks x402 v1, 0.4.0 reported `X402-02` FAIL, skipped
`X402-03`–`05`, and reported `X402-06` and `X402-07` as FAIL although no payment
was ever built or sent, so `X402-07` read as a corrupted signature that was not
rejected. `docs/CHECKS.md` already said a challenge that cannot be read has no
verdict. Now `X402-02` still fails, because the `exact` scheme on Stellar is
defined for v2 only, but says a v1 challenge was found in the body;
`X402-03`–`05` inspect that body; and `X402-06`/`X402-07` are skipped with the
reason. The same skip applies to any challenge the payment client cannot read.
Seven offline tests, each mutation-checked.

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
