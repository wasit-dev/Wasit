# The Error Model

A protocol-compliance tester makes claims about someone else's service. The most
damaging thing it can do is make a claim it has no basis for.

"Your service returned the wrong status code" and "we could not reach your
service" are different statements. Reporting the second as the first tells an
operator their service is broken when it may be perfectly correct, and they will
spend real time chasing it. So the two are reported separately, and the
distinction runs all the way down to the exit code.

## Four statuses

**PASS** — the check ran and the target conformed.

**FAIL** — the check ran and the target did not conform. The service answered,
and what it answered violated the spec: wrong status, unparseable challenge,
missing fields, a settlement that moved the wrong amount. This is a statement
about the target.

**ERROR** — no verdict was produced. Sub-classified as `unreachable` (no HTTP
conversation took place), `configuration` (the run is set up wrongly), `setup`
(a precondition the check needed could not be established), or `harness` (Wasit
or a dependency failed). **An ERROR is never a statement about the target's
conformance.**

**SKIP** — the check did not run, for a stated reason: a destructive check
without opt-in, missing expected parameters, or a dependency on an earlier check
that failed.

## Exit codes

| Code | Condition |
|---|---|
| `0` | Everything that ran conformed |
| `1` | At least one conformance failure |
| `2` | At least one check produced no verdict |

Both present exits `1` — a real finding outranks a missing one. Skips never
affect the code.

## Errors are classified where they are thrown

Third-party throw sites have no documented error types. Node's `fetch` reports
every transport failure as `TypeError: fetch failed` and hangs the real code off
`.cause`; the mppx challenge parser and the Stellar SDK throw plain errors.
Sniffing at the catch site would be guesswork.

So the call site wraps instead: it knows what it was attempting, and throws
`TargetUnreachableError`, `ConfigurationError`, or `MalformedResponseError`
accordingly. `fetchTarget()` replaces bare `fetch` for anything addressed at the
service under test, so a connection failure can never be mistaken for a bad
response.

A malformed response is deliberately **not** an error. The target answered; the
answer was wrong. That is a finding.

## When a precondition cannot be established

`MPP-11`, `MPP-12` and `MPP-14` cannot probe anything until one correctly
advancing commitment has been accepted. Each of them therefore submits one
first, and for a long time a refusal of that submission was reported as FAIL.

That was the same mistake this document exists to prevent, one level deeper.
Two very different worlds refuse that submission identically: a target that
wrongly rejects valid vouchers, which is a defect, and a channel whose
cumulative moved between the challenge being issued and the credential being
submitted, because another payer is using it, which is nothing at all. Nothing
observable from the client distinguishes them.

The submission is now retried up to three times, each against a freshly issued
challenge, so the cumulative is re-read every time and ordinary contention
clears by itself. When every attempt is refused, the result is `setup`, carrying
all three refusals verbatim and saying plainly that either reading is possible
and that a re-run against a quiet channel is what tells them apart. Retrying
does not hide a target that always refuses: that target reproduces on all three.

## State one check leaves behind for the next

A check must observe the target, never the leftovers of an earlier check in the
same process.

`Mppx.create` replaces `globalThis.fetch` with a wrapper bound to a single
payment method unless `polyfill: false` is passed. Once `MPP-01` built a charge
client, every later channel-mode 402 in that process was refused by that wrapper
rather than by the service, and reported as a defect in a target that was in
fact conformant. The CLI never showed it, because each invocation is a fresh
process. The MCP server did, because one process answers many tool calls in a
row, so only the first payment-mode check in a session produced a trustworthy
verdict.

Passing `polyfill: false` at the call site is necessary and not sufficient: one
stale build or one new caller brings the leak back silently. So `fetchTarget()`
resolves the underlying fetch through mppx's own
`Symbol.for("mppx.fetch.wrapper")` tag before using it. The guard is structural
rather than a promise to remember.

## Cascading failures

The read-only x402 checks inspect progressively deeper parts of one challenge:
the status, then the header, then its payload, then the fields inside it. When
one fails, the ones after it have nothing left to inspect.

Reporting those as failures produced five findings from one cause. A target
answering 404 is not five times broken. They are now skipped, each naming the
cause it depended on. The same applies to the payment checks: when `X402-06`
cannot exercise the payment flow at all, `X402-07` is skipped rather than
credited with a rejection it never observed.

That last case was a live bug. `X402-07` treated any thrown error as proof that
a corrupted signature had been rejected — so an unreachable host made a security
check pass.

## PREFLIGHT

An invalid target URL or network identifier is wrong for every check in a suite.
Reporting it per check buries one real cause under N identical copies, so it is
emitted once as `PREFLIGHT` and no check runs.

`PREFLIGHT` is not a check. It has no spec reference and no row in the
catalogue.
