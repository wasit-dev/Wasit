# Published-Package Parity Run — npm 0.3.0 vs `main` (Self-Hosted)

**Date:** 2026-09-06
**Wasit:** `@wasit-dev/cli@0.3.0` and `@wasit-dev/core@0.3.0` installed from
the npm registry into an empty project, compared against the same suites run
from a fresh `npm run build` of `main` at commit `2ba33aa`.
**Environment:** macOS, Node `v26.8.1`.
**Method:** Wasit's own bundled fixture servers, run locally against Stellar
testnet — `packages/core/test/fixtures/x402-real-server.ts` (port 3001),
`mpp-charge-server.ts` (port 3002), `mpp-channel-server.ts` (port 3003). Full
check suites, not read-only. Wallets were already funded from earlier project
work and verified with `wasit wallet status` immediately before the run, from
the npm install rather than the checkout.

**Why this run exists.** Everything Wasit verifies about itself in CI runs
against the working tree, where npm has deduplicated one dependency graph
across all three workspaces. `npm run verify:clean-install` narrows that gap by
packing tarballs from the workspace, but it still never touches the registry,
and it exercises no payment: it drives the CLI and the MCP server with no keys
and no target. So until now, no settlement check had ever been executed by the
artifact a user actually installs. That is the exact shape of the defect that
shipped in `0.1.1`, where the published CLI lacked a subcommand its own
published docs described.

**What this is not:** a self-hosted run against our own fixtures, not a
third-party operator's live service. No operator authorization was needed or
claimed, and this does not satisfy the SOW's "at least one third-party service
tested with the operator's explicit authorization" requirement, which remains
open and tracked in the evidence package (`docs/evidence/README.md`).

## Summary

| Suite | Target | npm 0.3.0 | `main` build | Match |
|---|---|---|---|---|
| x402 full flow | `http://localhost:3001/protected` | conformant, 7 passed | conformant, 7 passed | yes |
| MPP Charge | `http://localhost:3002/data` | conformant, 1 passed | conformant, 1 passed | yes |
| MPP Channel | `http://localhost:3003/data` | conformant, 3 passed, 2 skipped | conformant, 3 passed, 2 skipped | yes |

All three exited `0` on both sides. The comparison was made on the structured
`--json` output: `outcome`, the four per-status counts, and the ordered list of
`(check id, status)` pairs. Detail strings and transaction hashes were not
compared — see *Limits* below for why.

## x402 full flow — 7/7 PASS

```
X402-01  PASS  Server responded with 402 as required.
X402-02  PASS  Payment header found.
X402-03  PASS  Header decoded to valid JSON.
X402-04  PASS  All required v2 fields present.
X402-05  PASS  Network identifier "stellar:testnet" is valid.
X402-06  PASS  Valid payment accepted (HTTP 200).
X402-07  PASS  Corrupted payment correctly rejected (HTTP 402).
```

`X402-06` and `X402-07` each settle a real testnet payment. `X402-07` is a
negative check: it passes only because the fixture *rejected* a deliberately
corrupted signature.

## MPP Charge — 1/1 PASS

```
MPP-01  PASS  Settled on-chain for exactly the advertised 10000 base units of
              CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA to
              GALVZ57VAY6BE33WYPJMUJ27PFAUDRQ6ATTVMIIF4STTGQTXDBEIBXUI,
              verified from the transfer event
              (tx d0cb0f5c2bdbea2ad7b7b576155a04f3e300b9955037f8432e86fcb3a0bddce3).
```

Independently confirmed on-chain after the run, via Horizon testnet rather than
through Wasit: **successful, ledger 4531184, 2026-09-06T07:25:07Z**, source
account `GDHQTUA2P5OO7EXSZ5MAUID4HUFM3H7XP6B5GJNQSRX3N675KCFNAFVK`, which is
the `mpp-charge` role reported by `wasit wallet status` before the run.

## MPP Channel — 3 passed, 2 expected-skipped

```
MPP-10  SKIP  Skipped: expected on-chain parameters not supplied
              (token, from, to, refundWaitingPeriod).
MPP-11  PASS  Both ordering rules enforced: a commitment equal to the
              cumulative (70000) and one that under-covers the price (79999)
              were each rejected with HTTP 402.
MPP-12  PASS  Byte-identical credential correctly rejected on replay (HTTP 402).
MPP-14  PASS  Captured commitment (90000) correctly rejected when re-presented
              against a fresh challenge (HTTP 402).
MPP-13  SKIP  Skipped (destructive): closing settles the channel on-chain and
              permanently ends it.
```

`MPP-11`, `MPP-12` and `MPP-14` are all negative checks — each passes only
because the fixture refused something it was required to refuse. `MPP-12` and
`MPP-14` together cover the double-spend case the official client SDK cannot
express, since it always re-signs.

## Limits of this run

- **Self-hosted only.** No third-party operator's service was touched. This
  does not stand in for the SOW's third-party-authorization requirement.
- **`MPP-10` and `MPP-13` did not execute their assertions.** Both skipped by
  design. This run shows they skip correctly, not that they pass when
  exercised. `MPP-13` is the one settling check still never exercised.
- **The two sides are separate runs, not a replay.** Each settled its own
  payments against the same fixtures, so transaction hashes and timings differ
  by construction. Identical `(id, status)` across 13 checks is strong evidence
  of behavioural parity; it is not a byte-level equivalence proof of the two
  builds.
- **Detail strings were not compared.** A divergence that changed only wording
  while preserving every status would not have been caught here.
- **Run once.** Not repeated across sessions to rule out flakiness in Horizon
  or testnet response times.
- **Wallets were pre-funded**, not created inside this run, so this is not
  evidence for `wasit wallet create` / `wasit wallet fund` in isolation.
- **One direction only.** The published MCP server (`@wasit-dev/server@0.3.0`)
  was smoke-tested separately the same day — handshake reporting `0.3.0`, three
  tools without the destructive opt-in and four with it, and `wasit://checks`
  resolving to 16302 characters — but it was not driven through a settling run.

## Reproducing

Terminal A, from a checkout of `main`:

```bash
npx tsx packages/core/test/fixtures/x402-real-server.ts
npx tsx packages/core/test/fixtures/mpp-charge-server.ts
npx tsx packages/core/test/fixtures/mpp-channel-server.ts
```

Terminal B, in an empty directory holding only a `.env` with funded testnet
keys:

```bash
npm install @wasit-dev/cli@0.3.0
wasit test        --target http://localhost:3001/protected --json > npm-x402.json
wasit mpp-charge  --target http://localhost:3002/data      --json > npm-charge.json
wasit mpp-channel --target http://localhost:3003/data      --json > npm-channel.json
```

Then the same three from `packages/cli/dist/index.js` after `npm run build`,
and compare `outcome`, the per-status counts, and the ordered `(id, status)`
pairs of each pair of files.
