# Wasit: Instaward Completion Summary

**Builder:** Muhammad Dzakwan Najmi ([@dzakwannajmi](https://github.com/dzakwannajmi))
**Program:** Stellar Chapter Ambassador Indonesia Instaward, $3,600 in XLM
**Repo:** [github.com/wasit-dev/wasit](https://github.com/wasit-dev/wasit) · **Site:** [usewasit.dev](https://usewasit.dev)
**Packages:** `@wasit-dev/core`, `@wasit-dev/cli`, `@wasit-dev/server`, all at **0.4.0** on npm
**Date:** 2026-09-20 (updated 2026-09-24)

## What Wasit is

Wasit is an open-source CLI and MCP server that tests whether a service's x402 or MPP (Machine Payments Protocol) implementation on Stellar actually conforms to the spec, before it goes to mainnet. It runs the real payment flow against a live target rather than validating a schema, then checks Stellar RPC directly for what settled on-chain rather than trusting the target's own response. Thirteen checks are published and traced to spec clauses in [`docs/CHECKS.md`](https://github.com/wasit-dev/wasit/blob/main/docs/CHECKS.md): seven for x402, one for MPP charge mode, five for MPP channel mode.

## Deliverables against the SOW

| Deliverable | Status | Evidence |
|---|---|---|
| **D1** (x402 CLI + CHECKS.md) | Done | [Repo](https://github.com/wasit-dev/wasit), [CHECKS.md](https://github.com/wasit-dev/wasit/blob/main/docs/CHECKS.md), [npm](https://www.npmjs.com/package/@wasit-dev/cli), [terminal recording](https://github.com/wasit-dev/wasit#trying-it) run from the published 0.4.0 package |
| **D2** (MPP Charge + Channel Simulator) | Partially done | [Terminal output, incl. negative checks](https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-05-full-settlement-run.md); **the third-party-authorization row is open**, see below |
| **D3** (MCP Server wrapper, optional, built anyway) | Done | [npm](https://www.npmjs.com/package/@wasit-dev/server), [MCP config guide](https://github.com/wasit-dev/wasit/blob/main/docs/guides/mcp.md), [screen recording](https://github.com/wasit-dev/wasit/releases/tag/v0.4.0) |
| **Overall** (completion summary + walkthrough video) | Partially done | This document; **walkthrough video still pending**, see below |

## What "done" means here

Every check in the catalogue is exercised against Wasit's own bundled fixture servers, built on the real `@stellar/mpp`, `mppx` and `@x402/stellar` SDKs rather than mocks, with real testnet settlements confirmed on-chain from the token contract's own transfer event, not from the target's claim of success. The published npm packages were verified byte-for-byte against source twice: once at 0.3.0 ([2026-09-06](https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-06-npm-package-parity-run.md)) and again for the x402 half of 0.4.0 through the terminal recording above, which runs `npx @wasit-dev/cli@0.4.0` rather than a local build. Wasit was also run once against code it did not write, `stellar/x402-stellar`'s own reference implementation, and passed on all checks it could reach ([2026-09-06](https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-06-reference-implementation-run.md)).

0.4.0 fixed two defects in Wasit itself, found by running the MCP server the way an agent actually uses it rather than the way the CLI does: a charge-mode payment client was silently breaking every channel check that ran afterward in the same process, and a setup failure that looked identical to a real conformance failure was being reported as one. Both are written up at [`docs/evidence/2026-09-17-cross-check-isolation-run.md`](https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-17-cross-check-isolation-run.md).

## What is honestly still open

**Third-party validation (D2).** The SOW asks for at least one third-party service tested with the operator's explicit authorization. Six candidates were identified. Two, `yripper/stellarpay#1` and `Stellar-Light/stellar-pay#3`, have live self-test outreach threads with zero replies since 31 August. A permission request to RouteDock got no reply either. `xlmtools` also has an open thread with zero replies, and as of 2026-09-24 its API host no longer serves its API. `defi-copilot`'s API host has presented an invalid TLS certificate throughout, so outreach there was never sent. Both of those projects have been inactive since April. The sixth, AgentOracle, turned out to offer no Stellar payment path to test. This is the one SOW line that depends on someone outside the project responding, and it has not converted yet. The SOW's own fallback, standing up a self-hosted reference service under Wasit's own authorization, has not been triggered yet either; that decision is still open.

**Registry parity for 0.4.0.** The 0.3.0 release was verified against the npm registry across all thirteen checks. 0.4.0 has only had its x402 half verified this way, through the terminal recording. The MPP half of that parity check has not been run yet.

**Two-minute walkthrough video.** Deliberately not recorded yet. The raw footage exists (a 57.8-second CLI terminal capture and a 60-second MCP session, both already used elsewhere in the repo's evidence), but has not been cut into a walkthrough.

**GitHub Release note.** The `v0.4.0` release on GitHub already carries the MCP session video embedded in its description, playable in place.

## Not part of this SOW, worth noting

An upstream contribution: three defects filed against the official `@stellar/mpp` SDK ([#66](https://github.com/stellar/stellar-mpp-sdk/issues/66), [#67](https://github.com/stellar/stellar-mpp-sdk/issues/67), [#70](https://github.com/stellar/stellar-mpp-sdk/issues/70)); #70 was closed as completed by a maintainer and a related fix has merged, though no `@stellar/mpp` release carries it yet, one independently confirmed by a downstream project (RouteDock PR #241). A pull request to list Wasit on the Stellar ecosystem's community skills index ([stellar-dev-skill#136](https://github.com/stellar/stellar-dev-skill/pull/136)) is open with passing checks, awaiting a maintainer's review; a merge means listed, not endorsed, and this document does not treat it as either.
