# Job 00 — Repo Foundation

Status: ✅ **DONE** · Deliverable: **D1 + D2 + D3** (the software itself)

## Goal
Build the actual conformance tester: x402 checks, MPP Charge + Channel checks,
a CLI, an MCP server, and the documentation that makes the check catalogue
verifiable rather than a claim.

## What shipped

**x402 (D1).** Seven checks (`X402-01`–`07`) in `packages/core/src/x402/`,
covering the 402 status, payment header, payload decode, required fields
(version-aware), network identifier format, a real accepted payment, and a
rejected corrupted signature. Documented in `docs/CHECKS.md` with a spec
clause per check.

**MPP Charge + Channel (D2).** `MPP-01` (charge, on-chain settlement verified
via CAP-46 transfer events) and `MPP-10`/`11`/`12`/`13`/`14` (channel:
deploy, cumulative ordering, challenge replay, close settlement, commitment
replay) in `packages/core/src/mpp/`. Negative checks (`12`, `14`) confirmed
rejecting as required.

**MCP server (D3, optional in the SOW).** `packages/server/src/index.ts`
exposes `wasit_x402_test`, `wasit_mpp_charge_test`, `wasit_mpp_channel_test`,
and the destructive-gated `wasit_mpp_channel_test_with_close`.

**Docs.** `README.md`, `SECURITY.md`, `LICENSE` (Apache-2.0),
`docs/guides/{cli,mcp,configuration}.md`,
`docs/design/{scope-boundary,error-model,destructive-checks}.md`.

**Upstream reports.** Two defects found in `@stellar/mpp` while building
channel mode, filed against `stellar/stellar-mpp-sdk`: #66 (channel
rejections collapse to one generic error) and #67
(`feePayer.envelopeSigner` names the wrong concept). Both independently
confirmed by RouteDock's PR #241, which fixed the same issues downstream.
Documented in `docs/findings/upstream-sdk.md`.

## Result
All of the above is live and committed on `main` as of this engagement.
Nothing in this job is open — it's recorded here as the baseline the later
jobs (npm publish, validation, recordings) build on.
