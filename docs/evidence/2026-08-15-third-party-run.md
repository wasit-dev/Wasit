# Ecosystem Survey — x402 Read-Only Checks Against Cloned Public Repos

> **Not the SOW's third-party-authorization item.** Every target was cloned
> and run on our machine, and no operator was contacted.

**Date:** 2026-08-15
**Wasit:** branch `main`, x402 read-only checks (`X402-01` … `X402-05`)
**Method:** every target was cloned and run locally from source against Stellar
testnet. No hosted deployment belonging to any of these projects was contacted.
Payment checks (`X402-06`, `X402-07`) were not run — this pass covers the
challenge-shape checks only, which cost nothing and settle nothing.

## Summary

Seven x402-related repositories in the Stellar ecosystem were examined. Three
expose a Stellar-denominated paid endpoint that can be exercised from a clone;
all three conform on every check. The other four do not expose one, for four
different reasons.

| Repository | Commit | x402 package | Verdict |
|---|---|---|---|
| `mks044/reapp-poc` | `7fadd4c` (2026-04-28) | `@x402/express@2.9.0` | **5/5 PASS** |
| `Hoops-Finance/calypso-x402` | `e33d521` (2026-04-13) | `@x402/express@2.9.0` | **5/5 PASS** |
| `Andy00L/x402-autopilot` | `b9e88e2` (2026-04-12) | `@x402/express@latest` | **5/5 PASS** |
| `TKCollective/x402-research-skill` | `9c657fa0` (2026-08-09) | `@coinbase/x402@2.1.0`, `@x402/core@2.11.0` | Stellar path built, not mounted |
| `winsznx/routedock` | `806e434` (2026-08-08) | `@x402/core@2.9.0`, `mppx@0.5.7` | Client SDK |
| `fxjrin/defi-copilot` | `e97879d` (2026-04-12) | `x402-stellar@0.2.0` | Client + facilitator |
| `StreamCharge/ApiCharge` | `fe756fe` (2026-05-19) | none | No x402 code in the public repo |

## Results

### mks044/reapp-poc — 5/5 PASS

REAPP (Real Agentic Payment Protocol), SCF-funded. Paid endpoint:
`POST /api/search`, $0.01, `stellar:testnet`, port 8080.

```
PASS  X402-01  402 Response Status
PASS  X402-02  Payment Header Present
PASS  X402-03  Header Payload Decodable
PASS  X402-04  Required Fields Present
PASS  X402-05  Network Identifier Valid
```

Challenge carried `x402Version: 2`, `amount: "100000"`, `network:
"stellar:testnet"`, `extra.areFeesSponsored: true`, under `PAYMENT-REQUIRED`.

Notable: this is the only one of the three whose middleware configures
`accepts` as an array rather than a single object. The emitted challenge is
identical in shape to the other two, so `@x402/*` normalises both forms.

```bash
wasit test --target http://localhost:8080/api/search --method POST --body '{}' --read-only
```

### Hoops-Finance/calypso-x402 — 5/5 PASS

Paid endpoint: `POST /plan`, $0.01, `stellar:testnet`, port 9990. Uses an
in-process facilitator rather than a remote one.

Challenge carried `x402Version: 2`, `amount: "100000"`, under
`PAYMENT-REQUIRED`.

```bash
wasit test --target http://localhost:9990/plan --method POST --body '{}' --read-only
```

### Andy00L/x402-autopilot — 5/5 PASS

Paid endpoint: `GET /prices`, $0.001, `stellar:testnet`, port 4001. Four
paywalled services ship here (ports 4001–4004); one was exercised, since they
share a single resource-server construction in `data-sources/src/shared.ts`.

Challenge carried `x402Version: 2`, `amount: "10000"`, under
`PAYMENT-REQUIRED`.

Provenance note: this service reads `payTo` from a `WEATHER_API_WALLET`
variable the repository leaves blank. The address in the challenge is ours, not
the project's, and says nothing about the project. The same applies to REAPP's
`X402_PAY_TO`.

