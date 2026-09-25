# Job 04 — Evidence Submission Package

Status: 🟡 **IN PROGRESS** (every row filled except D2's third-party rows and the walkthrough video) ·
Depends on: #1, #2, #3

## Goal
Compile everything into one document the Chapter Lead (Kenny) can review and
submit, mapping every SOW evidence item to live, verifiable proof — the same
role `EVIDENCE-SUBMISSION.md` plays in the reference layout this job board
was modeled on.

## Acceptance criteria
- [ ] Every row below has a real link, not a placeholder.
- [ ] All links checked live in the same session the doc is finalized.
- [ ] Any SOW deviation (there are none identified so far, unlike hosting-provider
      changes some other projects had) is called out explicitly if one turns up.
- [ ] Handed to Kenny for submission.

## Template (fill in as Jobs 1–3 close out)

### Deliverable 1 — x402 Protocol Compliance Validator (CLI) + CHECKS.md

| Evidence (per SOW) | Proof |
|---|---|
| Public GitHub repo | https://github.com/wasit-dev/wasit |
| Published CHECKS.md | https://github.com/wasit-dev/wasit/blob/main/docs/CHECKS.md |
| npm package | https://www.npmjs.com/package/@wasit-dev/cli |
| Published package behaves as documented | https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-06-npm-package-parity-run.md — `@wasit-dev/cli@0.3.0` installed from the registry and a build of `main` produce identical outcomes, counts and per-check statuses across all thirteen checks. Not a SOW row; it closes the gap that produced the `0.1.1` defect, where the published CLI lacked a subcommand its published docs described |
| Validated against the reference implementation | https://github.com/wasit-dev/Wasit/blob/main/docs/evidence/2026-09-06-reference-implementation-run.md — 7/7 against `stellar/x402-stellar`'s own `simple-paywall` example at `45d735a`, run from the published package. The first x402 implementation Wasit has been judged by rather than one this project wrote, which is why it also surfaced two weaknesses in Wasit itself; both are in the document. Not a SOW row, and **not** the D2 authorization item — their open-source example on our machine, no operator contacted |
| Terminal recording / GIF | [`docs/media/d1-x402.gif`](https://github.com/wasit-dev/wasit/blob/main/docs/media/d1-x402.gif), shown in the README's [Trying It](https://github.com/wasit-dev/wasit#trying-it) section, with its asciinema source `docs/media/d1-x402.cast` beside it. Recorded from the published package (`npx -y @wasit-dev/cli@0.4.0`, opening with `--version`), 7/7 on a full run including a settled payment and a rejected corrupted signature |

### Deliverable 2 — MPP Charge and Channel Flow Simulator

| Evidence (per SOW) | Proof |
|---|---|
| Terminal output, incl. negative conformance results | https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-05-full-settlement-run.md (self-hosted fixtures, real testnet settlement, incl. X402-07's negative/rejected-signature result). Re-run from the published packages on 2026-09-06 with identical results: `docs/evidence/2026-09-06-npm-package-parity-run.md` Against the official MPP SDK's own example servers, from the published 0.4.0: https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-24-official-sdk-reference-run.md (the SOW's self-hosted-reference fallback; also closes 0.4.0 registry parity) |
| Written findings document (aggregate, ≥3 real projects) | _pending — Job 02_ |
| ≥1 third-party service tested with explicit authorization | _pending — Job 02. Note the SOW's fallback covers "the remainder self-hosted reference services" — the remainder **after** a third-party run, not a replacement for it. The 2026-09-05 self-hosted run demonstrates that fallback works, and does not satisfy this row. If Job 02 does not convert, say so plainly in the completion summary rather than presenting the self-hosted run as meeting this line._ |

### Deliverable 3 — MCP Server wrapper

| Evidence (per SOW) | Proof |
|---|---|
| npm package | https://www.npmjs.com/package/@wasit-dev/server |
| MCP config | https://github.com/wasit-dev/wasit/blob/main/docs/guides/mcp.md |
| Screen recording (check triggered from Claude Code via MCP) | Embedded in the [`v0.4.0` GitHub Release](https://github.com/wasit-dev/wasit/releases/tag/v0.4.0) description (60s, playable in place); poster frame in the README's Trying It section. Shows `wasit_mpp_charge_test` followed by `wasit_mpp_channel_test` in one server process, the sequence that failed before 0.4.0 |
| Written record of checks triggered from Claude Code via MCP | https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-17-cross-check-isolation-run.md — four tool calls in one session, including `wasit_mpp_charge_test` followed immediately by `wasit_mpp_channel_test` in the same server process, with the charge settled on-chain. Not the SOW row, which asks for a recording; this is the transcript the recording will show, and it also documents the defect that made exactly this sequence fail before 0.4.0 |

### Overall

| Evidence (per SOW) | Proof |
|---|---|
| Live website | https://usewasit.dev |
| One-page completion summary | [docs/evidence/2026-09-20-completion-summary.md](https://github.com/wasit-dev/wasit/blob/main/docs/evidence/2026-09-20-completion-summary.md) — draft, not yet reviewed by Kenny; the walkthrough-video row it links to is still pending |
| Two-minute walkthrough video | _pending — Job 03_ |

### Upstream contributions (supporting evidence, not a SOW line item)

| What | Proof |
|---|---|
| Upstream SDK defect report #1 | https://github.com/stellar/stellar-mpp-sdk/issues/66 |
| Upstream SDK defect report #2 | https://github.com/stellar/stellar-mpp-sdk/issues/67 |
| Upstream SDK defect report #3 | https://github.com/stellar/stellar-mpp-sdk/issues/70 — stale peer ranges; a clean consumer install resolves two Stellar SDKs, and every advisory `npm audit` reports traces to the nested older copy |
| Upstream SDK finding #4 | `docs/findings/upstream-sdk.md` Finding 4: rejected channel vouchers return HTTP 500 instead of 402 since the SDK's `mppx` 0.10.1 bump, shown by an A/B against the SDK's own example server. Filed as [#82](https://github.com/stellar/stellar-mpp-sdk/issues/82) on 2026-09-24; unreleased upstream |
| Upstream finding independently confirmed by a downstream project | RouteDock PR #241 (github.com/winsznx/routedock/pull/241) — **not** the D2 third-party-authorization item: RouteDock was tested without contacting its operator (see `docs/evidence/2026-08-15-third-party-run.md`) |
| Listed as a Stellar ecosystem agent skill | [stellar/stellar-dev-skill#136](https://github.com/stellar/stellar-dev-skill/pull/136) — **open, not merged**, submitted 2026-09-20. Adds an ecosystem card pointing at `skills/wasit/SKILL.md` in this repo, so the skill stays under our own maintenance rather than being copied upstream. Community skills on skills.stellar.org are explicitly "not reviewed, endorsed, or maintained by the Stellar Development Foundation", so a merge means listed, not blessed, and the completion summary should say it that way |

## Result
Not started — waiting on Jobs 2 and 3.

Partial progress 2026-09-05: the D2 terminal-output evidence item got a real
link (full payment-settlement run against self-hosted fixtures, see
`docs/evidence/2026-09-05-full-settlement-run.md`).

Partial progress 2026-09-06: D1 gained two rows. The published packages were
verified to behave identically to source across all thirteen checks
(`2026-09-06-npm-package-parity-run.md`), and Wasit was run against
`stellar/x402-stellar`'s reference implementation for the first time
(`2026-09-06-reference-implementation-run.md`). Neither is a SOW row; together
they answer the question a reviewer asks before reading any check result at
all — does the thing actually work when someone else installs it, and does it
agree with an implementation it did not write.

Partial progress 2026-09-17: D3 gained a written record of a real Claude Code
MCP session. It matters more than its row suggests, because the defect fixed the
same day meant that before 0.4.0 only the *first* payment-mode tool call in an
MCP session produced a trustworthy verdict — so a D3 recording made before this
fix would have been a recording of a tool giving wrong answers. The recording
itself still depends on Job 3, and should be made from the published 0.4.0
package rather than a local build.

The third-party-authorization item is unaffected by any of this and still
depends on Job 2. Every remaining `_pending_` row depends on Job 3.

_(Superseded 2026-09-24: Job 3 has since delivered D1 and D3; the only Job 3 row still pending is the walkthrough video.)_

Partial progress 2026-09-20: drafted the one-page completion summary at `docs/evidence/2026-09-20-completion-summary.md`, mapping every SOW deliverable to its current evidence and stating the two open gaps plainly (third-party authorization still unconverted, no registry parity run for 0.4.0's MPP half). It also corrects an assumption from the 2026-09-17 session: the `v0.4.0` GitHub Release already has the MCP session video embedded in its description, confirmed by following the `user-attachments` link in the release body to its underlying `video/mp4` asset: that row does not need redoing. The walkthrough video itself stays deliberately deferred: its script and shot list, referenced as already written in `CONTINUATION-PROMPT.md`, could not be found anywhere in the repo, `.planning/`, or project memory, and Najmi chose to set it aside rather than have one drafted from scratch this session. Draft is unreviewed by Kenny.

Partial progress 2026-09-24: filled the D1 and D3 recording rows, which had stayed `_pending_` after both recordings landed. Rows still pending: D2's written findings document and third-party authorization (both Job 02), and the walkthrough video (Job 03). Job 02 now has no candidate that could convert without a reply (see the local-only Job 02 notes), so those two D2 rows wait on the fallback decision.

Partial progress 2026-09-24 (second session): ran the SOW fallback against `stellar/stellar-mpp-sdk`'s own example servers from the published 0.4.0 (D2 terminal-output row). That closes the 0.4.0 registry parity gap and produced upstream Finding 4. The third-party authorization row is still open; a rewritten second round of outreach is drafted.
