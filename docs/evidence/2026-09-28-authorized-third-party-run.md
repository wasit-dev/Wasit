# 2026-09-28 — Authorized third-party run, and 0.5.0 registry parity

**Wasit:** `@wasit-dev/cli@0.5.0`, installed from the npm registry into an
empty directory, reporting `0.5.0` and resolving `@wasit-dev/core@0.5.0`. Not a
checkout.
**Network:** Stellar testnet.

This is the SOW's "third-party ecosystem service tested with the operator's
explicit authorization". The service is **[defi-copilot](https://github.com/fxjrin/defi-copilot)**, a
pay-per-decision DeFi intelligence API for AI agents on Stellar. Its operator
gave [written permission to name it](https://github.com/fxjrin/defi-copilot/issues/1#issuecomment-5860415354) on 2026-09-28, asking that the
report say the run was against a local instance because the hosted backend is
no longer live. It was published anonymised earlier the same day, before that
permission arrived.

---

## Authorization

- **Written, by the operator.** [Given on 2026-09-27](https://github.com/fxjrin/defi-copilot/issues/1#issuecomment-5856332724) by the owner of
  the repository, in reply to a request that described the checks:
  authorization to run Wasit's x402 conformance checks against defi-copilot on
  Stellar testnet.
- **Where it ran.** The operator had retired the hosted backend and directed
  that the service be run from their published code on testnet. It ran as a
  **local instance** on our machine, unmodified, at `e97879d` (the
  repository's head, 2026-04-12), set up with the
  operator's own documented commands. The operator's code generated and
  funded its own fresh testnet wallet; none of our keys were given to it.
- **What was not done.** No request of any kind was made to the service's live
  deployment.

## Results

Two paid routes, 0.001 USDC each.

| Check | Route 1, full | Route 2, read-only |
|---|---|---|
| `X402-01` 402 Response Status | PASS | PASS |
| `X402-02` Payment Header Present | **FAIL** | **FAIL** |
| `X402-03` Header Payload Decodable | PASS | PASS |
| `X402-04` Required Fields Present | PASS | PASS |
| `X402-05` Network Identifier Valid | **FAIL** | **FAIL** |
| `X402-06` Signature Resubmit Accepted | SKIP | — |
| `X402-07` Invalid Signature Rejected | SKIP | — |

```
FAIL  X402-02  Payment Header Present
      Neither PAYMENT-REQUIRED nor X-Payment header was present. The response body carries an x402 v1 challenge instead; the `exact` scheme on Stellar is defined for v2 only, which signals payment in the PAYMENT-REQUIRED header.
FAIL  X402-05  Network Identifier Valid
      "stellar-testnet" does not match stellar:testnet or stellar:pubnet, the CAIP-2 identifiers the `exact` scheme on Stellar defines.
SKIP  X402-06  Signature Resubmit Accepted
      Skipped: the target issued an x402 v1 challenge, and Wasit pays through the v2 `exact` scheme on Stellar, the only version the spec defines, so no payment was attempted (see X402-02).
```

**No payment was sent.** The service's own log recorded no verify or settle
call.

## What the results mean

defi-copilot implements **x402 v1**: its 402 challenge is a JSON body with
`x402Version: 1`, as the v1 HTTP transport defines, built on a community
package outside the official `@x402/*` line (`x402-stellar@0.2.0`). The `exact` scheme on Stellar is
defined for **v2 only**
([scheme_exact_stellar.md](https://github.com/x402-foundation/x402/blob/02e80f3/specs/schemes/exact/scheme_exact_stellar.md):
"❌ `v1` - we don't plan to support v1 for now"), with the challenge in the
`PAYMENT-REQUIRED` header and CAIP-2 network identifiers. So:

- **`X402-02` and `X402-05` are divergences from the Stellar spec**, not
  malformed output: the v1 challenge itself is well-formed and complete
  (`X402-03`, `X402-04`).
- **`X402-06` and `X402-07` have no verdict.** Wasit pays through the v2
  scheme, so it cannot exercise a v1 payment flow. Nothing is claimed about how
  defi-copilot handles valid or corrupted payments.
- Neither divergence is exploitable. Both were sent to the operator privately,
  by Telegram, on 2026-09-28, before this document named the service.

## What this run found in Wasit

The first run, on 2026-09-28 with **0.4.0**, reported `X402-02` FAIL with no
explanation, skipped `X402-03`–`05`, and reported `X402-06` and `X402-07` as
FAIL although no payment was ever built or sent, so `X402-07` read as a
corrupted signature that was not rejected. `docs/CHECKS.md` already said a
challenge that cannot be read has no verdict. That is fixed in 0.5.0; see
[CHANGELOG](../../CHANGELOG.md) and the note on x402 v1 in
[CHECKS.md](../CHECKS.md). The results above are from the published 0.5.0.

## 0.5.0 registry parity, same package, same session

Against Wasit's own fixtures, as for 0.3.0 and 0.4.0:

| Suite | Result |
|---|---|
| x402, full (`X402-01`–`07`) | **7/7 PASS**, including a settled payment and a refused corrupted signature |
| MPP charge (`MPP-01`) | **PASS**, settled on-chain for exactly the advertised amount: [`11b41972…2d18`](https://stellar.expert/explorer/testnet/tx/11b41972daca11545aa0b14312bd126697d741ca158717c4ff330702d8522d18) |
| MPP channel (`MPP-10`–`14`) | **3 PASS**, `MPP-10` skipped (no expected parameters supplied), `MPP-13` skipped (destructive) |

Identical to the 0.4.0 results on the same fixtures: the published 0.5.0
behaves as the source it was built from.

## Limits

- One authorized third-party service. The SOW asks for at least one.
- Run on our machine from the operator's published code, at the operator's
  direction, because the hosted deployment had been retired. A deployment the
  operator runs could be configured differently.
- x402 only. The service offers no MPP.
