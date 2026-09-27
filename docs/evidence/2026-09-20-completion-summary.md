# Wasit: Instaward Completion Summary

**Builder:** Muhammad Dzakwan Najmi ([@dzakwannajmi](https://github.com/dzakwannajmi))
**Program:** Stellar Chapter Ambassador Indonesia Instaward, $3,600 in XLM
**Repo:** [github.com/wasit-dev/wasit](https://github.com/wasit-dev/wasit) · **Site:** [usewasit.dev](https://usewasit.dev)
**Packages:** `@wasit-dev/core`, `@wasit-dev/cli`, `@wasit-dev/server`, all at **0.5.0** on npm
**Date:** 2026-09-20 (updated 2026-09-28)

## What Wasit is

Wasit is an open-source CLI and MCP server that tests whether a service's x402 or MPP (Machine Payments Protocol) implementation on Stellar actually conforms to the spec, before it goes to mainnet. It runs the real payment flow against a live target rather than validating a schema, then checks Stellar RPC directly for what settled on-chain rather than trusting the target's own response. Thirteen checks are published and traced to spec clauses in [`docs/CHECKS.md`](https://github.com/wasit-dev/wasit/blob/main/docs/CHECKS.md): seven for x402, one for MPP charge mode, five for MPP channel mode.

## Deliverables against the SOW

| Deliverable | Status | Evidence |
|---|---|---|
| **D1** (x402 CLI + CHECKS.md) | Done | [Repo](https://github.com/wasit-dev/wasit), [CHECKS.md](https://github.com/wasit-dev/wasit/blob/main/docs/CHECKS.md), [npm](https://www.npmjs.com/package/@wasit-dev/cli), [terminal recording](https://github.com/wasit-dev/wasit#trying-it) run from the published 0.4.0 package |
| **D2** (MPP Charge + Channel Simulator) | Done | [Terminal output, incl. negative checks](https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-05-full-settlement-run.md); [third-party service tested with its operator's written authorization](https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-28-authorized-third-party-run.md) (anonymised); [written findings document](https://github.com/wasit-dev/wasit/blob/main/docs/findings/conformance-findings.md), in aggregate across three implementations |
| **D3** (MCP Server wrapper, optional, built anyway) | Done | [npm](https://www.npmjs.com/package/@wasit-dev/server), [MCP config guide](https://github.com/wasit-dev/wasit/blob/main/docs/guides/mcp.md), [screen recording](https://github.com/wasit-dev/wasit/releases/tag/v0.4.0) |
| **Overall** (completion summary + walkthrough video) | Done | This document; [two-minute walkthrough video](https://youtu.be/5SbNf7j4dbc) |

## What "done" means here

Every check in the catalogue is exercised against Wasit's own bundled fixture servers, built on the real `@stellar/mpp`, `mppx` and `@x402/stellar` SDKs rather than mocks, with real testnet settlements confirmed on-chain from the token contract's own transfer event, not from the target's claim of success. The published npm packages were verified against source twice: once at 0.3.0 ([2026-09-06](https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-06-npm-package-parity-run.md)) and again for 0.4.0, through the terminal recording above for x402 and the official-SDK run for MPP, both of which run `npx @wasit-dev/cli@0.4.0` rather than a local build. Wasit has also been run against code it did not write: `stellar/x402-stellar`'s reference implementation, where it passed every check it could reach ([2026-09-06](https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-06-reference-implementation-run.md)), and `stellar/stellar-mpp-sdk`'s own example servers, where it found a regression on the SDK's `main` branch ([2026-09-24](https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-24-official-sdk-reference-run.md)).

0.4.0 fixed two defects in Wasit itself, found by running the MCP server the way an agent actually uses it rather than the way the CLI does: a charge-mode payment client was silently breaking every channel check that ran afterward in the same process, and a setup failure that looked identical to a real conformance failure was being reported as one. Both are written up at [`docs/evidence/2026-09-17-cross-check-isolation-run.md`](https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-17-cross-check-isolation-run.md). 0.5.0 fixed two more, each found by running Wasit against code it did not write: an x402 v1 challenge was misreported and payment checks that never sent a payment were marked FAIL, and `MPP-12`/`MPP-14` called a refused replay a double-spend. The published 0.5.0 was verified against Wasit's own fixtures the same day, with results identical to 0.4.0 ([2026-09-28](https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-28-authorized-third-party-run.md)).

## The third-party row

The SOW asks for at least one third-party ecosystem service tested with the operator's explicit authorization, the remainder self-hosted reference services built from the official SDKs, and findings reported in aggregate, naming a service only with its operator's written permission. Outreach went to eleven x402 or MPP projects between 31 August and 25 September, seven of them asked directly for written authorization. One operator granted it in writing on 2026-09-27. Their hosted deployment had been retired, so at their direction the run used their published code, unmodified, on testnet on our machine. Wasit 0.5.0 found the service speaks x402 v1, which the `exact` scheme on Stellar does not define, with a non-CAIP-2 network identifier; its payment flow therefore has no verdict, and nothing was paid ([write-up](https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-28-authorized-third-party-run.md)). The service is anonymised because its operator has not yet agreed to be named. Whether a run in that form meets the SOW's row is the Chapter Lead's call.

The remainder are the official references, run unmodified on our machine: `stellar/x402-stellar` (7/7) and `stellar/stellar-mpp-sdk`'s example servers, which surfaced [stellar-mpp-sdk#82](https://github.com/stellar/stellar-mpp-sdk/issues/82). All three are reported together, in aggregate, in the [written findings document](https://github.com/wasit-dev/wasit/blob/main/docs/findings/conformance-findings.md).

Earlier, read-only probes were made against the live endpoints of four candidate services before their operators had agreed (one never connected). That should not have happened, has stopped, and none of those results is reported anywhere in this repository.
## Not part of this SOW, worth noting

**A fourth upstream finding, from the fallback run.** Against the MPP SDK's own example channel server, `MPP-11`, `MPP-12` and `MPP-14` pass on the commit before the SDK's `mppx` 0.10.1 bump (2026-09-22) and fail on `main` after it. Every rejected voucher is now reported as HTTP 500 "internal payment error" instead of HTTP 402. The SDK still refuses every stale or replayed voucher, so nothing is honoured twice, but a client can no longer tell a refusal from an outage. It is not in any release yet, so it can be fixed before it ships; filed as [stellar-mpp-sdk#82](https://github.com/stellar/stellar-mpp-sdk/issues/82). The same run caught Wasit overstating that result as a "double-spend"; that wording is fixed in 0.5.0.

**Earlier upstream reports.** Three more defects were filed against the official `@stellar/mpp` SDK: [#66](https://github.com/stellar/stellar-mpp-sdk/issues/66), [#67](https://github.com/stellar/stellar-mpp-sdk/issues/67) and [#70](https://github.com/stellar/stellar-mpp-sdk/issues/70). A maintainer closed #70 as completed, and a related fix has merged, though no `@stellar/mpp` release carries it yet. One of the three was independently confirmed by a downstream project (RouteDock PR #241).

**Ecosystem listing.** A pull request to list Wasit on the Stellar ecosystem's community skills index ([stellar-dev-skill#136](https://github.com/stellar/stellar-dev-skill/pull/136)) is open with passing checks, awaiting a maintainer's review; a merge means listed, not endorsed, and this document does not treat it as either.
