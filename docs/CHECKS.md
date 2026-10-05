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
| `X402-02` | Payment Header Present | x402 built-on-stellar guide | The 402 response must include a payment header | Either `PAYMENT-REQUIRED` or `X-Payment` header is present (both are checked — the spec itself is not yet consistent, see note in README). An x402 v1 challenge in the response body fails this check, and `X402-03`–`05` still inspect it; see the note on v1 below |
| `X402-03` | Header Payload Decodable | x402 spec §payment-required-object | The header value must be valid base64 that decodes to JSON | `atob()` + `JSON.parse()` succeed without error |
| `X402-04` | Required Fields Present | x402 spec §payment-required-object | The payload must include the core payment terms, under the field names its own advertised version requires | Checked in **every** payment option in `accepts`, each reported by its index when the challenge offers more than one; a challenge with no options fails. In each option, every field the advertised `x402Version` requires is present: for v2 `scheme`, `network`, `amount`, `asset`, `payTo` and `maxTimeoutSeconds` (spec 5.1.2); for v1 `scheme`, `network`, `maxAmountRequired`, `asset`, `payTo`, `resource`, `description` and `maxTimeoutSeconds` (v1 spec 5.1). Each is a non-empty string, except `maxTimeoutSeconds`, a positive number of seconds; a field present with the wrong type is reported as such rather than as missing. The price field follows the version: `maxAmountRequired` for v1, `amount` for v2 (renamed in v2, which also moves the resource out of the option). The version is read from the challenge rather than accepting whichever name happens to appear, because a service advertising `x402Version: 2` while emitting the v1 field name is not conformant to the version it claims — and reporting that as a merely absent price would hide the actual defect. An unrecognised version fails: the field names cannot be checked against a version whose schema is unknown. |
| `X402-05` | Network Identifier Valid | x402 v2 spec §11.1; CAIP-2 | Every advertised network id is CAIP-2 | Every option's `network` is a CAIP-2 identifier, `namespace:reference` with a 3 to 8 character lowercase namespace and a reference of at most 32 characters, as x402 v2 requires. Where the namespace's own CAIP-2 definition fixes the reference, that is checked too: `stellar` is `testnet` or `pubnet`; `eip155` is the chain id in base 10 (`eip155:84532`, not `eip155:0x14a34`); `solana` is the first 32 characters of the base58 genesis hash. A well-formed id in another namespace passes, and the result says only the format was checked there: x402 v2 asks for CAIP-2 and nothing more, so failing it would report Wasit's own lack of rules as the target's defect. An option without a `network` is left to `X402-04`. |
| `X402-06` | Signature Resubmit Accepted | x402 spec §payment-flow | A resubmitted request carrying a valid signature must be accepted | Response is no longer 402; a 2xx returns the original resource. The challenge is re-read immediately before signing, so the payment answers a challenge the target issued just now rather than a stale one. Before anything is signed, the payer's balance of `asset` is read from the chain: when it is below `amount`, nothing is sent and the check gives no verdict (`ERROR (setup)`), since a payment the payer cannot fund is refused for the payer's sake; when the balance cannot be read, the payment goes ahead. **Settles a real payment** — see the cost note below. A 2xx alone does not pass. The settlement the response reports in its `PAYMENT-RESPONSE` header (x402 v2 HTTP transport) must name a Stellar transaction hash, and that transaction is then looked up on Stellar RPC and held to the advertised terms exactly as `MPP-01` does: it must have succeeded and emitted exactly one `transfer` event, from this run's payer, to the advertised `payTo`, for the advertised `amount` of the advertised `asset`. A missing header, a reported failure, or a hash that does not match fails. A `settlement_pending` response, which the spec defines as broadcast but unconfirmed, is reconciled on chain rather than failed. Uses the same RPC wait as `MPP-01`. On Base Sepolia (`eip155:84532`) the payment uses the transfer method the target advertises: EIP-3009 by default, or Permit2, whose one-time approval the client signs as an EIP-2612 permit when the target offers the `eip2612GasSponsoring` extension. A Permit2 target without it, where this run's payer has not approved Permit2, gives no verdict (`ERROR (setup)`): the missing approval is the payer's, not the target's. The reference is an EVM transaction hash, and the receipt's ERC-20 `Transfer` log is held to the same terms (a Permit2 settlement also logs the permit's `Approval`, which is not a transfer): the transaction succeeded and logged exactly one token transfer, from this run's payer, to `payTo`, for `amount` of `asset` (an ERC-721 transfer, which shares the event signature, is not counted). The receipt is awaited for 30 blocks before the transaction counts as missing; an RPC that stops advancing gives no verdict. On Solana devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`) the client signs a transaction with one `TransferChecked` to the payee's associated token account, and the sponsor named in `extra.feePayer` signs as fee payer and submits it, so the payer needs no SOL. The reference is a transaction signature, and the confirmed transaction's token balances are held to the same terms: it succeeded, and exactly one transfer moved (one account debited and one credited, by the same amount of the same mint), for `amount` of `asset`, to an account `payTo` owns, from this run's payer. The transaction is awaited for 150 slots before it counts as missing; an RPC that stops advancing gives no verdict. |
| `X402-07` | Invalid Signature Rejected *(negative)* | x402 spec §payment-flow; `exact` scheme on Stellar | A payment whose authorization signature is wrong must be REJECTED | The target answers with a non-2xx status. The payment is built exactly as for `X402-06`, then only the client's authorization signature is corrupted: in the `exact` scheme on Stellar the client signs a Soroban authorization entry rather than the envelope, and one byte of that entry's `signature` is flipped. The transaction still decodes and carries the same amount, payer and recipient, so a target can refuse it only by verifying the signature. Measured against the `x402.org` facilitator on 2026-09-30, the rejection is `invalid_exact_stellar_payload_simulation_failed`, reached at the Soroban simulation that checks authorization; the pre-0.6.0 corruption, which overwrote the base64 tail and broke XDR decoding, drew `invalid_exact_stellar_payload_malformed` instead, and a target that decoded the envelope without verifying the signature passed it. Rejection is established only by an answer: a target that cannot be reached, or whose challenge cannot be read, produces no verdict and is reported as ERROR or SKIP, and a payload with no authorization signature to corrupt reports `ERROR (setup)`. On Base Sepolia the client signs an EIP-3009 `transferWithAuthorization`, or a Permit2 transfer, off-chain; the first byte of that signature is flipped and the authorization left intact, so the signer it recovers to is no longer the payer and only signature verification can refuse it. Measured against the `x402.org` facilitator on 2026-10-05: refused with 402. On Solana devnet the transaction carries one signature before the sponsor signs, the payer's; its first byte is flipped, and the message, transfer and blockhash are left intact. Measured against the `x402.org` facilitator on 2026-10-05: `invalid_exact_svm_payload_signature_invalid`. |
| `X402-08` | Payment Replay Rejected *(negative)* | x402 v2 spec §10.1; `exact` scheme, one-time use | A payment that was already accepted must not be accepted again | The headers `X402-06`'s accepted payment was sent with are sent again, byte for byte, and the target answers with a non-2xx status. Each authorization is single-use: once the payment settles, its EIP-3009 nonce, or its Soroban auth entry's nonce, is spent, or on Solana the transaction has already executed, and the facilitator's verify refuses it. A 2xx means one payment bought the resource twice. Nothing can settle twice, so this costs nothing. **Skipped** when the challenge advertises the `payment-identifier` extension, under which a server may legitimately answer a repeated payment with its cached response. |
| `X402-09` | Underpayment Rejected *(negative)* | `exact` scheme verification: amount | A validly signed payment for less than the advertised amount must be rejected | The payment is signed for half the advertised amount, while its `accepted` still claims the advertised terms, so the signature is valid and only the amount is wrong; the target answers with a non-2xx status. On Stellar the facilitator must hold the transfer to `requirements.amount` exactly; on EVM, verification step 3 holds the authorization's value to it; on Solana the scheme forbids a transfer below it (§1.4), and the reference facilitator's static path requires the exact amount (§3.1). **Skipped** when the price is 1 base unit, since nothing smaller can be offered. A target that accepts may settle the lower amount. |
| `X402-10` | Expired Authorization Rejected *(negative)* | x402 v2 spec §10.1 (time constraints); `exact` scheme verification: validity window | A payment whose authorization has expired must be rejected | The payment is signed with a one-second lifetime, which both SDK clients derive from `maxTimeoutSeconds` (EVM `validBefore`, the Stellar auth entry's expiration ledger), held until that has passed (5 seconds on Base Sepolia, 20 on Stellar, three or more ledgers), and sent claiming the advertised terms. On Solana a payment's lifetime is its recent blockhash, which the SDK client does not take from `maxTimeoutSeconds`: the payment is built, through the client's `extra.recentBlockhash` hint, on a blockhash 300 slots old that the RPC confirms is no longer valid, and sent at once. The target answers with a non-2xx status. An expired authorization cannot settle, so a target that serves it serves for nothing. |

**Note on the x402 payment checks' cost (Week 2).** `X402-06` and `X402-07`
are not free. `X402-06` settles a real payment against the target, and `X402-07`
attempts one with a corrupted signature; both move or risk moving testnet funds
from the payer key, and repeated runs spend repeatedly. Like `MPP-01` this is
inherent rather than an implementation choice — a payment flow that was never
exercised cannot be verified. `X402-01` through `X402-05` read the challenge
only and cost nothing; `--read-only` (CLI) or `readOnly: true` (MCP) restricts a
run to those. The payment checks are also skipped entirely when no payer key is
present, so the default posture is the cheap one.

**Note on the negative payment checks (0.7.0).** `X402-07` through `X402-10` each send a
payment the target must refuse, and pass when it does. A refusal only means something
from a target that accepts a valid payment: one that refuses everything would pass them
all. So they run only after `X402-06`'s valid payment was answered with a 2xx, and are
**skipped** otherwise, with that reason. They run in catalogue order after `X402-06`.

**Note on settlement timing (0.7.0).** There is no check that a target settles before it
serves, because the protocol does not require it. x402 v2's default `authorization` flow
is verify, run the resource, settle, then respond (spec §6.1); only a flow declared as
`upfront` or `escrow` in `extra.paymentFlow` settles first. What the client can observe,
that the response arrives with a settlement that happened, `X402-06` already requires.

**Note on cascading failures (Week 2).** The read-only checks inspect
progressively deeper parts of one challenge: the status, then the header, then
its payload, then the fields inside it. When one fails, the checks after it have
nothing left to inspect, and they are **skipped rather than failed**. A target
answering 404 produces one finding, not five. The same applies across the
payment checks: when `X402-06` cannot exercise the payment flow at all,
`X402-07` is skipped rather than credited with a rejection it never observed.

**Note on x402 v1 challenges (0.5.0).** x402 v1 signals payment in the 402
response *body*, as a `PaymentRequirementsResponse` with `x402Version: 1`
([transports-v1/http.md](https://github.com/x402-foundation/x402/blob/02e80f3/specs/transports-v1/http.md)).
v2 moved it into the `PAYMENT-REQUIRED` header
([transports-v2/http.md](https://github.com/x402-foundation/x402/blob/02e80f3/specs/transports-v2/http.md)),
and the `exact` scheme on Stellar is defined for v2 only, with CAIP-2 network
identifiers ([scheme_exact_stellar.md](https://github.com/x402-foundation/x402/blob/02e80f3/specs/schemes/exact/scheme_exact_stellar.md):
"❌ `v1` - we don't plan to support v1 for now"). So a v1 challenge from a
Stellar service fails `X402-02`, and the failure says a v1 challenge was found
in the body. Its terms are still worth reading, so `X402-03`–`05` inspect the
body instead of being skipped: `X402-04` applies the v1 field names, and
`X402-05` reports whether the network is a CAIP-2 identifier (v1 used plain
names such as `base-sepolia`, and the failure says so). `X402-06` and
`X402-07` are **skipped**: Wasit pays through the v2 `exact` scheme, so no
payment is built or sent, and neither check has a verdict. The same holds for
any challenge the payment client cannot read. Before 0.5.0 both reported FAIL
in that case, contradicting the `X402-07` row above, and a v1 challenge left
`X402-03`–`05` skipped.

**Note on networks (0.7.0).** `X402-01`–`05` read the challenge only, so they
apply to an x402 service on any chain. The payment checks pay through the
`exact` scheme on the network the run names: `stellar:testnet` (the default),
`stellar:pubnet`, `eip155:84532` (Base Sepolia, with the EIP-3009 or Permit2
method, where the facilitator pays the gas), or
`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (Solana devnet, where the facilitator signs as
fee payer). When a challenge offers several options, the payment is built for the option
on that network; a challenge with no such option, or only one in another scheme, gets
`X402-06`–`10` **skipped** with the networks it does offer, since nothing was paid and nothing refused. Asking for any other network, for pubnet without an RPC endpoint, or paying
with a key for the wrong chain, stops the run before any payment, as no
settlement could be verified.

## MPP — Charge Mode

| ID | Check Name | Spec Reference | What It Checks | Pass Criteria |
|---|---|---|---|---|
| `MPP-01` | Charge Settlement On-Chain | MPP Charge Guide; CAP-46 transfer events | The charge settles on-chain for exactly what the target advertised | The target's own 402 challenge is read first, unpaid, capturing the advertised `amount` (base units), `currency` and `recipient`. After payment, Stellar RPC `getTransaction` confirms the transaction referenced by the `Payment-Receipt` header succeeded, and its CAP-46 `transfer` contract event shows exactly one balance change: the advertised amount, to the advertised recipient, emitted by the advertised token contract, sent from this run's own payer. Verifying the **event** rather than the transaction envelope means a token contract whose `transfer` moves a different amount than its arguments claim is still caught. Verifying the **sender** means a target cannot satisfy the check by referencing some pre-existing transaction it did not cause. Verified against `@stellar/mpp@0.7.1` — mode `"pull"` (default): `onProgress` only fires through `"signed"`, so the settled tx reference comes from `Payment-Receipt`, not `onProgress`. The transfer event's data is read in both forms the protocol defines: a bare `i128` amount (CAP-46), and the map `{ amount, to_muxed_id }` that CAP-67 emits for a muxed destination, whose base address is in the topic. An advertised muxed recipient (`M...`) therefore matches only when both the base account and the muxed id match. A transaction RPC cannot find is a FAIL only after RPC has closed ten more ledgers without it; an RPC that stops advancing before then gives no verdict (`ERROR (harness)`), since its silence says nothing about the target. |

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

**Status note (Week 2, corrected; 0.7.0).** All sixteen checks in this catalogue are implemented
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

## Common failures and fixes

The failures builders hit most often, what each looks like in a run, and what
fixes it. Every FAIL in a run already carries its own `Fix` line; this page
collects them by check, with the reasoning. Where a failure was met in a real
implementation, it links the write-up.

### The unpaid request does not get a 402 (`X402-01`)

- **200**: the route serves without payment. The payment middleware is not in
  front of it, or protects a different path.
- **401 or 403**: the endpoint asks for authentication instead of payment.
  x402 clients act only on 402.
- **404 or 405**: usually the wrong path or method. An endpoint that computes
  something often takes POST: `wasit test --method POST --body '{...}'` (MCP:
  `method` and `body`).

### There is no payment header (`X402-02`)

x402 v2 carries the challenge base64-encoded in the `PAYMENT-REQUIRED` response
header. A service that puts an x402 v1 challenge in the response body fails
here, and the result says it found one; its terms are still checked. The
`exact` scheme on Stellar is defined for v2 only. This is the divergence Wasit
has met in a real implementation
([conformance findings](findings/conformance-findings.md), class 1).

### The header does not decode (`X402-03`)

The header value must be the base64 of the JSON `PaymentRequired` object. Raw
JSON, or a value cut short, does not decode.

### A field is missing or has the wrong type (`X402-04`)

Every option in `accepts` needs every field its `x402Version` requires: for v2,
`scheme`, `network`, `amount`, `asset`, `payTo` and `maxTimeoutSeconds`. The
usual slips in a challenge built by hand:

- `maxTimeoutSeconds` left out. The official x402 server SDK sets it to 300
  when you do not.
- `amount` sent as a number. It is a string of the token's smallest units,
  such as `"10000"`.
- The v1 price name `maxAmountRequired` in a v2 challenge. v2 calls it
  `amount`.

A challenge built with the official server SDK carries every field.

### The network id is rejected (`X402-05`)

x402 v2 names each network with a CAIP-2 id, `namespace:reference`:

| Network | CAIP-2 id |
|---|---|
| Stellar testnet | `stellar:testnet` |
| Stellar mainnet | `stellar:pubnet` |
| Base Sepolia | `eip155:84532` |
| Base | `eip155:8453` |
| BNB Smart Chain testnet | `eip155:97` |
| BNB Smart Chain | `eip155:56` |
| Solana devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` |
| Solana mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |

The Stellar ids come from the `exact` scheme on Stellar, the Base and Solana ids
are the x402 v2 specification's own examples (§11.1), and the BNB Smart Chain
ids are its EIP-155 chain ids. The usual slips:

- A v1 name such as `stellar-testnet` or `base-sepolia`
  ([conformance findings](findings/conformance-findings.md), class 2).
- A hex chain id. `eth_chainId` returns hex; the CAIP-2 reference is base 10,
  so `eip155:0x14a34` is `eip155:84532`.
- `stellar:mainnet`. Stellar's mainnet is `stellar:pubnet`.
- A Solana cluster name. The reference is the first 32 characters of the
  cluster's genesis hash.

### A valid payment is refused (`X402-06`)

Wasit built the payment with the official client, for exactly the advertised
terms, and the target refused it. The target's own log of the facilitator's
verify or settle response says why.

### The paid response has no `PAYMENT-RESPONSE` (`X402-06`)

After settling, the server returns the facilitator's settle result,
base64-encoded, in `PAYMENT-RESPONSE`; it names the settlement transaction.
Without it a client cannot tell whether the payment settled, so `X402-06`
fails. The official x402 middleware sends it. A server that serves without
settling looks exactly like this, and `wasit serve --mode no-settle` is one,
for testing an agent against it.

### The settlement does not match (`X402-06`)

The transaction `PAYMENT-RESPONSE` names must have succeeded and moved exactly
`amount` of `asset` from this run's payer to `payTo`, in one transfer. A server
that cites another transaction fails, even a real and successful one
([0.6.0 verification run](evidence/2026-09-30-x402-0.6.0-verification-run.md)).

### A forged signature is accepted (`X402-07`)

The target served a payment whose authorization signature was corrupted: it
decoded the payment without verifying it. Pass every payment to the
facilitator's verify step and refuse it when verification fails.

### The same payment is accepted twice (`X402-08`)

A target that serves a payment it has already been paid with sold the resource twice
for one payment. Each authorization is single-use; the facilitator's verify refuses one
whose nonce is spent, so verify every payment before serving and never serve a payload
twice. A server that offers the `payment-identifier` extension may answer a repeat with
its cached response, and `X402-08` is skipped for it.

### A payment for less than the price is accepted (`X402-09`)

The signature was valid; only the amount was short. A server that checks only the
signature, or skips the facilitator's verify, sells for less than its price. Hold the
signed amount to the advertised one before serving: on Stellar it must be exact.

### An expired payment is accepted (`X402-10`)

An authorization past its window (`validBefore` on EVM, the auth entry's expiration
ledger on Stellar, the recent blockhash on Solana) can never settle, so a target that serves it serves for nothing.
Verify with the facilitator before serving; it refuses expired authorizations.

### A charge to a muxed recipient is refused (`MPP-01`)

A charge server on `@stellar/mpp` 0.7.1 configured with a muxed (`M...`)
recipient cannot verify the payment and refuses it. Since CAP-67, a transfer
to a muxed address reports its amount in a form the SDK does not read. Use a
`G...` recipient until the SDK handles it
([Finding 5](findings/upstream-sdk.md), reported as
[stellar/stellar-mpp-sdk#89](https://github.com/stellar/stellar-mpp-sdk/issues/89)).
Wasit reads both forms.

### A stale or replayed voucher is accepted, or refused with 500 (`MPP-11`, `MPP-12`, `MPP-14`)

The server must refuse with 402: a commitment that does not exceed the stored
cumulative or does not cover the price, a second credential for a challenge
already used, and an accepted commitment presented under a new challenge. The
`@stellar/mpp` channel server enforces all three. Refusals reported as HTTP 500
instead of 402 were seen on the SDK's `main` branch between its `mppx` 0.10.1
upgrade and the fix in #83, never in a release
([Finding 4](findings/upstream-sdk.md)).

### No verdict on the channel checks (`ERROR (setup)`)

`MPP-11`, `MPP-12` and `MPP-14` each need one correctly advancing commitment
accepted first. When three attempts are refused, the run reports no verdict
rather than a failure, because a channel another payer is advancing at the same
time looks the same from the client. Re-run against a channel nothing else is
paying through.

### The payment checks cannot pay

`X402-06` reads the payer's balance before it signs. When the chain reports less than
the advertised amount it stops with `ERROR (setup)`: "This run's payer holds less of …
than the advertised … base units", naming the key to fund. Nothing is sent, and
`X402-07`–`10` are skipped ([evidence](evidence/2026-10-05-payer-balance-check-run.md)).

On Stellar, the payment checks need a testnet payer holding testnet USDC.
`wasit wallet create --role x402 --fund` generates the key and funds it with
testnet XLM, and `wasit wallet fund --role x402 --asset usdc` adds the USDC
trustline; the balance itself needs one visit to https://faucet.circle.com,
since there is no scriptable USDC faucet for Stellar (see the CLI guide's
wallet setup).

On Base Sepolia (`--network eip155:84532`), the payer is `EVM_PRIVATE_KEY`, a
raw `0x` private key. It needs Base Sepolia USDC from the same faucet and no
ETH at all: the facilitator pays the gas. A Stellar secret there, or any
malformed key, is reported at `PREFLIGHT` before anything is sent.

On Solana devnet (`--network solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`), the payer is
`SVM_PRIVATE_KEY`, the base58 encoding of the 64-byte keypair, as wallets export it. It
needs devnet USDC of the SDK's default mint (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`),
from the same faucet (network Solana Devnet), and no SOL: the facilitator signs as fee
payer. The payee's USDC token account must
already exist, since the payment's transaction does not create it. A keypair whose public
half does not belong to its seed, or any malformed key, is reported at `PREFLIGHT`.
