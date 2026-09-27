# Ecosystem Survey — x402 Read-Only Checks Against Cloned Public Repos

> **Not the SOW's third-party-authorization item.** Every target was cloned
> and run on our machine, and no operator was contacted.
>
> **Projects are anonymised.** The SOW and `SECURITY.md` allow an individual
> service to be named only with its operator's written permission, and require
> any defect to go to the operator privately first. This document originally
> named the repositories; it was anonymised on 2026-09-25. Identities are
> available to the Chapter Lead on request.

**Date:** 2026-08-15
**Wasit:** branch `main`, x402 read-only checks (`X402-01` … `X402-05`)
**Method:** every target was cloned and run locally from source against Stellar
testnet. No hosted deployment belonging to any of these projects was contacted.
Payment checks (`X402-06`, `X402-07`) were not run — this pass covers the
challenge-shape checks only, which cost nothing and settle nothing.

## Summary

Seven x402-related public repositories in the Stellar ecosystem were examined.
Three expose a Stellar-denominated paid endpoint that can be exercised from a
clone; all three conform on every check. The other four do not expose one, for
four different reasons.

| Project | x402 package | Verdict |
|---|---|---|
| A | `@x402/express@2.9.0` | **5/5 PASS** |
| B | `@x402/express@2.9.0` | **5/5 PASS** |
| C | `@x402/express@latest` | **5/5 PASS** |
| D | `@coinbase/x402@2.1.0`, `@x402/core@2.11.0` | Stellar path built, not mounted |
| E | `@x402/core@2.9.0`, `mppx@0.5.7` | Client SDK |
| F | `x402-stellar@0.2.0` | Client + facilitator |
| G | none | No x402 code in the public repo |

## Results

### Projects A, B and C — 5/5 PASS each

```
PASS  X402-01  402 Response Status
PASS  X402-02  Payment Header Present
PASS  X402-03  Header Payload Decodable
PASS  X402-04  Required Fields Present
PASS  X402-05  Network Identifier Valid
```

Every challenge carried `x402Version: 2` and `network: "stellar:testnet"`
under `PAYMENT-REQUIRED`. Two of the three paid endpoints are `POST`, one is
`GET`. Prices were $0.01, $0.01 and $0.001. One of the three configures
`accepts` as an array rather than a single object; the emitted challenge is
identical in shape to the other two, so `@x402/*` normalises both forms.

Provenance note: two of the three read `payTo` from a variable the repository
leaves blank. The address in those challenges is ours, not the project's, and
says nothing about the project.

### Not testable

- **D** — the Stellar facilitator and accept configs exist but are not mounted
  on any route, so the Stellar path is not reachable over HTTP.
- **E** — a client SDK. It is the payer side; every `server.listen` in the
  repository is inside its tests.
- **F** — the public repository contains a client and a local facilitator. Its
  resource server mounts no payment middleware.
- **G** — the public repository contains no x402 dependency and no payment
  middleware. The paid implementation is not public, so testing it would need
  the operator's participation.

## Observations

**The payment header name divergence is real in the field.** All three testable
services emit `PAYMENT-REQUIRED`. Stellar's own conceptual guide describes that
name while its working quickstart, built on `@x402/stellar`, reads `X-Payment`.
`X402-02` accepts either. Before this run the divergence was evidenced only by
Stellar's documentation contradicting itself; it now has three field
confirmations and none for the other spelling.

**A Stellar-denominated x402 endpoint is harder to find than the ecosystem's
surface suggests.** All seven repositories advertise Stellar x402 support in
their READMEs, badges, or npm keywords. Four of the seven have no reachable
Stellar-denominated paid endpoint. Each is a client, mid-migration, or
closed-source by choice, but the count of *running, externally exercisable*
Stellar x402 services is lower than the count of projects describing
themselves as such.

**No target ran from a clean clone.** All three testable services needed a
repair before they would start. If exercising someone's conformance requires
replicating their production stack, almost nobody will do it, which is the
argument for a tool an operator can point at their own deployment rather than
one that demands outsiders reproduce it.

**A resource server will not start when no facilitator answers.**
`@x402/core`'s `x402ResourceServer.initialize()` throws when it cannot load
supported payment kinds from any facilitator, so the service fails at boot
rather than at payment time. Availability of an x402 service is coupled to
availability of a third party. Not a spec violation; an operational property
of the SDK worth knowing.

**CAIP-2 is not universal.** At least one package outside the `@x402/*` line
identifies Stellar testnet as `stellar-testnet` rather than the CAIP-2 form
`stellar:testnet` that `X402-05` requires. It appeared outside a 402 challenge,
so no check observed it.

Project-specific defects noted during setup are not described here. Under the
SOW they go to each operator privately first.

## What this run found in Wasit itself

`runX402ReadChecks` issued a bare `GET` at every target. Two of the three
testable endpoints are `POST`, so the wrong verb drew a 404 and the run
reported that the service never answers 402 — a false finding about a
conformant service, which is the worst output a conformance tester can produce.

Our own fixture is a `GET`, so nothing we wrote ourselves would have exposed
this. It took third-party code. `--method`, `--body` and `--header` now thread
through the whole suite, including the payment checks: had they addressed the
endpoint differently from the challenge read, they would have failed for the
wrong reason too. An unusable request shape is reported once through
`PREFLIGHT` as a configuration error rather than as a finding about the target.

## Limits of this run

- Only `X402-01` … `X402-05` were exercised. The payment checks, which settle
  real transactions, were not run against any third-party service.
- No MPP check was run against a third-party service.
- All three services were run from a clone on our own machine, configured by
  us. A passing result describes the code as published, not any deployment the
  project operates.
- No operator was contacted before this run, and none should be read as having
  endorsed or authorised it.