```bash
wasit test --target http://localhost:4001/prices --read-only
```

### Not testable

**`TKCollective/x402-research-skill`** — a live, commercially operated service
listed on Coinbase Bazaar that settles on Base, SKALE and, per its own
configuration, Stellar. Its Stellar facilitator is constructed and registered,
and three Stellar accept configs exist. None is mounted on a route; a comment
at `index.js:1045` states they are "preserved … for use on dedicated future
routes". The Stellar path is built but not yet reachable over HTTP.

**`winsznx/routedock`** — a client SDK. `MppSessionClient` and
`MppChargeClient` construct `Mppx` and call `mppx.fetch(url)`: this is the
payer side. Every `server.listen` in the repository is inside `__tests__`.

**`fxjrin/defi-copilot`** — the MCP server is a client; a local facilitator on
port 4022 exposes `/supported` and `/verify`. The resource server at
`src/server.ts` mounts no payment middleware and serves only `/health` and `/`.

**`StreamCharge/ApiCharge`** — SCF-funded and live at apicharge.com, but the
public repository contains no `@x402/*` dependency and no payment middleware,
only Stellar RPC examples. The paid implementation lives somewhere that is not
public, so it cannot be exercised from a clone. Testing it would require the
operator's participation.

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
Stellar-denominated paid endpoint. This is not a criticism of any of them —
each is a client, mid-migration, or closed-source by choice — but the count of
*running, externally exercisable* Stellar x402 services is lower than the count
of projects describing themselves as such.

**No target ran from a clean clone.** All three testable services needed a
repair before they would start: an uninitialised orchestrator wallet, a
facilitator API key with no working keyless path, and a workspace package that
had to be compiled before the API would boot. None of these is a defect worth
reporting; together they are the point. If exercising someone's conformance
requires replicating their production stack, almost nobody will do it — which
is the argument for a tool an operator can point at their own deployment rather
than one that demands outsiders reproduce it.

**A resource server will not start when no facilitator answers.**
`@x402/core`'s `x402ResourceServer.initialize()` throws when it cannot load
supported payment kinds from any facilitator, so the service fails at boot
rather than at payment time. Availability of an x402 service is coupled to
availability of a third party. Not a spec violation; an operational property
worth knowing.

**A documented keyless fallback that cannot be taken.**
`x402-autopilot`'s `.env.example` states the data-source servers "fall back to
https://x402.org/facilitator (Coinbase) if OZ_FACILITATOR_URL is unset". The
URL does default correctly, but `createAuthHeaders` in
`data-sources/src/shared.ts` calls `env("OZ_API_KEY")` unconditionally and that
helper throws on an empty value, so the keyless path cannot be taken. Recorded
here rather than reported upstream because it is a defect in a hackathon
project rather than in an SDK; the fix would be to attach `createAuthHeaders`
only when the OpenZeppelin facilitator is in use. REAPP has the same
unconditional key requirement, and both were worked around by pointing at
`https://x402.org/facilitator`, which ignores the unused bearer token.

**CAIP-2 is not universal.** `defi-copilot` identifies its network as
`stellar-testnet`, not the CAIP-2 form `stellar:testnet` that `X402-05`
requires and that all three testable services emit. The string appears in that
project's facilitator `/supported` response and service metadata rather than in
a 402 challenge, so no check observed it — but it is a divergence, in a package
(`x402-stellar@0.2.0`) independent of the `@x402/*` line.

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
- No operator was contacted before this run, and none is named as having
  endorsed or authorised it. Every repository is public and openly licensed;
  nothing here required permission, and nothing here should be read as an
  operator's participation.

## Reproducing

```bash
mkdir -p targets && cd targets
git clone https://github.com/mks044/reapp-poc.git
git clone https://github.com/Hoops-Finance/calypso-x402.git
git clone https://github.com/Andy00L/x402-autopilot.git
```

Each needs its own environment file; see each repository's own instructions.
For all three, pointing the facilitator at `https://x402.org/facilitator`
avoids needing an OpenZeppelin Channels API key.