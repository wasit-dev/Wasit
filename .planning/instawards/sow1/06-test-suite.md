# Job 06 — Automated Test Suite

Status: ✅ **DONE** (2026-09-04) · Not a SOW deliverable, but the weakest point
in the project as a technical artifact: a conformance test suite that had no
tests of its own is the first thing a reviewer notices.

## Goal
Give Wasit checks of its own, prove they are worth having, and run them in CI —
without requiring a testnet account, a funded key, or a live target service.

## Acceptance criteria
- [x] Runs entirely offline; no network, no keys, no target.
- [x] Covers the contracts that decide what Wasit reports, not just easy surface.
- [x] Every assertion mutation-checked rather than assumed useful.
- [x] Tests are type-checked, not only executed.
- [x] Both type-check and tests run in CI alongside the build.
- [x] No new runtime dependency.

## What happened

Before this, no package declared a `test` script, so the root `npm test` ran
`--if-present` and exited clean without executing anything, and CI only built.

**70 tests across five files**, using `node --test` with `tsx` — already a
devDependency, so nothing new at runtime. `errors.test.ts` pins the error
taxonomy, including that a malformed response is a *verdict* about the target
rather than an operational error, and that the transport code is lifted out of
Node's `.cause` chain without looping on a cyclic one. `check.test.ts` pins the
0/1/2 exit-code contract, the rule that a real finding outranks a missing one,
`SKIP` taking precedence over `ERROR`, and that a contradictory `pass: true` on
an errored result can never be laundered into a `PASS`. `network.test.ts` pins
the safety property that pubnet has no default RPC endpoint, so a mainnet run is
never silently pointed at a third party's node. `catalogue.test.ts` enforces the
catalogue's agreement with `docs/CHECKS.md`, which until now was maintained by
hand with nothing checking it.

The fifth file needed a small refactor first. Both MPP challenge readers did two
jobs in one function — an HTTP request, then the parsing rules — and only the
second half carries the conformance judgement. `parseChannelChallenge` and
`parseChargeChallenge` now take an already-decoded challenge; the fetch
functions keep their signatures and call them. No rule and no message changed.
The tests that became possible include one that matters more than it looks:
amounts are i128 base units, and a value past `Number.MAX_SAFE_INTEGER` is
asserted to survive parsing intact, so any future float conversion fails loudly.

**Mutation-checked, not assumed.** Inverting the exit-code precedence, swapping
`SKIP` ahead of `ERROR`, giving pubnet a default RPC endpoint, adding a
catalogue entry absent from `CHECKS.md`, demoting a malformed response to an
operational error, routing a channel amount through `Number()`, reparenting
`ChannelChallengeError` off `MalformedResponseError`, and reporting only the
first missing charge field each fail the suite. One mutation survived — dropping
the length guard in the charge reader — and it is an equivalent mutant: an empty
string is already rejected by the falsy check downstream.

**Wiring up the type-check paid for itself immediately.**
`packages/core/test/tsconfig.json` already existed with `noEmit` and full `test/`
coverage but had never been connected to a script, so it had never run. Running
it surfaced seven pre-existing type errors, none from the new tests: both MPP
fixtures cast the network env var wider than `@stellar/mpp` accepts (now
validated through `assertMppNetwork()` instead of a cast that lied); `express`
was imported with no `@types/express` declared anywhere, leaving its handlers
implicitly `any`; and `test/manual/run-mpp-11-12.ts` still passed a
`channelContract` option removed when the channel became resolvable from the
target's challenge, so it could no longer have run at all. That script was
deleted rather than repaired — it is superseded by `run-channel-checks.ts` and
the CLI.

## Result

70 tests green. `npm run typecheck -w packages/core` and `npm test` both run in
CI alongside the build. Commits: `e3610f4` (first suite, CI wiring, the seven
pre-existing type errors) and `2eead58` (parser split and coverage).

Closes [issue #1](https://github.com/wasit-dev/wasit/issues/1).

Known gap, deliberately left: `summarize([])` reports an empty run as
`conformant` with exit 0. The test characterises current behaviour rather than
endorsing it — whether a run with no checks should instead be `no-verdict` is a
behaviour change to decide separately.
