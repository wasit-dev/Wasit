# 2026-09-17 — Cross-check isolation run (0.4.0)

Two defects in Wasit itself, both in how a run reports what it established, and
the runs that prove they are fixed. Neither was found by a user: the first was
found by running the MCP server the way an agent actually uses it, and the
second by looking hard at a failure the first one produced.

Everything below ran against Wasit's own bundled fixture servers on Stellar
testnet, from a local build of the 0.4.0 tree. **Self-hosted, not third-party.**
This document does not bear on the SOW's third-party-authorization item.

---

## Defect 1 — a charge-mode payment client broke every later channel check

**Symptom.** `MPP-10`, `MPP-11`, `MPP-12` and `MPP-14` failed every time, but
only when an MPP charge or x402 check had already run in the same process. Run
first, the channel checks passed cleanly. The failure text was always identical:

```
No method found for challenges: stellar.channel. Available: stellar.charge
```

Raw `curl` against the channel fixture confirmed the fixture itself was
correct: it issued a well-formed `WWW-Authenticate` challenge with
`intent="channel"`.

**Cause.** `Mppx.create` replaces `globalThis.fetch` with a wrapper bound to one
payment method unless `polyfill: false` is passed
(`node_modules/mppx/dist/client/Mppx.js:29,48` →
`client/internal/Fetch.js:195`). `MPP-01` creates a charge client, so from that
point every 402 in the process was answered by a charge-only wrapper instead of
by the service under test. `fetchTarget` resolves `fetch` at call time, so every
channel check inherited it.

**Why it hid for so long.** Each CLI invocation is a fresh process, so the CLI
never showed it. The MCP server is one process answering many tool calls in a
row, which is exactly where it bites. Before this fix, **only the first
payment-mode check in an MCP session produced a trustworthy verdict.**

A second layer delayed the diagnosis: `packages/server/node_modules/` still held
a published copy of `@wasit-dev/core@0.2.0`, which Node resolved ahead of the
workspace symlink. The first attempted fix therefore appeared to have no effect,
because the file carrying it was never being executed. That copy was also
pinned in `package-lock.json`, so a clean install reproduced it.

**Fix.** Two parts, both needed.

1. `packages/core/src/mpp/charge.ts` passes `polyfill: false`.
2. `packages/core/src/errors.ts` gives `fetchTarget` a `baseFetch()` that walks
   past any wrapper tagged with mppx's own `Symbol.for("mppx.fetch.wrapper")`
   before using it. Part 1 alone is a promise to remember; part 2 is structural.

The stale nested copy was removed and its `package-lock.json` entry with it.

**Regression test.** `packages/core/test/unit/fetch-target-isolation.test.ts`
deliberately creates a charge client with `polyfill: true`, asserts that a bare
`globalThis.fetch` still fails with the original message, and then asserts that
`fetchTarget` reads the same 402 correctly. The first assertion matters as much
as the second: if mppx ever stops polyfilling, the test says so instead of
silently testing nothing.

---

## Defect 2 — a failed setup was reported as a defect in the target

**Symptom.** While diagnosing defect 1, two runners were left hitting the same
channel at once. `MPP-11` and `MPP-12` reported:

```
FAIL  MPP-11  Setup failed: a correctly advancing commitment (20000) was not
      accepted — HTTP 402 ... "Verification Failed"
```

**Cause.** `MPP-11`, `MPP-12` and `MPP-14` each need one correctly advancing
commitment accepted before they can probe anything. That commitment is built as
`cumulativeAmount + requestedAmount`, read from a freshly issued challenge. When
another payer advances the channel in between, the amount that was correct at
challenge time is stale at submission time and the server rejects it.

It was attempted once, and the refusal was reported as FAIL — a claim that the
target is non-conformant. But a target that wrongly rejects valid vouchers and a
channel somebody else is using produce exactly the same response, and nothing
observable from the client separates them.

**Fix.** `advanceCumulative()` in `packages/core/src/mpp/channel.ts` retries up
to three times, each against a freshly issued challenge, so the cumulative is
re-read every attempt and ordinary contention clears by itself. When all three
are refused it throws `CheckSetupError`, a new member of the taxonomy in
`errors.ts`, which surfaces as `ERROR` with `errorKind: "setup"` and exit code
`2` (`no-verdict`) rather than `1` (`non-conformant`). The detail carries all
three refusals verbatim and states both readings without choosing one.

The same change removed three duplicated setup blocks and a duplicated signing
path in `MPP-14`.

