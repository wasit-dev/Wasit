# Evidence Package — Wasit Instaward

Every evidence item the Statement of Work asks for, mapped to the proof that
satisfies it, followed by an index of every recorded run. For the one-page
narrative, read the [completion summary](2026-09-20-completion-summary.md).

**Builder:** Muhammad Dzakwan Najmi · **Program:** Stellar Chapter Ambassador
Indonesia Instaward · **Repo:** [wasit-dev/wasit](https://github.com/wasit-dev/wasit)
· **Site:** [usewasit.dev](https://usewasit.dev) · **Packages:** `@wasit-dev/core`,
`@wasit-dev/cli`, `@wasit-dev/server` at 0.4.0 · **As of:** 2026-09-25

| Deliverable | Status |
|---|---|
| D1 — x402 CLI + CHECKS.md | Done |
| D2 — MPP Charge + Channel Simulator | Built and tested; the operator-authorized third-party run, and the aggregate findings document that depends on it, are open |
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
[7/7 against `stellar/x402-stellar`'s reference implementation](2026-09-06-reference-implementation-run.md)

## D2 — MPP Charge and Channel Flow Simulator

| Evidence the SOW asks for | Proof |
|---|---|
| Terminal output, including negative conformance results | [Full settlement run](2026-09-05-full-settlement-run.md) against Wasit's own SDK-backed fixtures, with real testnet settlement; [run against the official MPP SDK's own example servers](2026-09-24-official-sdk-reference-run.md) from the published 0.4.0 |
| Written findings document | **Open.** The SOW asks for aggregate findings across at least three real projects: at least one third-party service tested with its operator's explicit authorization, the remainder self-hosted reference services built from the official SDKs. The two reference runs exist ([x402](2026-09-06-reference-implementation-run.md), [MPP](2026-09-24-official-sdk-reference-run.md)); the authorized third-party run does not yet, so the aggregate document cannot be written. Individual services are named only with their operator's written permission |
| At least one third-party service tested with the operator's explicit authorization | **Open.** See [below](#what-is-still-open) |

The SOW allows the remainder of the three to be self-hosted reference services
built from the official SDKs. Those runs exist for both protocols
([x402](2026-09-06-reference-implementation-run.md),
[MPP](2026-09-24-official-sdk-reference-run.md)). They cover the remainder and
do not stand in for the authorized third-party run.

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

**Third-party service tested with the operator's authorization, and the aggregate findings document (D2).** No
operator has said yes yet. Round one of outreach went unanswered. Round two,
sent 2026-09-24 with a direct yes/no question, is open with
[StellarSight](https://github.com/pedro-pelicioni/stellarsight/issues/13) and
[CleverCon](https://github.com/clevercon-protocol/clevercon/issues/134), and a
written request went on 2026-09-25 to a developer who had agreed verbally
([defi-copilot#1](https://github.com/fxjrin/defi-copilot/issues/1)). The same
day, requests went to the other prize winners of Stellar Hacks: Agents that
operate an x402 or MPP service: [RenderGate](https://github.com/tantk/rendergate/issues/1), which runs on testnet, and [TollPay](https://github.com/rajkaria/toll/issues/1) and an [x402 middleware template](https://github.com/ffarinas/x402-mcp-stellar-template/issues/1), which run on mainnet and were asked whether a testnet instance exists. Wasit is testnet-only, so a
mainnet-only service cannot be tested even with permission. The aggregate
findings document follows from an authorized run.

## Index of runs

Each file records one run: what was tested, from which build, against what,
and what it does and does not establish. Newest first.

| Date | File | What it shows | Deliverable |
|---|---|---|---|
| 2026-09-24 | [official-sdk-reference-run](2026-09-24-official-sdk-reference-run.md) | Published 0.4.0 against `stellar/stellar-mpp-sdk`'s own example servers. Charge settles on-chain; an A/B across the SDK's `mppx` 0.10.1 bump shows rejected channel vouchers moving from 402 to 500 ([#82](https://github.com/stellar/stellar-mpp-sdk/issues/82)). Closes 0.4.0 registry parity | D2 |
| 2026-09-20 | [completion-summary](2026-09-20-completion-summary.md) | One-page summary of every deliverable and what is still open | Overall |
| 2026-09-17 | [cross-check-isolation-run](2026-09-17-cross-check-isolation-run.md) | Two defects in Wasit fixed in 0.4.0, and a Claude Code MCP session running charge then channel in one process | D2, D3 |
| 2026-09-06 | [reference-implementation-run](2026-09-06-reference-implementation-run.md) | Published 0.3.0 against `stellar/x402-stellar`'s reference implementation: 7/7 | D1 |
| 2026-09-06 | [npm-package-parity-run](2026-09-06-npm-package-parity-run.md) | npm 0.3.0 and a build of `main` agree on all thirteen checks | D1, D2 |
| 2026-09-05 | [full-settlement-run](2026-09-05-full-settlement-run.md) | Every suite against Wasit's own fixtures, with real testnet settlement, including negative checks | D2 |
| 2026-08-15 | [ecosystem survey](2026-08-15-third-party-run.md) | Read-only x402 checks against seven cloned public repos, run on our machine without contacting their operators | Context only, not SOW evidence |

**What none of these is.** None of these runs is the operator-authorized
third-party test. Every target was either Wasit's own fixture or open-source
code run on our machine, and no operator was contacted.
