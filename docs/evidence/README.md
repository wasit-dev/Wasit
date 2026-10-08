# Evidence Package — Wasit Instaward

Every evidence item the Statement of Work asks for, mapped to the proof that
satisfies it, followed by an index of every recorded run. For the one-page
narrative, read the [completion summary](2026-09-20-completion-summary.md).

**Builder:** Muhammad Dzakwan Najmi · **Program:** Stellar Chapter Ambassador
Indonesia Instaward · **Repo:** [wasit-dev/wasit](https://github.com/wasit-dev/wasit)
· **Site:** [usewasit.dev](https://usewasit.dev) · **Packages:** `@wasit-dev/core`,
`@wasit-dev/cli`, `@wasit-dev/server` at 0.6.0 · **As of:** 2026-10-01

| Deliverable | Status |
|---|---|
| D1 — x402 CLI + CHECKS.md | Done |
| D2 — MPP Charge + Channel Simulator | Done |
| D3 — MCP Server wrapper (optional) | Done |
| Overall — completion summary + walkthrough video | Done |

---

## D1 — x402 Protocol Compliance Validator (CLI) + CHECKS.md

| Evidence the SOW asks for | Proof |
|---|---|
| Public GitHub repo | [github.com/wasit-dev/wasit](https://github.com/wasit-dev/wasit) |
| Published check catalogue | [docs/CHECKS.md](../CHECKS.md): thirteen checks, each traced to a spec clause |
| Terminal recording / GIF | [`docs/media/d1-x402.gif`](../media/d1-x402.gif), recorded from `npx -y @wasit-dev/cli@0.4.0`: 7/7 on a full run, including a settled payment and a refused corrupted signature |

Supporting, not SOW rows:
[npm package](https://www.npmjs.com/package/@wasit-dev/cli) ·
[published package matches source](2026-09-06-npm-package-parity-run.md) ·
[7/7 against `stellar/x402-stellar`'s reference implementation](2026-09-06-reference-implementation-run.md),
[again with 0.6.0, `X402-06` verified on-chain](2026-09-30-x402-0.6.0-verification-run.md)

## D2 — MPP Charge and Channel Flow Simulator

| Evidence the SOW asks for | Proof |
|---|---|
| Terminal output, including negative conformance results | [Full settlement run](2026-09-05-full-settlement-run.md) against Wasit's own SDK-backed fixtures, with real testnet settlement; [run against the official MPP SDK's own example servers](2026-09-24-official-sdk-reference-run.md) from the published 0.4.0 |
| Written findings document | [docs/findings/conformance-findings.md](../findings/conformance-findings.md): results across three implementations in aggregate (defi-copilot, with its operator's written authorization; the official x402 and MPP references), three classes of divergence, and how each was disclosed |
| At least one third-party service tested with the operator's explicit authorization | [2026-09-28-authorized-third-party-run.md](2026-09-28-authorized-third-party-run.md): [defi-copilot](https://github.com/fxjrin/defi-copilot), with [written authorization](https://github.com/fxjrin/defi-copilot/issues/1#issuecomment-5856332724) from its operator on 2026-09-27 and [written permission to name it](https://github.com/fxjrin/defi-copilot/issues/1#issuecomment-5860415354). Run from the published 0.5.0 against both paid routes. The hosted backend is no longer live, so at the operator's direction it ran as a local instance of their published code |

The SOW allows the remainder of the three to be self-hosted reference services
built from the official SDKs. Those runs exist for both protocols
([x402](2026-09-06-reference-implementation-run.md),
[MPP](2026-09-24-official-sdk-reference-run.md)).

Separately from the SOW, defects found in the official `@stellar/mpp` SDK itself
are written up in [docs/findings/upstream-sdk.md](../findings/upstream-sdk.md)
and filed upstream as [#66](https://github.com/stellar/stellar-mpp-sdk/issues/66),
[#67](https://github.com/stellar/stellar-mpp-sdk/issues/67),
[#70](https://github.com/stellar/stellar-mpp-sdk/issues/70) and
[#82](https://github.com/stellar/stellar-mpp-sdk/issues/82).

## D3 — MCP Server wrapper

| Evidence the SOW asks for | Proof |
|---|---|
| MCP config | [docs/guides/mcp.md](../guides/mcp.md): exact `claude mcp add` command and Claude Desktop config |
| Screen recording of a check triggered from Claude Code via MCP | Embedded in the [v0.4.0 release](https://github.com/wasit-dev/wasit/releases/tag/v0.4.0): `wasit_mpp_charge_test` followed by `wasit_mpp_channel_test` in one session |

Supporting, not SOW rows:
[npm package](https://www.npmjs.com/package/@wasit-dev/server) ·
[written record of the same session, and the defect 0.4.0 fixed in it](2026-09-17-cross-check-isolation-run.md)

## Overall

| Evidence the SOW asks for | Proof |
|---|---|
| One-page completion summary | [2026-09-20-completion-summary.md](2026-09-20-completion-summary.md) |
| Two-minute walkthrough video | [https://youtu.be/5SbNf7j4dbc](https://youtu.be/5SbNf7j4dbc) |
| Live website | [usewasit.dev](https://usewasit.dev) |

---

## What is still open

Nothing the SOW requires. Two notes for the reviewer:

- **Where the third-party run ran.** defi-copilot's operator had retired the hosted
  deployment and directed that the run use their published code on testnet, on
  our machine. The authorization is written; whether a run in that form meets
  the SOW's third-party row is the Chapter Lead's call.
- **Outreach.** Between 31 August and 25 September, outreach went to eleven
  x402 or MPP projects, seven of them asked directly for written authorization.
  One granted it: defi-copilot. The others are not linked from this package.

## Index of runs

Each file records one run: what was tested, from which build, against what,
and what it does and does not establish. Newest first.

| Date | File | What it shows | Deliverable |
|---|---|---|---|
| 2026-10-05 | [solana-devnet-verification-run](2026-10-05-solana-devnet-verification-run.md) | The x402 payment checks on Solana devnet (unreleased 0.7.0 branch): `wasit serve`'s lying modes fail `X402-06`–`10` and a mainnet request gets nothing sent; Wasit's own fixture passes 10/10 with `X402-06` settled on-chain and read back independently, the payer holding no SOL; the packed core installs and runs alongside TypeScript 5.8, 6 and 7 | Beyond the SOW |
| 2026-10-05 | [x402-negative-checks-run](2026-10-05-x402-negative-checks-run.md) | `X402-08` replay, `X402-09` underpayment and `X402-10` expired authorization (unreleased 0.7.0 branch): Wasit's fixtures pass 10/10 on Stellar and Base Sepolia, each refusal for the reason the check is about; `wasit serve --mode no-settle` fails all of them on both chains | Beyond the SOW |
| 2026-10-05 | [base-sepolia-verification-run](2026-10-05-base-sepolia-verification-run.md) | The x402 payment checks on Base Sepolia (unreleased 0.7.0 branch): servers that skip settlement or cite a missing transaction fail `X402-06` and `X402-07`; a mainnet request gets nothing sent; Wasit's own fixture passes 7/7 with `X402-06` settled on-chain and read back independently, the payer holding no ETH | Beyond the SOW |
| 2026-09-30 | [x402-0.6.0-verification-run](2026-09-30-x402-0.6.0-verification-run.md) | 0.6.0's stricter `X402-06` and `X402-07`, A/B against 0.5.0: servers built to skip settlement, misreport it or skip signature checks pass 0.5.0 and fail 0.6.0. `stellar/x402-stellar`'s reference still passes 7/7, with `X402-06` verified on-chain. Registry parity for the published 0.6.0 | D1 |
| 2026-09-28 | [authorized-third-party-run](2026-09-28-authorized-third-party-run.md) | Published 0.5.0 against defi-copilot, a third-party service, with its operator's written authorization, as a local instance: 3 pass, 2 diverge from the Stellar spec (x402 v1, non-CAIP-2 network), 2 no verdict, nothing paid. Also 0.5.0 registry parity against Wasit's own fixtures | D2 |
| 2026-09-24 | [official-sdk-reference-run](2026-09-24-official-sdk-reference-run.md) | Published 0.4.0 against `stellar/stellar-mpp-sdk`'s own example servers. Charge settles on-chain; an A/B across the SDK's `mppx` 0.10.1 bump shows rejected channel vouchers moving from 402 to 500 ([#82](https://github.com/stellar/stellar-mpp-sdk/issues/82)). Closes 0.4.0 registry parity | D2 |
| 2026-09-20 | [completion-summary](2026-09-20-completion-summary.md) | One-page summary of every deliverable and what is still open | Overall |
| 2026-09-17 | [cross-check-isolation-run](2026-09-17-cross-check-isolation-run.md) | Two defects in Wasit fixed in 0.4.0, and a Claude Code MCP session running charge then channel in one process | D2, D3 |
| 2026-09-06 | [reference-implementation-run](2026-09-06-reference-implementation-run.md) | Published 0.3.0 against `stellar/x402-stellar`'s reference implementation: 7/7 | D1 |
| 2026-09-06 | [npm-package-parity-run](2026-09-06-npm-package-parity-run.md) | npm 0.3.0 and a build of `main` agree on all thirteen checks | D1, D2 |
| 2026-09-05 | [full-settlement-run](2026-09-05-full-settlement-run.md) | Every suite against Wasit's own fixtures, with real testnet settlement, including negative checks | D2 |
| 2026-08-15 | [ecosystem survey](2026-08-15-third-party-run.md) | Read-only x402 checks against seven cloned public repos, run on our machine without contacting their operators | Context only, not SOW evidence |

**What the others are not.** Apart from the 2026-09-28 run, none of these is
the operator-authorized third-party test. Every other target was either Wasit's
own fixture or open-source code run on our machine, and no operator was
contacted.