---

## Runs

### Offline

`npm run build`, `npm run typecheck -w packages/core` and `npm test` clean,
including the two new unit tests (`classifies a setup error as its own kind`,
`reports a setup failure as no verdict rather than as a defect`) and
`fetch-target-isolation.test.ts`.

### Setup failure, deterministic

A new fixture, `packages/core/test/fixtures/mpp-channel-refusing-server.ts`,
issues valid challenges and refuses every credential. It is not a conformance
target and exists only to make this reporting path reproducible on demand rather
than by racing two runs.

```
$ npx tsx packages/core/test/manual/run-channel-checks.ts http://localhost:3004/data
ERROR  MPP-11  Check could not run (setup): A correctly advancing commitment was
       refused 3 times, each one signed against a freshly issued challenge ...
       (attempt 1: 10000 refused with HTTP 402 ...; attempt 2: ...; attempt 3: ...)
ERROR  MPP-12  ...
ERROR  MPP-14  ...
0 passed, 0 failed, 3 no verdict, 0 skipped.
exit=2
```

The three attempts appear in the fixture's own log, nine refusals across the
three checks, which is what shows the retry is real rather than claimed.

### Channel checks, quiet channel, twice in a row

```
3 passed, 0 failed, 0 no verdict, 0 skipped.   exit=0
3 passed, 0 failed, 0 no verdict, 0 skipped.   exit=0
```

Re-runnability against a channel with arbitrary prior history is the property
the manual commitment helper exists to provide, so it is checked twice rather
than once.

### Deliberate contention

Two runners started together against the same channel, the condition that
produced defect 2:

```
3 passed, 0 failed, 0 no verdict, 0 skipped.
3 passed, 0 failed, 0 no verdict, 0 skipped.
```

Both recovered by retry. Before 0.4.0 this reliably produced FAIL.

### Charge then channel, one process

`packages/core/test/manual/charge-then-channel.ts` runs both suites in a single
process, the shape the MCP server has:

```
=== MPP charge mode ===
PASS  MPP-01  Settled on-chain for exactly the advertised 10000 base units ...
      tx d25b388a486e52242aefe8429c5d3d430d8fca96a81798910a49c3b1b9ed5466

=== MPP channel mode, same process ===
SKIP  MPP-10  expected on-chain parameters not supplied
PASS  MPP-11 / MPP-12 / MPP-14
SKIP  MPP-13  destructive
4 passed, 0 failed, 0 no verdict, 2 skipped.
```

This is the exact sequence that failed before the fix.

### CLI

x402 read-only 5/5 against `:3001/protected`; MPP charge 1/1 against
`:3002/data` (tx `6d2c02f029ee8e3c86bd78de43a9804a061e6e7da82ff9afdd3b4399b94d1308`);
MPP channel 3 passed, 2 skipped against `:3003/data`.

### From Claude Code over MCP

The same checks driven as MCP tool calls in one session, which is the shape
defect 1 broke:

1. `wasit_x402_test` on `:3001/protected`, read-only — conformant, 5/5.
2. `wasit_mpp_channel_test` on `:3003/data` — conformant, 3/3 non-skipped,
   `MPP-10` and `MPP-13` skipped as designed.
3. `wasit_mpp_charge_test` on `:3002/data` **followed immediately by**
   `wasit_mpp_channel_test` on `:3003/data` — charge conformant, settled as tx
   `4d63203ee46dfdd2b34d01fdf66099def766eedad1e048b08f10d0cac45c3603`; channel
   conformant, 3/3 non-skipped, in the same server process.

Step 3 is the reproduction case for defect 1 and it is now green.

Worth recording separately: before running the charge tool, the agent stopped
and flagged that the tool is not idempotent and would spend real testnet funds,
and asked for confirmation. That behaviour comes from the tool's own annotations
and description, which is what they are there for.

---

## Limits

Self-hosted fixtures throughout, on testnet. No third-party service was tested
and no operator was contacted, so **this document does not satisfy the SOW's
third-party-authorization item** and must not be presented as if it does.

The MCP session above ran against a local build of the 0.4.0 tree, not against
the published package. 0.4.0 has since been published for all three packages, so
the step that closes this gap is a registry parity run matching the practice in
`2026-09-06-npm-package-parity-run.md`. Until that run exists, nothing here
establishes that the published artifact behaves as this document describes.

`MPP-13` was skipped in every run recorded here. Nothing above establishes
anything about close settlement.
