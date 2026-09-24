# Upstream Findings

Four findings in `@stellar/mpp`, all found while building Wasit. The first
three reproduce against current, published versions; the fourth is on `main`
and unreleased. This document
is the canonical write-up; the GitHub issues filed against
[`stellar/stellar-mpp-sdk`](https://github.com/stellar/stellar-mpp-sdk) are
summaries that link back here.

None is a defect in any service under test. All four are in the official SDK
or in the metadata it publishes.

## Versions

| Package                | Version | Notes                                                                |
| ---------------------- | ------- | -------------------------------------------------------------------- |
| `@stellar/mpp`         | 0.7.1   | Latest published at time of testing                                  |
| `mppx`                 | 0.8.14  | Latest published; maintained by [wevm](https://github.com/wevm/mppx) |
| `@stellar/stellar-sdk` | 16.1.0  |                                                                      |
| Node.js                | 24.18.0 |                                                                      |

The table above records the versions Findings 1 and 2 were tested against.
Finding 3 was verified later, when `@stellar/stellar-sdk` had reached 17.0.1 and
`mppx` 0.9.2 while `@stellar/mpp` was still 0.7.1; it states its own resolved
versions inline.

All three originate in `@stellar/mpp`. `mppx` appears in the first finding as
the package whose types are unreachable, and in the third as a peer whose
declared range is stale — in neither case as the package at fault.

---

## Finding 1 — Channel-mode errors collapse to a single generic type

**Status:** filed — [stellar/stellar-mpp-sdk#66](https://github.com/stellar/stellar-mpp-sdk/issues/66)
**Severity:** moderate — no security impact, significant debuggability impact

### Summary

`mppx` defines a precise error taxonomy for payment-session failures. In channel
mode, none of it is reachable. Every rejection returns an identical HTTP 402
body, so a client cannot tell a replayed credential from a bad signature from a
channel that is already settling.

### Cause

`ChannelVerificationError` extends `StellarMppError` rather than `mppx`'s
`PaymentError`. Because `mppx/server/Mppx.js` recognises failures by their
relationship to `PaymentError`, every channel-mode rejection falls through its
type dispatch and is rewrapped as a generic `VerificationFailedError`.

The precise types exist and are simply never constructed:

- `session/invalid-signature`
- `session/signer-mismatch`
- `session/amount-exceeds-deposit`
- `session/delta-too-small`
- `session/insufficient-balance`
- `session/channel-finalized`

### Observed behaviour

Every one of these distinct conditions produces the same response:

```json
{
  "type": "https://paymentauth.org/problems/verification-failed",
  "title": "Verification Failed",
  "status": 402
}
```

- a credential replayed against the same challenge
- a commitment equal to or below the stored cumulative
- a commitment that advances but does not cover the current price
- a commitment carrying an invalid signature
- a channel already in the process of settling

### Impact

An operator debugging a rejected payment cannot determine which rule they broke.
The information needed to tell them exists inside the SDK at the point of
rejection and is discarded before it reaches HTTP.

For conformance testing specifically, it means a tester cannot assert on the
response type to establish which rule fired. Wasit works around this by
isolating each rule _by construction_ — every check is built so that exactly one
rejection path can possibly fire, and the isolation argument is recorded in each
check's pass criteria. That is a workaround, not a fix, and it constrains what
any client can diagnose.

### Reproduction

1. Stand up an MPP channel-mode server using `@stellar/mpp` and `mppx`.
2. Submit a valid channel credential; observe HTTP 200.
3. Resubmit the byte-identical credential against the same challenge — HTTP 402.
4. Submit a fresh challenge with a commitment below the stored cumulative —
   HTTP 402.
5. Submit a fresh challenge with a deliberately corrupted signature — HTTP 402.

Compare the three 402 bodies. They are identical.

### Possible fixes

Two directions, both plausible; the maintainers are better placed to choose:

- Have `ChannelVerificationError` extend `mppx`'s `PaymentError` so the existing
  dispatch reaches it.
- Map channel verification failures onto the specific `session/*` types at the
  throw site, where the cause is still known.

Neither has been implemented or tested by us.

---

## Finding 2 — `feePayer.envelopeSigner` is the authoriser, not the fee payer

**Status:** filed — [stellar/stellar-mpp-sdk#67](https://github.com/stellar/stellar-mpp-sdk/issues/67)
**Severity:** moderate — misleading name plus an opaque failure

### Summary

The parameter named `feePayer.envelopeSigner` supplies the account that
_authorises_ a channel operation, not the account that pays transaction fees.
Different operations require different accounts, and supplying the wrong one
produces a failure that the SDK renders as `[object Object]`.

### Details

The channel contract's authorisation requirements are asymmetric:

| Operation       | Requires                                |
| --------------- | --------------------------------------- |
| `close()`       | `to.require_auth()` — the **recipient** |
| `close_start()` | `from.require_auth()` — the **funder**  |

The SDK surfaces this as `feePayer.envelopeSigner`. The name reads as fee
payment, which is a different concern entirely, and it gives no hint that the
correct value changes between operations.

### Observed behaviour

Configuring `close()` with the funder's key produces a transaction that is built
successfully, submitted successfully, reaches the chain, and fails there with
`scecInvalidAction`. The SDK surfaces that failure as:

```
[object Object]
```

No account address, no operation name, no indication that authorisation was the
problem.

### Impact

The two defects compound. A developer who supplies the wrong key gets a string
that identifies nothing, from a parameter whose name points at the wrong
concept. Diagnosing it requires reading the on-chain contract's
`require_auth()` calls — which is not a reasonable expectation for an SDK
consumer.

### Reproduction

1. Open a channel with distinct `from` and `to` accounts.
2. Call `close()` with `feePayer.envelopeSigner` set to the funder's key.
3. Observe the transaction reach the chain and fail.
4. Observe the SDK's error message.

### Possible fixes

Three, roughly independent:

- Rename the parameter to reflect authorisation rather than fee payment, or
  document the asymmetry at the call site.
- Serialise the underlying error rather than string-coercing an object.
- Fail earlier: the required authoriser is knowable before submission, so a
  mismatch could be caught before a transaction is built.

---

## Finding 3 — Stale peer ranges put a second Stellar SDK in every clean install

**Status:** filed as [stellar/stellar-mpp-sdk#70](https://github.com/stellar/stellar-mpp-sdk/issues/70), closed as completed by a maintainer on 2026-09-10; the related [PR #74](https://github.com/stellar/stellar-mpp-sdk/pull/74) merged on 2026-09-14. No `@stellar/mpp` release contains it yet (latest on npm is still `0.7.1`), so consumers see no change until one ships
**Severity:** moderate — no defect in the SDK's own logic, but it duplicates a
runtime dependency across a call boundary and leaves consumers holding
advisories they have no way to resolve

### Summary

`@stellar/mpp@0.7.1` declares peer dependencies on `@stellar/stellar-sdk@^15.1.0`
and `mppx@^0.6.29`. Both ranges trail the ecosystem by a wide margin:
`@stellar/stellar-sdk` is published at 17.0.1 and `mppx` at 0.9.2. A consumer on
current versions falls outside both ranges, and npm settles the conflict by
installing a second, older copy of each next to the ones the consumer asked for.

### Cause

The ranges are metadata, not code. Nothing observed in `@stellar/mpp` requires
15.x specifically — see the compatibility note below — but npm cannot infer
that, so it satisfies the declared range literally by materialising the old
version.

### Observed behaviour

A clean install of a package depending on `@stellar/mpp@0.7.1` alongside
`@stellar/stellar-sdk@^16.1.0` and `mppx@^0.8.14`, on npm 10.9.7:

```
$ npm install @wasit-dev/cli@0.2.0
added 117 packages, and audited 118 packages
6 high severity vulnerabilities

$ npm ls @stellar/stellar-sdk
`-- @wasit-dev/cli@0.2.0
  `-- @wasit-dev/core@0.2.0
    +-- @stellar/mpp@0.7.1
    | `-- @stellar/stellar-sdk@15.1.0
    +-- @stellar/stellar-sdk@16.3.0
    `-- @x402/stellar@2.25.0
      `-- @stellar/stellar-sdk@16.3.0

$ npm ls mppx
    +-- @stellar/mpp@0.7.1
    | `-- mppx@0.6.31
    `-- mppx@0.8.19
```

Three copies of `@stellar/stellar-sdk` and two of `mppx` land on disk. The
15.1.0 SDK and the 0.6.31 `mppx` exist only to satisfy these peer ranges.

### Impact

**Two `mppx` instances, with objects crossing between them.** `@stellar/mpp`
imports `mppx` at runtime — `dist/channel/server/Channel.js`,
`dist/channel/Methods.js` and `dist/channel/server/index.js` all do. A consumer
that builds a `Challenge` or a `Credential` from its own `mppx` and hands it to
`@stellar/mpp` is passing an object from one module instance into code running
another. It works today because the interop happens to be structural, but
nothing declares that contract, and any future `instanceof` check, branded type
or private field would break it silently rather than loudly.

**An advisory chain with no exit.** `npm audit` reports the duplicate SDK as the
source of six high-severity findings and states that no fix is available:

```
axios  1.0.0 - 1.17.0
Severity: high
No fix available
  @stellar/stellar-sdk  <=15.1.0
  Depends on vulnerable versions of axios
  Depends on vulnerable versions of toml
    @stellar/mpp  >=0.5.0
    Depends on vulnerable versions of @stellar/stellar-sdk
```

Note the range on the third line: every `@stellar/mpp` from 0.5.0 onward is
affected, so this is the current state of the line rather than one unlucky
release. A downstream maintainer cannot resolve it, because the only lever is a
peer range they do not control.

### Which copy is actually vulnerable

Measured against `@wasit-dev/cli@0.3.0`, the advisories are attributable
entirely to the nested copy. The declared SDK is clean:

```
@wasit-dev/core > @stellar/mpp@0.7.1 > @stellar/stellar-sdk@15.1.0 > axios@1.15.0
                                                                   > toml@3.0.0
@wasit-dev/core > @stellar/stellar-sdk@16.3.0                      > axios@1.18.0
@wasit-dev/core > @x402/stellar@2.25.0 > @stellar/stellar-sdk@16.3.0 > axios@1.18.0
```

`axios@1.15.0` matches 28 published advisories and `toml@3.0.0` two more; the
counts then propagate up through `@stellar/mpp` to every `@wasit-dev/*` package,
for seven high-severity findings in total. Every one of those advisories has an
exclusive upper bound below `1.18.0`, so `axios@1.18.0` — the copy the 16.x SDK
resolves — matches none of them, and 16.x pulls no `toml` at all.

That makes the peer ranges the sole cause rather than a contributing factor.
Widening them does not merely tidy the tree; it removes all seven findings.

### How this is now tracked

`npm run verify:clean-install` in the Wasit repo packs the published tarballs,
installs them into an empty project, and prints the resolved `@stellar/*` tree,
`npm audit` for that tree, and the dependency path behind every flagged package.
It runs in CI on every push. It reports rather than fails: the condition is not
one a downstream release should be blocked on.

### Compatibility note

This is offered as evidence that the ranges understate what works, not as a
claim of full compatibility. Wasit exercises `@stellar/mpp@0.7.1` against
`@stellar/stellar-sdk@16.x` and `mppx@0.8.x` on Stellar testnet across
charge-mode settlement — verified from the CAP-46 `transfer` event rather than
the transaction envelope — and the full channel-mode lifecycle of deploy,
cumulative ordering, challenge replay, commitment replay and on-chain close.
All pass. 17.x has not been exercised and no claim is made about it.

### Why this may not have surfaced yet

A repository checkout resolves differently from a consumer install. With a
lockfile in place npm dedupes to a single 16.x SDK and simply marks the peer
unsatisfied, so `npm ls` reports
`@stellar/stellar-sdk@16.1.0 invalid: "^15.1.0" from node_modules/@stellar/mpp`
and exits `ELSPROBLEMS`, while the duplicate never appears. Anyone testing from
a checkout sees a clean single-SDK tree; only a fresh consumer install produces
the duplicated one described above.

### Reproduction

The two `npm` commands above, in an empty directory. No account, keys or
network beyond the registry are required.

### Possible fixes

Widening the peer ranges to the versions actually supported — something in the
shape of `>=15.1.0 <18` for `@stellar/stellar-sdk` and `>=0.6.29 <0.10` for
`mppx` — would let a current consumer satisfy them without npm having to
materialise a second copy. If the intent is instead to track one supported line,
bumping the ranges to current and saying so explicitly would achieve the same
thing. Either way, a published range that no current consumer can satisfy makes
the duplicate unavoidable.

### Update, 2026-09-13

A maintainer opened [PR #74](https://github.com/stellar/stellar-mpp-sdk/pull/74)
(branch `fix/cap-71-v2-auth-credentials`, commits by jeesunikim, approved by
marcelosalloum) that touches this. It has not merged yet, and `@stellar/mpp`
has not published a new version since it opened, so nothing changes for
consumers until both happen.

What the diff actually does, verified from the PR's file list: the
repository's own `package.json` peer dependency on `@stellar/stellar-sdk`
moves from `^16.0.1` to `^16.3.0`. That is a floor bump, not the range
widening this finding asked for, and the `mppx` peer stays at `^0.8.1`
unchanged. It also does not by itself explain the gap this finding measured
against the published `0.7.1` package, which still declares `^15.1.0`;
`main` had apparently already moved the floor to `16.0.1` sometime after
`0.7.1` was cut, before this PR pushed it further to `16.3.0`. Confirm the
actual `peerDependencies` value in whatever version ships next before
treating this as resolved.

The PR is not only a version bump. It adds support for CAP-71 V2
authorization credentials (`SOROBAN_CREDENTIALS_ADDRESS_V2`) alongside the
existing V1 format, adds a `useUpgradedAuth` client flag to request V2
during simulation, and moves signature verification onto the SDK's own
`buildAuthorizationEntryPreimage` so the preimage is derived correctly per
credential version. Changed files: `sdk/src/charge/client/Charge.ts`,
`sdk/src/charge/server/Charge.ts`, `sdk/src/shared/getAddressCredentials.ts`,
`sdk/src/shared/verify-auth.ts`, plus their tests.

That is relevant beyond this finding: Wasit's own charge parser
(`packages/core/src/mpp/charge.ts`) reads the same credential shape. Once
`@stellar/mpp` publishes a version built on this PR, re-run MPP-01 against
it and confirm Wasit still parses both V1 and V2 credentials before bumping
Wasit's own `@stellar/mpp` dependency.

### Update, 2026-09-24

#70 was closed as completed by jeesunikim on 2026-09-10, and PR #74 merged
on 2026-09-14 (merge commit `1ee3f25`). Neither has reached consumers yet:
`@stellar/mpp@latest` on npm is still `0.7.1`, published 2026-07-02, and
still declares `@stellar/stellar-sdk@^15.1.0` and `mppx@^0.6.29`. The
duplicate-SDK install described above therefore still reproduces from the
registry today. Treat this finding as fixed upstream, unreleased.

---

## Finding 4 — Rejected channel vouchers are reported as HTTP 500 since the mppx 0.10 bump

**Status:** not yet filed. Present on `main` since
[#78](https://github.com/stellar/stellar-mpp-sdk/pull/78) (merged 2026-09-22);
not in any release, since `@stellar/mpp@latest` is still `0.7.1`
**Severity:** moderate. Enforcement is intact and no voucher is honoured
twice, but every refusal is reported to the client as a server fault
**Evidence:** `docs/evidence/2026-09-24-official-sdk-reference-run.md`

### Summary

Against the SDK's own unmodified `examples/channel-server.ts`, a stale
commitment, a replayed credential, a replayed commitment and a commitment above
the channel balance are all refused with **HTTP 500
`internal-payment-error`** on `afd8fb5`, where `1ee3f25`, the commit before #78,
refused the same probes with **HTTP 402 `verification-failed`**. Same channel,
same key, same Wasit binary, minutes apart: `MPP-11`, `MPP-12` and `MPP-14`
went from 3/3 PASS to 3/3 FAIL.

### Cause

`StellarMppError` extends `Error`, so none of the SDK's error classes is an
`mppx` `Errors.PaymentError`. `mppx`'s server wraps any non-`PaymentError`
thrown from `verify`: 0.8.x wrapped it in `VerificationFailedError` (402), and
0.10.1 wraps it in `InternalPaymentError` (500), logging
`mppx: internal verification error`. #78's description scopes the 0.8 → 0.10
breaking changes to `mppx`'s Tempo/EVM code and says no code changes were
needed. This path is outside that scope.

### Suggested fix

Make the SDK's verification errors `mppx` `PaymentError`s, for example by
deriving `ChannelVerificationError` and `PaymentVerificationError` from
`Errors.VerificationFailedError` or rethrowing them as one at the `verify`
boundary. That restores 402, and lets the SDK's own message reach the client
instead of the generic "An internal payment error occurred.". A regression test that asserts the status of a rejected
voucher would have caught this, and would catch the next `mppx` bump.

---

## Explicitly not findings

Recorded so the list above is not read as broader than it is.

**The x402 `maxAmountRequired` → `amount` rename.** x402 v2 renamed the price
field and dropped the embedded resource object. This initially looked like a
divergence between the SDK and the spec; it is not. The change is deliberate,
versioned, and documented in `@x402/core`'s own schema definitions. Wasit's
check was wrong, and was corrected to read `x402Version` and require the field
name that version defines.

**`PAYMENT-REQUIRED` vs `X-Payment`.** Stellar's documentation uses both names
for the payment header in different places. This is real, and Wasit accepts
either as a result — but it is a documentation inconsistency rather than an SDK
defect, so it belongs in a different report than these two.
