# Job 07 — Evidence Submission

Status: 🟡 **IN PROGRESS** (week 1 rows filled, 2026-11-15) · Week: **1 to 4** · Depends on: all

## Goal

One document the Chapter Lead can review and submit, mapping every SOW 2
evidence item to live, verifiable proof. It is filled as each job closes, so the
closing package is assembled from it and nothing is hunted for later.

## Acceptance criteria

- [ ] Every row below has a real link, not a placeholder.
- [ ] All links are checked live in the same session the document is finalized.
- [ ] A proof that cannot be opened yet is marked so, with a text copy next to it.
- [ ] Any deviation from the SOW is called out explicitly.
- [ ] Handed to the Chapter Lead for submission.

Marks: ✅ shown in a real run or a public page · 🟡 built and tested, or shown only in part · ⬜ not yet.

Base of the example project: <https://github.com/dzakwannajmi/x402-example-paywall>
(public since 2026-11-15; text copies in `week-1/copies/` are kept as an archive).

## Deliverable 1 — Wasit in CI, read-only tier (week 1)

| Evidence (per SOW) | Status | Proof |
| --- | --- | --- |
| The workflow file | ✅ | [`.github/workflows/wasit.yml`](https://github.com/dzakwannajmi/x402-example-paywall/blob/main/.github/workflows/wasit.yml) |
| One passing run in the example project | ✅ | [Run on `main`](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43697947796) · [copy](week-1/copies/run-main-pass.log.txt) |
| One failing run in the example project | ✅ | [Run of pull request 1](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43698068365) · [copy](week-1/copies/run-pr1-fail.log.txt) |
| A pull request where the check and the comment can be seen without technical knowledge | ✅ | [Pull request 1](https://github.com/dzakwannajmi/x402-example-paywall/pull/1): the check "Wasit" is red and one comment explains why · [copy of the comment](week-1/copies/pr-1-comment.md) |

Further proofs of D1 (not SOW rows):

| What | Status | Proof |
| --- | --- | --- |
| The comment is updated on each push | ✅ | [Pull request 2](https://github.com/dzakwannajmi/x402-example-paywall/pull/2) · [before](week-1/copies/pr-2-comment-before-update.md) · [after](week-1/copies/pr-2-comment.md) |
| "Unsupported" is not a failure | ✅ | [Pull request 4](https://github.com/dzakwannajmi/x402-example-paywall/pull/4) · [copy](week-1/copies/pr-4-comment.md) |
| "Nothing could be tested" fails the job | ✅ | [Pull request 3](https://github.com/dzakwannajmi/x402-example-paywall/pull/3) · [copy](week-1/copies/pr-3-comment.md) |
| A pull request from a fork: the Action posts no comment and the check still reports | ✅ | [Pull request 5](https://github.com/dzakwannajmi/x402-example-paywall/pull/5) · [run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43722428182) · [copy of the log](week-1/copies/run-pr5-fork.log.txt) · [copy of the job summary](week-1/copies/pr-5-job-summary.md) |
| The code, offered for review, with passing automated checks | ✅ | [Draft pull request 23](https://github.com/wasit-dev/Wasit/pull/23) · [CI run](https://github.com/wasit-dev/Wasit/actions/runs/43706023137) |

## Deliverable 2 — Payment checks in CI, a new check, and MPP (weeks 2 and 3)

| Evidence (per SOW) | Status | Proof |
| --- | --- | --- |
| Payment-tier runs with a Stellar Expert link to each transaction | ✅ | [Run on `main` of the example project](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43816426654) · [X402-06's payment on Stellar Expert](https://stellar.expert/explorer/testnet/tx/beb0a5f94e2c5cb41cad8f5fe1110020dd004c30022b53b853b30ae5ef905a86) · [copy of the log](week-2/copies/run-main-payment-tier.log.txt). X402-07 to X402-10 send payments the service must refuse; it refused them, so they have no transaction |
| A run of the new check showing the refused request and the chain read with no transfer | ✅ | [Run on `main` of the example project](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43851987068) · [copy of the log](week-2/copies/run-main-x402-11.log.txt): `X402-11` sent a valid payment with a request the seller must refuse; the seller answered 400; the chain shows the payment's authorization unused after it expired, and no transfer of it. Two sellers that take such a payment fail it, naming the transaction: [copy of the output](week-2/copies/live-check-x402-11-three-modes.txt) (on the maintainer's machine; the transactions are public) |
| MPP charge and channel runs | ⬜ | Week 3 (job 03) |
| A run on a pull request from a fork showing the payment checks were not run | ✅ | [Pull request 5](https://github.com/dzakwannajmi/x402-example-paywall/pull/5) · [run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43819805398) · [copy of the log](week-2/copies/run-pr5-fork-payment-tier.log.txt): the workflow asks for `tier: payment`; on this pull request from a fork X402-01 to X402-05 passed and X402-06 to X402-10 were skipped with "payment checks not run: pull request"; nothing was signed |
| The new check's entry in `docs/CHECKS.md` | 🟡 | Written on the branch of [draft pull request 30](https://github.com/wasit-dev/Wasit/pull/30): [`docs/CHECKS.md`](https://github.com/wasit-dev/Wasit/blob/sow2/s2-payment/docs/CHECKS.md), row `X402-11`. It reaches `main` with the release |
| A paying run without the opt-in refusing `stellar:pubnet` before anything is signed | ✅ | [Run on `main` of the example project](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43882304954) · [copy of the log](week-2/copies/run-pubnet-payment-refused.log.txt): the payment tier, started by hand on `main` (an event that may pay), on a config that names `stellar:pubnet`; Wasit stopped with exit 2 before the service started, saying the mainnet opt-in is not part of this version and that nothing was sent or signed, and wrote no report. The run was given no payer key; the refusal comes before any key is read. A step after it requires that refusal, so the job is green only when it happens. Also offline: [`runners.test.ts`](https://github.com/wasit-dev/Wasit/blob/sow2/s1-action/packages/cli/test/unit/runners.test.ts) (the MPP commands) and the property test [`no-allow-path.test.ts`](https://github.com/wasit-dev/Wasit/blob/sow2/s2-payment/packages/cli/test/unit/no-allow-path.test.ts) |
| The read-only checks passing on a challenge that names `stellar:pubnet` | ✅ | [Pull request 6](https://github.com/dzakwannajmi/x402-example-paywall/pull/6) · [run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43724229283) · [copy of the comment](week-2/copies/pr-6-comment.md) · [copy of the log](week-2/copies/run-pr6-pubnet.log.txt): in the Action, against a local seller whose payment request names `stellar:pubnet`; five checks passed, no payment, nothing signed. A deployed mainnet service was not read |
| A paid run with the opt-in on Stellar mainnet, capped, with a Stellar Expert link and the settlement read back from the chain | ⬜ | Week 3, after the validation (job 03) |
| A payment above the per-payment cap refused before anything is signed | ⬜ | Week 3 (job 03) |
| A run whose possible spend exceeds the per-run cap refused before it starts | ⬜ | Week 3 (job 03) |
| An Action run on a push or schedule with the opt-in set, refusing mainnet | ✅ | [Run on a push](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43882283916) · [copy of the log](week-2/copies/run-mainnet-input-refused.log.txt): on a branch of the example project that is never merged, the Action with `mainnet: true` stopped with exit 2 in the step that checks the inputs: "the mainnet opt-in is not part of this version", and the input is also refused on every event but a run started by hand; the install, the run and the report steps were skipped. In this pre-release the input is always refused |
| An MCP tool call asking for mainnet, refused | 🟡 | Offline tests that start the server as an MCP client does: [`network-guard.test.ts`](https://github.com/wasit-dev/Wasit/blob/sow2/s1-action/packages/server/test/unit/network-guard.test.ts) (a tool call with `stellar:pubnet` sends nothing) and [`mainnet-and-rpc-lock.test.ts`](https://github.com/wasit-dev/Wasit/blob/sow2/s2-payment/packages/server/test/unit/mainnet-and-rpc-lock.test.ts) (the start-up settings that ask for mainnet stop the server; the tool list has no mainnet tool). A recorded call comes with the pre-release |
| The written findings of the mainnet validation (or, if the opt-in is not offered, the reason) | ⬜ | Week 3 (job 03) |
| A run comment showing the line with recent failure counts | ⬜ | Week 3 (job 03) |
| A run against a single-use test paywall showing the "resource consumed" result | ⬜ | Week 3 (job 03) |

## Deliverable 3 — `wasit init`, example project and guides (weeks 1, 3 and 4)

| Evidence (per SOW) | Status | Proof |
| --- | --- | --- |
| The example project, with the Wasit workflow set up | ✅ (workflow) · 🟡 (payment and MPP runs later) | [Repository](https://github.com/dzakwannajmi/x402-example-paywall) · job 01 |
| A short recording of `wasit init` on a fresh x402 project and a fresh MPP project | ⬜ | Week 3 (job 04) |
| The guides on usewasit.dev, including the guide for testing a paying agent and the page on the capped opt-in | ⬜ | Week 4 (job 05) |
| The demo mode output | ⬜ | Week 4 (job 05) |
| The install-time guarantees in SECURITY.md and the SBOM attached to the release | ⬜ | Week 4 (job 05) |

## Overall (weeks 2 and 4)

| Evidence (per SOW) | Status | Proof |
| --- | --- | --- |
| The pre-release tag, without the mainnet opt-in | ⬜ | End of week 2 (job 02) |
| The release on GitHub (and on npm for any package that changes) | ⬜ | Week 4 (job 06) |
| Green CI with the test counts | 🟡 | CI of the draft pull request passes: [run](https://github.com/wasit-dev/Wasit/actions/runs/43706023137). Final counts at the release |
| A short video of the Action on a pull request | ⬜ | Week 4 (job 06) |
| A final report with the evidence link for each deliverable | ⬜ | Week 4 (job 06) |

## Result

Partial progress 2026-11-15: every D1 row has a proof that opens, and the
workflow row of D3 is shown. The D2 rows that depend on the payment tier, the
new check and the opt-in are not started. The two D2 rows that already have
partial support (the refusal of `stellar:pubnet`, and the read of a challenge
that names it) say exactly what exists and what does not.

The example project has been public since 2026-11-15, so every proof that points
to it opens without a login. The text copies in `week-1/copies/` stay as an
archive.
