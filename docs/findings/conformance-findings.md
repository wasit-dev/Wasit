# Conformance Findings — x402 and MPP on Stellar

The SOW's written findings document for Deliverable 2: results across three
real implementations, reported in aggregate. As of 2026-09-28.

## What was tested

The SOW asks for at least three reference implementations: at least one
third-party ecosystem service tested with its operator's explicit
authorization, and the remainder self-hosted reference services built from the
official SDKs.

| # | Implementation | Kind | Protocol | Wasit | Evidence |
|---|---|---|---|---|---|
| 1 | [defi-copilot](https://github.com/fxjrin/defi-copilot), local instance at `e97879d` | Third-party, **operator's written authorization** ([run](https://github.com/fxjrin/defi-copilot/issues/1#issuecomment-5856332724), [naming](https://github.com/fxjrin/defi-copilot/issues/1#issuecomment-5860415354)) | x402 | 0.5.0 from npm | [2026-09-28](../evidence/2026-09-28-authorized-third-party-run.md) |
| 2 | `stellar/x402-stellar`, `simple-paywall` example | Official reference, self-hosted | x402 v2 | 0.3.0 from npm | [2026-09-06](../evidence/2026-09-06-reference-implementation-run.md) |
| 3 | `stellar/stellar-mpp-sdk`, `charge-server` and `channel-server` examples | Official reference, self-hosted | MPP charge and channel | 0.4.0 from npm | [2026-09-24](../evidence/2026-09-24-official-sdk-reference-run.md) |

defi-copilot is named with its operator's written permission. Its hosted
backend is no longer live, so at the operator's direction it ran as a local
instance of their published code. The two official references are
open-source code published by Stellar and were run, unmodified, on our own
machine. Everything ran on Stellar testnet.

## Results in aggregate

| | Conform on every check reached | Diverge from the spec | No verdict |
|---|---|---|---|
| x402 challenge shape (`X402-01`–`05`) | 1 of 2 | 1 of 2 | — |
| x402 payment flow (`X402-06`–`07`) | 1 of 2 | — | 1 of 2 |
| MPP charge (`MPP-01`) | 1 of 1 | — | — |
| MPP channel (`MPP-11`, `12`, `14`) | 1 of 1, before the regression and again after its fix | 1 of 1 at the regression commit, since fixed | — |

**No security-relevant failure was observed.** Every rejection Wasit probed was
enforced: a corrupted x402 payment was refused, and every stale or replayed MPP
channel voucher was refused. No payment was accepted twice.

## Classes of divergence found

Three classes, each in one of the three implementations.

**1. x402 v1 on Stellar.** One implementation issues an x402 v1 challenge in
the response body. The `exact` scheme on Stellar is defined for v2 only, which
carries the challenge in the `PAYMENT-REQUIRED` header
([spec](https://github.com/x402-foundation/x402/blob/02e80f3/specs/schemes/exact/scheme_exact_stellar.md)).
The v1 challenge itself is well-formed and complete, so this is a version
divergence, not malformed output. Wasit's payment client speaks v2 only, so
that implementation's payment flow has no verdict.

**2. A network identifier that is not CAIP-2.** The same implementation names
the network `stellar-testnet` instead of `stellar:testnet`. It follows from
class 1: CAIP-2 identifiers arrived with v2.

**3. A rejection reported with the wrong status.** The official MPP SDK's
example channel server, on the SDK's `main` branch after its `mppx` 0.10.1
upgrade, refuses stale and replayed vouchers with HTTP 500 "internal payment
error" instead of 402. The refusal is correct; the status tells a client its
server is broken rather than that its payment was wrong. The commit before the
upgrade returns 402. Reported upstream as
[stellar/stellar-mpp-sdk#82](https://github.com/stellar/stellar-mpp-sdk/issues/82)
and **fixed by the maintainers in [#83](https://github.com/stellar/stellar-mpp-sdk/pull/83)** on 2026-09-28, before any
release carried it. Wasit 0.5.0 against the fixed commit passes all three
checks, with every rejection back to 402.

## Disclosure

- Class 3 is in open-source SDK code, not an operated service, and is not
  exploitable, so it went to the SDK's public issue tracker, as
  [`SECURITY.md`](../../SECURITY.md) describes for upstream conformance defects.
- Classes 1 and 2 concern defi-copilot. They are not exploitable. Both went
  to its operator privately, by Telegram, on 2026-09-28, before the service was
  named here.

## What the implementations found in Wasit

Running Wasit against code it did not write found defects in Wasit itself.
Each was fixed and is recorded in the [changelog](../../CHANGELOG.md):

- The official x402 reference showed that `X402-07`'s corruption is caught at
  XDR decoding rather than at signature verification, so the check proved less
  than its description claimed. The description was corrected at once, and
  from 0.6.0 the check corrupts only the authorization signature.
- The official MPP reference showed that `MPP-12` and `MPP-14` called a refused
  replay a double-spend whenever the status was not 402. Fixed in 0.5.0.
- defi-copilot showed that 0.4.0 misreported an x402 v1 challenge and failed
  payment checks that never sent a payment. Fixed in 0.5.0.

## Limits

- Three implementations, one of them third-party. That meets the SOW's minimum
  and is not a survey of the ecosystem.
- defi-copilot ran as a local instance of its operator's published code, at the
  operator's direction, because its hosted deployment had been retired.
- Each result describes one implementation, at one commit, at one moment. A
  pass is a statement about the published checks, not a security audit.
- Defects found in the official `@stellar/mpp` SDK itself are written up
  separately in [upstream-sdk.md](upstream-sdk.md).
