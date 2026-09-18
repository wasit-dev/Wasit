# Wasit Check Catalogue

Every check below MUST reference a spec clause. If a check cannot be traced
back to a written clause of the spec, it is out of scope for Wasit by
construction.

Spec baseline in effect: x402 v2 (per latest commit of
`stellar/x402-stellar`, as of 2026-07-25). This version MUST be recorded
in every test report.

## x402

| ID | Check Name | Spec Reference | What It Checks | Pass Criteria |
|---|---|---|---|---|
| `X402-01` | 402 Response Status | x402 spec, HTTP semantics | An unpaid request must be answered with status code `402` | Response status is exactly `402`, not `401`/`403`/other |
| `X402-02` | Payment Header Present | x402 built-on-stellar guide | The 402 response must include a payment header | Either `PAYMENT-REQUIRED` or `X-Payment` header is present (both are checked — the spec itself is not yet consistent, see note in README) |
| `X402-03` | Header Payload Decodable | x402 spec §payment-required-object | The header value must be valid base64 that decodes to JSON | `atob()` + `JSON.parse()` succeed without error |
| `X402-04` | Required Fields Present | x402 spec §payment-required-object | The payload must include the core payment terms, under the field names its own advertised version requires | `network` and `payTo` are present and non-empty, and the price field matches the advertised `x402Version`: `maxAmountRequired` for v1, `amount` for v2 (renamed in v2, which also drops the embedded resource object). The version is read from the challenge rather than accepting whichever name happens to appear, because a service advertising `x402Version: 2` while emitting the v1 field name is not conformant to the version it claims — and reporting that as a merely absent price would hide the actual defect. An unrecognised version fails: the field names cannot be checked against a version whose schema is unknown. |
| `X402-05` | Network Identifier Valid | x402 built-on-stellar guide | Network id format follows CAIP-2 | Matches the pattern `stellar:testnet` or `stellar:pubnet` |
| `X402-06` | Signature Resubmit Accepted | x402 spec §payment-flow | A resubmitted request carrying a valid signature must be accepted | Response is no longer 402; a 2xx returns the original resource. The challenge is re-read immediately before signing, so the payment answers a challenge the target issued just now rather than a stale one. **Settles a real payment** — see the cost note below. This check does not verify the settlement on-chain: it establishes that the target accepted the payment, not that the payment landed. Only `MPP-01` reads the token contract's transfer event today; extending that to `X402-06` is tracked for 0.5.0. |
| `X402-07` | Invalid Signature Rejected *(negative)* | x402 spec §payment-flow | A deliberately corrupted signature must be REJECTED | The target answers with any status other than 200. Rejection is established only by an answer: a target that cannot be reached, or whose challenge cannot be read, produces no verdict and is reported as ERROR or SKIP. Treating a thrown error as proof of rejection would let an unreachable host pass a security check. The payload is corrupted **after** signing, by overwriting the tail of the base64-encoded envelope. Measured against the reference facilitator in [stellar/x402-stellar](https://github.com/stellar/x402-stellar) on 2026-09-06, the rejection is reached at XDR decoding rather than at signature verification: the substitution drops the base64 padding and so lengthens the decoded envelope by two bytes, which no longer parses. The check therefore establishes that the target refuses a payment it cannot validate — it does not, on its own, establish that signature verification runs at all. A target that parsed the envelope and skipped verification would still pass. Corrupting only the signature bytes while preserving a decodable envelope is tracked for 0.5.0. |

**Note on the x402 payment checks' cost (Week 2).** `X402-06` and `X402-07`
are not free. `X402-06` settles a real payment against the target, and `X402-07`
attempts one with a corrupted signature; both move or risk moving testnet funds
from the payer key, and repeated runs spend repeatedly. Like `MPP-01` this is
inherent rather than an implementation choice — a payment flow that was never
exercised cannot be verified. `X402-01` through `X402-05` read the challenge
only and cost nothing; `--read-only` (CLI) or `readOnly: true` (MCP) restricts a
run to those. The payment checks are also skipped entirely when no payer key is
present, so the default posture is the cheap one.

**Note on cascading failures (Week 2).** The read-only checks inspect
progressively deeper parts of one challenge: the status, then the header, then
its payload, then the fields inside it. When one fails, the checks after it have
nothing left to inspect, and they are **skipped rather than failed**. A target
answering 404 produces one finding, not five. The same applies across the
payment checks: when `X402-06` cannot exercise the payment flow at all,
`X402-07` is skipped rather than credited with a rejection it never observed.

## MPP — Charge Mode

| ID | Check Name | Spec Reference | What It Checks | Pass Criteria |
|---|---|---|---|---|
| `MPP-01` | Charge Settlement On-Chain | MPP Charge Guide; CAP-46 transfer events | The charge settles on-chain for exactly what the target advertised | The target's own 402 challenge is read first, unpaid, capturing the advertised `amount` (base units), `currency` and `recipient`. After payment, Stellar RPC `getTransaction` confirms the transaction referenced by the `Payment-Receipt` header succeeded, and its CAP-46 `transfer` contract event shows exactly one balance change: the advertised amount, to the advertised recipient, emitted by the advertised token contract, sent from this run's own payer. Verifying the **event** rather than the transaction envelope means a token contract whose `transfer` moves a different amount than its arguments claim is still caught. Verifying the **sender** means a target cannot satisfy the check by referencing some pre-existing transaction it did not cause. Verified against `@stellar/mpp@0.7.1` — mode `"pull"` (default): `onProgress` only fires through `"signed"`, so the settled tx reference comes from `Payment-Receipt`, not `onProgress`. |

**Note on MPP-01's cost (Week 2).** MPP-01 is **not** destructive: nothing is
permanently ended and the check can be run again. But it is not free and not
idempotent — every run settles a real payment from the payer key and moves
testnet funds, and repeated runs spend repeatedly. This is inherent to the check
rather than an implementation choice: charge mode has no dry-run, and a
settlement that did not happen cannot be verified on-chain. Both front ends say
so before running, and the MCP tool declares `idempotentHint: false`.

Settlement is read from Stellar RPC rather than Horizon, so the same endpoint
serves every MPP check and `--rpc-url` applies uniformly. The tradeoff is
retention: RPC keeps only recent history, so MPP-01 must verify a settlement it
just triggered, not an arbitrary past one. That matches how the check is used —
it pays, then verifies what it paid.

## MPP — Channel Mode

Verified against `@stellar/mpp@0.7.1`, `mppx@0.8.14`, `@stellar/stellar-sdk@16.1.0`.

`MPP-11`, `MPP-12` and `MPP-14` share one precondition: each must first get a
correctly advancing commitment accepted, so that the probe which follows differs
from it in exactly the one respect the check is about. The commitment is built
as `cumulativeAmount + requestedAmount` read from a freshly issued challenge,
which is what makes these checks re-runnable against a channel with any prior
history. If that submission is refused, it is retried up to three times, each
against a new challenge; when all three are refused the check reports
`ERROR (setup)` and not FAIL, because a target that wrongly rejects valid
vouchers and a channel another payer is advancing mid-run are indistinguishable
from the client side. See
[design/error-model.md](design/error-model.md).

| ID | Check Name | Destructive | Spec Reference | What It Checks | Pass Criteria |
|---|---|---|---|---|---|
| `MPP-10` | Channel Deploy | no | MPP Channel Guide | The channel contract deploys correctly, and is the same channel the target bills through | Contract address is valid and its state is queryable via `getChannelState()`, matching the parameters it was opened with (`token`, `from`, `to`, `refundWaitingPeriod`). The channel inspected is the one the target advertises in its 402 challenge, so MPP-10 and MPP-11/12/13/14 always report on the same contract. `--channel` (env `CHANNEL_CONTRACT`) **asserts** an expected address rather than selecting one: when it differs from the advertised channel the check fails and inspects nothing, because a run that reported on both would be reporting on two contracts at once. If the challenge cannot be read at all, an explicitly named channel is still inspected and the result is marked unverified against the target. |
| `MPP-11` | Cumulative Commitment Ordering | no | MPP Channel Guide §closing-the-channel; `@stellar/mpp` channel server (`cumulativeMonotonicityError`) | Both ordering rules: a commitment must exceed the stored cumulative, and must cover the price of the current request | Two probes, each rejected with HTTP 402: one committing exactly the stored cumulative, one advancing but falling short of `cumulative + price`. Each probe uses a **fresh challenge**, so the earlier-running challenge replay guard cannot fire and be mistaken for ordering enforcement. The second probe is reported as not-probed when the price is 1 base unit, since it collapses into the first. |
| `MPP-12` | Challenge Replay Rejection *(negative)* | no | MPP Channel Guide §closing-the-channel; `@stellar/mpp` channel server (atomic compare-and-set on challenge ID) | A byte-identical credential resubmitted against the same challenge must be rejected | HTTP 402 on the second submission. Isolation: the replayed credential is identical to one the server accepted moments earlier, so its signature and amount are already proven valid and only the challenge-ID claim can explain the rejection. |
| `MPP-14` | Commitment Replay Rejection *(negative)* | no | MPP Channel Guide §closing-the-channel; `@stellar/mpp` channel server (`cumulativeMonotonicityError`) | A captured `(amount, signature)` pair must not be redeemable against a **new** challenge | HTTP 402 when a previously accepted commitment is re-presented under a fresh challenge. This is the realistic double-spend: the challenge replay guard cannot help because the challenge ID is new, so only the cumulative rule stands in the way. The official client SDK cannot express this probe — it re-signs on every call. |
| `MPP-13` | Close Settlement | **yes** | MPP Channel Guide §closing-the-channel | Closing with the highest commitment settles on-chain | Server accepts the `close` credential (HTTP 200), then RPC confirms settlement: `closeEffectiveAtLedger` moves from `null` to a ledger sequence, and the contract's `withdrawn` getter equals exactly the committed amount. The channel balance is **not** asserted — `close()` pays the commitment to the recipient and then auto-refunds the remainder to the funder, so a closed channel always ends at zero. `withdrawn` is written in the same call that transfers the payout, and that transfer is non-fallible, so a mismatch would have reverted the whole close. **Running this permanently ends the channel** — skipped unless destructive checks are explicitly enabled, and it refuses to run unless the operator names the channel and the target's challenge advertises that same address. |

---

**Reporting semantics (Week 2).** Beyond PASS and SKIP, a run distinguishes two
further outcomes, because "your service is broken" and "we never reached your
service" are not the same claim:

- **FAIL** — the target answered, and the answer did not conform. This includes
  a response that arrives but violates the spec: wrong status, unparseable
  challenge, missing `channel`/`amount`, non-numeric amounts.
- **ERROR** — no verdict was produced about the target at all. Either it could
  not be reached (`unreachable`), or the run is misconfigured
  (`configuration`), or a precondition the check needed could not be
  established (`setup`), or the harness itself failed (`harness`). An ERROR is
  never a statement about the target's conformance.

  `setup` exists because MPP-11, MPP-12 and MPP-14 must each get one correctly
  advancing commitment accepted before they can probe anything. That submission
  is retried three times, each against a freshly issued challenge, so a channel
  another payer is advancing mid-run recovers on its own. When all three are
  refused the run reports `setup` rather than FAIL, because a target that
  refuses valid vouchers and a channel in concurrent use are indistinguishable
  from the client side, and only one of them is a defect.

Exit codes follow from that: `0` every check conformed, `1` at least one
conformance failure, `2` at least one check produced no verdict. A run with
both exits `1`, because a real finding outranks a missing one.

`PREFLIGHT` is **not a check** and carries no spec reference, which is why it
has no row above. It is a single diagnostic emitted when the target URL or the
network identifier is invalid — both are wrong for every check in the suite, so
they are reported once rather than repeated identically per check. When
preflight fails, no check runs.

**Note on interfaces and access paths (Week 2).** The catalogue is exercised by
two interfaces over one core: the `wasit` CLI and the `wasit-mcp` MCP server.
Both run identical check code against the same suite functions, so the two can
never disagree about the same target. Every check in this catalogue is
reachable from both: `test` / `wasit_x402_test` for x402, `mpp-charge` /
`wasit_mpp_charge_test` for charge mode, and `mpp-channel` /
`wasit_mpp_channel_test` for channel mode. Only the reporting surface differs — exit
codes are a CLI concept, and the MCP server reports the same verdict as an
`outcome` field in its structured output.

`MPP-13` is reachable from both interfaces, but by different routes. Over MCP,
`wasit_mpp_channel_test` runs the non-destructive channel checks (`MPP-10`,
`MPP-11`, `MPP-12`, `MPP-14`) and reports `MPP-13` as SKIP, so an agent can see
that the check exists and why it did not run, rather than silently receiving a
shorter catalogue. The destructive route is a **separate tool**,
`wasit_mpp_channel_test_with_close`, which is registered only when a human
starts the server with `WASIT_ALLOW_DESTRUCTIVE=1` or `--allow-destructive`.
Without that opt-in the tool is absent from `tools/list` altogether: an agent
cannot invoke a tool it cannot see, which is a stronger guarantee than a boolean
argument it could set for itself. When the tool is registered, it still requires
a `destructiveChannel` argument naming the channel it is permitted to close, and
the guard described in the `MPP-13` row still applies unchanged — the run
refuses unless the target's challenge advertises that same address. Signing keys
are read from the server process environment and are never accepted as tool
arguments, so an agent never handles them.

**Revision note (Week 2, corrected):** `MPP-11`/`MPP-12` pass criteria were first written as "server rejects", then briefly revised to "zero balance delta / silent no-op" after reading only the `stellar-experimental/one-way-channel` on-chain contract source (which is genuinely a silent no-op for stale `settle`/`close` calls). That revision was corrected after reading the `@stellar/mpp` channel server implementation directly: the HTTP-facing server — the actual artifact Wasit tests — rejects stale/replayed commitments explicitly via `ChannelVerificationError`, before the on-chain contract is ever invoked. The contract's own no-op behavior only applies if the contract is called directly, bypassing the server, which is out of scope for Wasit.

**Status note (Week 2, corrected).** All thirteen checks in this catalogue are implemented
and reachable from both front ends. `X402-02` deliberately accepts either header
name because Stellar's own official documentation is not yet internally
consistent (`PAYMENT-REQUIRED` vs `X-Payment`); that divergence is a
documentation defect upstream, not a choice this catalogue is making. Note that
the `x402Version` field-name difference checked by `X402-04` is **not** a
divergence of the same kind: it is a deliberate, documented change between
protocol versions, and the SDK implements it correctly.

**Note on error granularity (Week 2).** All channel-mode rejections return the
same HTTP 402 body: `{"type": ".../problems/verification-failed", "title":
"Verification Failed", ...}`. Replay, non-monotonic commitments, bad signatures
and a settling channel are indistinguishable from the response alone. Cause:
`@stellar/mpp` throws `ChannelVerificationError`, which extends `StellarMppError`
rather than mppx's `PaymentError`, so `mppx` rewraps every one of them into a
generic `VerificationFailedError`. mppx already defines precise types for this
family — `session/invalid-signature`, `session/signer-mismatch`,
`session/amount-exceeds-deposit`, `session/delta-too-small`,
`session/insufficient-balance`, `session/channel-finalized` — and none are
currently reachable from channel mode.

Wasit therefore isolates each rule by **construction** rather than by asserting
on the response type: every check is built so that exactly one rejection path
can fire, and the "Pass Criteria" column above records how. This is a gap in the
official SDK, not in any service under test, and is documented in [docs/findings/upstream-sdk.md](findings/upstream-sdk.md) for upstream reporting.

**Note on close authorisation (Week 2).** The channel contract's `close()` calls
`to.require_auth()` — the **recipient** must authorise the close, not the funder.
`@stellar/mpp` exposes this as `feePayer.envelopeSigner`, a name that implies fee
payment rather than authorisation; configuring it with the funder's key produces
a transaction that reaches the chain and fails there with an opaque
`scecInvalidAction`, which the SDK surfaces as `[object Object]`. By contrast,
`close_start()` requires `from.require_auth()` — the funder. Both details are documented in [docs/findings/upstream-sdk.md](findings/upstream-sdk.md) for upstream reporting.
