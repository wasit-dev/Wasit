# Full Settlement Run — x402 + MPP Charge + MPP Channel (Self-Hosted)

**Date:** 2026-09-05
**Wasit:** branch `main`, full check suites (not read-only) — x402 `X402-01`…`X402-07`,
MPP Charge `MPP-01`, MPP Channel `MPP-10`…`MPP-14`
**Method:** Wasit's own bundled fixture servers, run locally against Stellar
testnet — `packages/core/test/fixtures/x402-real-server.ts` (port 3001),
`mpp-charge-server.ts` (port 3002), `mpp-channel-server.ts` (port 3003). These are real SDK-backed
servers (`@x402/*`, `@stellar/mpp`), not mocks — see README's "Trying It"
section. Wallets used were already funded from earlier project work
(`STELLAR_PRIVATE_KEY`, `MPP_PAYER_SECRET`, `COMMITMENT_SECRET_HEX`), verified
live via `wasit wallet status` immediately before this run.

**What this is not:** this is a self-hosted run against our own fixtures, not
a third-party operator's live service, and no operator authorization was
needed or claimed. It does not satisfy the SOW's "at least one third-party
service tested with the operator's explicit authorization" requirement — that
remains open and tracked separately (see `docs/evidence/README.md`).
What it does establish is different and previously missing: every
*non-destructive* payment-settling check in Wasit — `X402-06`, `X402-07` and
`MPP-01`, the ones that submit and confirm a real Stellar testnet transaction
rather than only inspecting a challenge shape — was exercised end to end for
the first time. `MPP-13`, the one settling check that is destructive, was not:
see "Limits of this run" below. The 2026-08-15 third-party run
covered only the read-only x402 checks and explicitly stated the settlement
checks and every MPP check were untested; this run closes that specific gap.

## Summary

| Suite | Target | Result |
|---|---|---|
| x402 full flow | `http://localhost:3001/protected` | **7/7 PASS** |
| MPP Charge | `http://localhost:3002/data` | **1/1 PASS** |
| MPP Channel | `http://localhost:3003/data` | **3 passed, 2 expected-skipped** |

## x402 full flow — 7/7 PASS

```
PASS  X402-01  402 Response Status
PASS  X402-02  Payment Header Present
PASS  X402-03  Header Payload Decodable
PASS  X402-04  Required Fields Present
PASS  X402-05  Network Identifier Valid
PASS  X402-06  Payment Settles
PASS  X402-07  Rejects Corrupted Signature
```

`X402-06` submitted a real, correctly-signed payment and confirmed the
resource server accepted it and returned the paid resource. `X402-07`
submitted a payment with a deliberately corrupted signature and confirmed the
resource server rejected it — a negative conformance result, not just a
happy-path pass.

```bash
wasit test --target http://localhost:3001/protected
```

## MPP Charge — 1/1 PASS

```
PASS  MPP-01  Charge Settles
```

Settled with a real transaction on Stellar testnet:

```
bb9db93f913ec8254629128f23f178499ee0617d02e39e0c71d9702678ec6964
```

Verifiable at:
https://stellar.expert/explorer/testnet/tx/bb9db93f913ec8254629128f23f178499ee0617d02e39e0c71d9702678ec6964

```bash
wasit mpp-charge --target http://localhost:3002/data
```

## MPP Channel — 3 passed, 2 expected-skipped

`MPP-10` (Channel Deploy) was skipped because no `--expect-*` flags were
supplied for this run — by design. It asserts the channel's on-chain parameters
(`--expect-token`, `--expect-from`, `--expect-to`, `--expect-refund-period`),
and only the channel's operator knows what those should be, so with none given
there is nothing to compare against. This is not a failure of the target or the
tool. (Cumulative amounts belong to `MPP-11`/`MPP-12`, not to `MPP-10` — see
[CHECKS.md](../CHECKS.md).) `MPP-13` (the destructive channel-close
check) was skipped by design, since it permanently closes the channel and
this run's channel was reused from prior sessions. Both skips are expected,
documented behavior, not gaps in this run.

```bash
wasit mpp-channel --target http://localhost:3003/data
```

## Limits of this run

- Self-hosted only. No third-party operator's service was touched, and this
  does not stand in for the SOW's third-party-authorization requirement.
- Wallets were pre-funded from earlier sessions rather than created fresh
  inside this run, so this is not evidence for the wallet-creation/funding
  tooling (`wasit wallet create`, `wasit wallet fund`) in isolation — that
  was exercised separately and informally, not captured as evidence here.
- Run once. Not repeated across multiple sessions to rule out flakiness in
  Horizon/testnet response times.
- `MPP-10` and `MPP-13` did not execute their actual assertions this run
  (both skipped by design, see above) — this run demonstrates they skip
  correctly, not that they pass when exercised.

## Reproducing

```bash
# terminal 1
npx tsx packages/core/test/fixtures/x402-real-server.ts
# terminal 2
npx tsx packages/core/test/fixtures/mpp-charge-server.ts
# terminal 3
npx tsx packages/core/test/fixtures/mpp-channel-server.ts
# terminal 4
wasit wallet status
wasit test --target http://localhost:3001/protected
wasit mpp-charge --target http://localhost:3002/data
wasit mpp-channel --target http://localhost:3003/data
```

Requires `@wasit-dev/cli` 0.3.0 or branch `main` — `wasit wallet` was added in
0.3.0 and is not present in the published 0.2.0. Also requires
`STELLAR_PRIVATE_KEY`, `MPP_PAYER_SECRET`, and `COMMITMENT_SECRET_HEX` set in
`.env`, each funded with testnet XLM (and, for the charge/channel
roles, a USDC trustline) — see `docs/guides/cli.md`'s "Wallet setup" section
or `wasit wallet create --role <role> --fund`.

## Corrections

- **2026-09-05, after review:** the summary above originally read "every
  payment-settling check ... was exercised end to end", which contradicted this
  document's own Limits section — `MPP-13` settles and was skipped. Narrowed to
  the non-destructive settling checks. The stated reason for `MPP-10`'s skip was
  also wrong (it named a cumulative amount; `MPP-10` asserts the channel's
  on-chain deploy parameters) and the fixture path in Method was missing its
  `packages/core/` prefix. No result changed: the run itself is as recorded.
