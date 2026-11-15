# Job 02 — Network guard, payment tier, new check, opt-in, pre-release

Status: 🟡 **IN PROGRESS** (first layer of the guard built, 2026-11-15) · Deliverable: **D2** · Week: **2** · Depends on: #0

## Goal

The payment tier of the same Action: X402-06 to X402-10 and the new check
"rejected request does not settle" run on `main`, with a payer key kept in the
builder's own secrets and used on a test network by default, and never on pull
requests from forks. A network guard in the command line, the MCP server and the
Action keeps every payment check (and every MPP check that signs) on test
networks, while the x402 read-only checks may read a mainnet endpoint, since they
pay nothing and need no key. A capped, explicit opt-in lets the x402 payment
checks run on Stellar mainnet; it is never on by default and is validated on our
own service before it is offered (job 03). A pre-release of the Action and the
command line, without the opt-in, goes to beta testers at the end of the week.

## Acceptance criteria

- [x] First layer of the guard: every place that signs a payment refuses any network that is not a test network, before a key is read, in the library, the command line and the MCP server. The x402 read-only checks are unaffected.
- [x] A channel commitment is signed only when it names the run's channel, amount and network.
- [ ] The plan, the per-payment cap and the per-run cap are enforced before anything is signed.
- [ ] The payment tier in the Action, on `main`, with the payer key in the repository's secrets; never on a pull request from a fork.
- [ ] The new check "rejected request does not settle" sends a valid payment with a request the service must refuse, then reads the chain to confirm that no transfer happened.
- [ ] The opt-in switch: a flag on the run in the command line, an input on a run started by hand in the Action, and a start-up setting (never a tool argument) in the MCP server.
- [ ] Independent review of the payment code, in writing.
- [ ] The pre-release tag, without the opt-in: it refuses every payment on mainnet.

## What shipped (first layer)

- **A fixed table of networks.** Each network is a test network, a mainnet that needs the opt-in, or unknown. Unknown is refused. Code: [`networks.ts`](https://github.com/wasit-dev/Wasit/blob/sow2/s1-action/packages/core/src/guard/networks.ts).
- **The check sits in every entry point that signs,** before a key is read: the x402 payment checks, MPP charge, every MPP channel check including the one that closes a channel. Commit: [`45834e1`](https://github.com/wasit-dev/Wasit/commit/45834e1).
- **A channel commitment is signed only when it names the run's channel, amount and network.** Test: [`channel-commitment-binding.test.ts`](https://github.com/wasit-dev/Wasit/blob/sow2/s1-action/packages/core/test/unit/channel-commitment-binding.test.ts).
- **`stellar-sdk` 16.4.1.** The test network is on protocol 30, which the previous version cannot read.

## Proof

| What | Status | Proof |
| --- | --- | --- |
| The first layer of the guard, with tests for the library, the command line, the dashboard and the MCP server | ✅ (code and tests) | [Draft pull request 23](https://github.com/wasit-dev/Wasit/pull/23) · [CI run](https://github.com/wasit-dev/Wasit/actions/runs/43706023137) |
| A payment check on `stellar:pubnet` without the opt-in is refused before anything is signed | 🟡 | Offline tests: [`runners.test.ts`](https://github.com/wasit-dev/Wasit/blob/sow2/s1-action/packages/cli/test/unit/runners.test.ts). A recorded run and an Action run come next |
| The read-only checks pass on a challenge that names `stellar:pubnet` | ✅ | [Pull request 6](https://github.com/dzakwannajmi/x402-example-paywall/pull/6) · [run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43724229283) · [copy of the comment](week-2/copies/pr-6-comment.md) · [copy of the log](week-2/copies/run-pr6-pubnet.log.txt): the seller on `127.0.0.1` names `stellar:pubnet`, X402-01 to X402-05 pass, the payment checks are skipped by the read-only tier, no payment is made and nothing is signed. It is a local seller, not a deployed mainnet service |
| The pieces below | ⬜ | Not started |

## Result

Partial progress 2026-11-15: the first layer of the guard is built, tested and
offered as the draft pull request. The plan, the caps, the payment tier in the
Action, the new check, the opt-in switch, the independent review and the
pre-release are the next work.

Update 2026-11-15 (later): the read-only tier was shown in the Action on a
challenge that names `stellar:pubnet` (pull request 6 of the example project,
local seller, no payment, nothing signed). This is one of the week 2 proofs that
does not need the payment tier.
