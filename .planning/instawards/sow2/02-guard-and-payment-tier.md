# Job 02 — Network guard, payment tier, new check, opt-in, pre-release

Status: 🟡 **IN PROGRESS** (payment tier and the new check shown on `main` of the example project; mainnet refused, 2026-11-16) · Deliverable: **D2** · Week: **2** · Depends on: #0

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
- [x] The payment tier never runs on a pull request from a fork.
- [x] The new check "rejected request does not settle" sends a valid payment with a request the service must refuse, then reads the chain to confirm that no transfer happened.
- [ ] The opt-in switch: a flag on the run in the command line, an input on a run started by hand in the Action, and a start-up setting (never a tool argument) in the MCP server.
  In the pre-release the three switches exist and always refuse; the switch that allows waits for the validation (job 03).
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

## What shipped (the new check, 2026-11-16)

- **`X402-11`, "Rejected Request Not Settled".** For an endpoint whose entry in `wasit.config.json` names a request the service must refuse (`reject`), Wasit signs a payment for the advertised terms, through the same plan, pin and caps as the other payment checks, and sends it with that request.
- **It reads the chain, not the service's word.** Once a ledger it asks the Stellar RPC whether the nonce of that payment's authorization was used, in the same call as the nonce of `X402-06`'s payment, which was used and must be found. The payer's balance and the token's transfer events are second readings; when they disagree, there is no verdict.
- **Verdicts.** Refused, and still unused after its expiration ledger: pass. Refused, and used: fail, with the transaction that took it. Served: fail.
- **The wait.** A payment that stays valid for at most 300 seconds is waited out, with a hard stop 360 seconds after it was sent; a longer one is not signed, and the check is skipped.
- Code: [draft pull request 30](https://github.com/wasit-dev/Wasit/pull/30); the check's entry in [`docs/CHECKS.md`](https://github.com/wasit-dev/Wasit/blob/sow2/s2-payment/docs/CHECKS.md) on that branch.

## What shipped (mainnet refused, 2026-11-16)

- **The three switches of the opt-in, refusing.** `wasit run --mainnet` stops before the config is read; the Action's `mainnet` input stops the job in the step that checks the inputs, before Wasit is installed, and the job summary says so; the MCP server does not start with `WASIT_MAINNET_OPT_IN`, `WASIT_MAINNET_CONFIG` or `--mainnet`. Each says "the mainnet opt-in is not part of this version" and exits 2. On any GitHub event but a run started by hand, the message also says that the switch is refused on that event.
- **No allow path.** A property test drives random combinations of flags, key variables, start-up variables, GitHub events and config values for a payment on `stellar:pubnet`, against a stand-in chain that opens every gate but Wasit's own: no paid request and no signature, ever. A control run on the test network shows the stand-in does record a signature when one is made.
- **The MCP server's RPC.** `WASIT_RPC_URL`, set when the server starts, fixes the RPC of every tool call, and a call that names another RPC is refused before anything is sent. A result that reads the chain names its RPC by origin, and says when it is not Wasit's default.
- Code: [draft pull request 30](https://github.com/wasit-dev/Wasit/pull/30).

## Proof

| What | Status | Proof |
| --- | --- | --- |
| The first layer of the guard, with tests for the library, the command line, the dashboard and the MCP server | ✅ (code and tests) | [Draft pull request 23](https://github.com/wasit-dev/Wasit/pull/23) · [CI run](https://github.com/wasit-dev/Wasit/actions/runs/43706023137) |
| A payment check on `stellar:pubnet` without the opt-in is refused before anything is signed | ✅ | [Run on `main` of the example project](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43882304954) · [copy of the log](week-2/copies/run-pubnet-payment-refused.log.txt): the payment tier on a config that names `stellar:pubnet`, started by hand, no payer key; Wasit stopped with exit 2 before the service started and wrote no report, and the step after it confirmed the refusal |
| The Action's `mainnet` input refused on a push | ✅ | [Run on a push](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43882283916) · [copy of the log](week-2/copies/run-mainnet-input-refused.log.txt): on a branch that is never merged, `mainnet: true` stopped the job with exit 2 in the step that checks the inputs; Wasit was not installed and nothing ran |
| The read-only checks pass on a challenge that names `stellar:pubnet` | ✅ | [Pull request 6](https://github.com/dzakwannajmi/x402-example-paywall/pull/6) · [run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43724229283) · [copy of the comment](week-2/copies/pr-6-comment.md) · [copy of the log](week-2/copies/run-pr6-pubnet.log.txt): the seller on `127.0.0.1` names `stellar:pubnet`, X402-01 to X402-05 pass, the payment checks are skipped by the read-only tier, no payment is made and nothing is signed. It is a local seller, not a deployed mainnet service |
| The payment tier in the Action on `main`: X402-01 to X402-10, one real payment on the Stellar test network | ✅ | [Run on `main`](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43816426654) · [the payment on Stellar Expert](https://stellar.expert/explorer/testnet/tx/beb0a5f94e2c5cb41cad8f5fe1110020dd004c30022b53b853b30ae5ef905a86) · [copy of the log](week-2/copies/run-main-payment-tier.log.txt): the job pays from the secret `WASIT_TESTNET_PAYER`, the seller runs as the user `wasit-service`, the plan and the caps are printed before anything is signed, all ten checks pass, X402-06 settles the advertised amount and Wasit reads it from the transfer event, and the run charged at most what it planned |
| A pull request from a fork with `tier: payment`: the payment checks are not run | ✅ | [Pull request 5](https://github.com/dzakwannajmi/x402-example-paywall/pull/5) · [run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43819805398) · [copy of the log](week-2/copies/run-pr5-fork-payment-tier.log.txt): the same workflow as on `main`, on a pull request from a fork; the job had no secrets and a read-only token, X402-01 to X402-05 passed, X402-06 to X402-10 were skipped with "payment checks not run: pull request", the run notes that nothing was signed, and no comment was posted |
| The new check `X402-11` in the Action on `main`: a valid payment sent with a request the seller must refuse, and the chain read with no transfer | ✅ | [Run on `main`](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43851987068) · [copy of the log](week-2/copies/run-main-x402-11.log.txt): the example's `reject` case asks for a quote language the seller does not have; the seller answered 400; Wasit read the chain once a ledger until the payment's authorization had expired, about five minutes at the default lifetime, found it never used and no transfer of it, and all eleven checks passed. The only payment of the run that settled is `X402-06`'s ([Stellar Expert](https://stellar.expert/explorer/testnet/tx/8dbe4e036ab12e8de436ac0fe7dc72004d584740c9e9cb0e14b1d29f004c1e78)) |
| `X402-11` fails a seller that takes the payment of a refused request, and one that serves it, and names the transaction | 🟡 (on the maintainer's machine; the transactions are public) | [Copy of the output](week-2/copies/live-check-x402-11-three-modes.txt): Wasit's test fixture with three routes on the Stellar test network. The one that refuses passed; the one that settles and then refuses failed, naming [7463f7c0…](https://stellar.expert/explorer/testnet/tx/7463f7c0a490a7b05b6d12d063a8aa850d54a6e2e2652911921672f6dee9d93f); the one that serves failed, naming [4c34078c…](https://stellar.expert/explorer/testnet/tx/4c34078cf88319df2fb6c0797c0f3d73b2bd7d1ab6a725de52cd5bab443d5106) |
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
account of ours that can receive USDC).

Update 2026-11-16 (later): pull request 5 of the example project, which comes
from a fork, ran on the new workflow with `tier: payment`. Wasit ran the
read-only checks only and said why: payment checks are not run on a pull
request. Nothing was signed.

Update 2026-11-16 (evening): the new check `X402-11` is built and shown. On the
maintainer's machine it was run against a test fixture with three routes: the
one that refuses passed, the two that take the payment failed and named the
transaction. A first run there found a defect in Wasit's second reading (the
test network's RPC no longer marks which events come from a successful call),
fixed before the runs above. In the Action on `main` of the example project the
seller refuses a quote language it does not have; the check waited out the
payment's lifetime and passed. Next: the opt-in switch, the independent review
and the pre-release.

Update 2026-11-16 (night): the switches of the mainnet opt-in were built, and in
this version each one only refuses. Two runs in the example project show it: a
push with the Action's `mainnet` input set stopped before Wasit was installed,
and a payment-tier run on a config that names `stellar:pubnet` stopped before
anything was signed. Next: the independent review and the pre-release.
