# Job 02 — Network guard, payment tier, new check, opt-in, pre-release

Status: 🟡 **IN PROGRESS** (payment tier shown on `main` of the example project, 2026-11-16) · Deliverable: **D2** · Week: **2** · Depends on: #0

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
- [x] The plan, the per-payment cap and the per-run cap are enforced before anything is signed.
- [x] The payment tier in the Action, on `main`, with the payer key in the repository's secrets.
- [ ] The payment tier never runs on a pull request from a fork (built and tested; the run on the fork's pull request comes next).
- [ ] The new check "rejected request does not settle" sends a valid payment with a request the service must refuse, then reads the chain to confirm that no transfer happened.
- [ ] The opt-in switch: a flag on the run in the command line, an input on a run started by hand in the Action, and a start-up setting (never a tool argument) in the MCP server.
- [ ] Independent review of the payment code, in writing.
- [ ] The pre-release tag, without the opt-in: it refuses every payment on mainnet.

## What shipped (first layer)

- **A fixed table of networks.** Each network is a test network, a mainnet that needs the opt-in, or unknown. Unknown is refused. Code: [`networks.ts`](https://github.com/wasit-dev/Wasit/blob/sow2/s1-action/packages/core/src/guard/networks.ts).
- **The check sits in every entry point that signs,** before a key is read: the x402 payment checks, MPP charge, every MPP channel check including the one that closes a channel. Commit: [`45834e1`](https://github.com/wasit-dev/Wasit/commit/45834e1).
- **A channel commitment is signed only when it names the run's channel, amount and network.** Test: [`channel-commitment-binding.test.ts`](https://github.com/wasit-dev/Wasit/blob/sow2/s1-action/packages/core/test/unit/channel-commitment-binding.test.ts).
- **`stellar-sdk` 16.4.1.** The test network is on protocol 30, which the previous version cannot read.

## What shipped (payment tier, 2026-11-16)

- **The plan and the caps.** Before anything is signed, each endpoint's unpaid challenge is read and the run's signatures are planned: a fixed cap for each payment and a fixed cap for the run (a config can only lower the run's), only to the pinned `payTo` and asset when the config pins them. Each signature is checked against the plan again when it is made.
- **The payment tier of `wasit run` and of the Action,** on test networks only. In GitHub Actions it pays only on a push to the default branch, a schedule and a run started by hand. On a pull request the read-only checks run and the comment says why; a payer key given to a pull request run is refused before the service starts.
- **The service runs as its own user** on a GitHub-hosted runner when a payer key is set, so it cannot read the key from Wasit's process. Code that ran earlier in the job as the runner's user is not kept from it; the guide will say so.
- **"Changed since main"** compares with the last green run on `main` and names it; the recent-failures line counts every finished run on `main`.
- Code: [draft pull request 30](https://github.com/wasit-dev/Wasit/pull/30), stacked on pull request 23.

## Proof

| What | Status | Proof |
| --- | --- | --- |
| The first layer of the guard, with tests for the library, the command line, the dashboard and the MCP server | ✅ (code and tests) | [Draft pull request 23](https://github.com/wasit-dev/Wasit/pull/23) · [CI run](https://github.com/wasit-dev/Wasit/actions/runs/43706023137) |
| A payment check on `stellar:pubnet` without the opt-in is refused before anything is signed | 🟡 | Offline tests: [`runners.test.ts`](https://github.com/wasit-dev/Wasit/blob/sow2/s1-action/packages/cli/test/unit/runners.test.ts). A recorded run and an Action run come next |
| The read-only checks pass on a challenge that names `stellar:pubnet` | ✅ | [Pull request 6](https://github.com/dzakwannajmi/x402-example-paywall/pull/6) · [run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43724229283) · [copy of the comment](week-2/copies/pr-6-comment.md) · [copy of the log](week-2/copies/run-pr6-pubnet.log.txt): the seller on `127.0.0.1` names `stellar:pubnet`, X402-01 to X402-05 pass, the payment checks are skipped by the read-only tier, no payment is made and nothing is signed. It is a local seller, not a deployed mainnet service |
| The payment tier in the Action on `main`: X402-01 to X402-10, one real payment on the Stellar test network | ✅ | [Run on `main`](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43816426654) · [the payment on Stellar Expert](https://stellar.expert/explorer/testnet/tx/beb0a5f94e2c5cb41cad8f5fe1110020dd004c30022b53b853b30ae5ef905a86) · [copy of the log](week-2/copies/run-main-payment-tier.log.txt): the job pays from the secret `WASIT_TESTNET_PAYER`, the seller runs as the user `wasit-service`, the plan and the caps are printed before anything is signed, all ten checks pass, X402-06 settles the advertised amount and Wasit reads it from the transfer event, and the run charged at most what it planned |
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

Update 2026-11-16: the payment tier was shown in the Action on `main` of the
example project. A first attempt failed for two reasons, both fixed before the
run above: the runner's sudo ignored the option that passes the environment to
the seller's user (Wasit now hands it over another way), and the example's payee
was an account that did not exist on the test network (it now pays a testnet
account of ours that can receive USDC). Next: the run on the fork's pull
request, then the new check.
