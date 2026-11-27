# Job 03 — MPP, recent failures, own facilitator, validation of the opt-in

Status: 🟡 **IN PROGRESS** — the validation of the opt-in was run on 2026-11-23 and MPP in `wasit run` on 2026-11-24, on the maintainer's machine (week 2, ahead of its week); MPP in the example project's Action comes with the release; a run against a single-use paywall shows "resource consumed" (2026-11-27, same way); the recent-failures line is built and waits for a run with a failure in its history · Deliverable: **D2** · Week: **3** · Depends on: #2

## Goal

MPP charge (MPP-01) and channel (MPP-10, 11, 12 and 14) checks run in the same
Action with the same check, comment and job summary as x402; MPP-13, which closes
a channel for good, is never run. The comment shows how often each check failed in
recent runs, read from the builder's own workflow history. A single-use resource
(it answers 409 instead of a new 402 once paid) is reported as "resource consumed",
with the reason, not as a harness error. We run our own facilitator and use a free
Stellar mainnet RPC for the example service. Before the opt-in is offered to any
builder it is validated on our own service from the command line, with a dedicated
account that holds a small balance: a payment within the cap is read back from the
chain, a payment above the cap is refused, and a run whose possible spend exceeds
the per-run cap is refused before it starts. The findings are published, or, if the
checks are not safe enough, the opt-in is not offered and the reason is written
down.

## Acceptance criteria

- [~] MPP charge and channel runs in the example project, in the same comment format. Partly: run through `wasit run` on the maintainer's machine on 2026-11-24, and the comment written from those runs (below); the run in the example project, through the Action, comes with the release, when the code is public.
- [ ] The line with recent failure counts in a run comment.
- [~] A run against a single-use test paywall shows "resource consumed". Partly: run on the maintainer's machine on 2026-11-27 and read back from the chain (below); the run in the example project, through the Action, comes with the release.
- [~] Our own facilitator and a free mainnet RPC are running for the example service. Partly: they ran for a copy of the example's seller on the maintainer's machine for the validation (not hosted); the example project itself still uses the hosted test-network facilitator.
- [~] The validation is run and its written findings are published (or the reason the opt-in is not offered). Run, closed on 2026-11-23, and its findings are written below.

## Result

**Part 1 of this job (MPP) was run on 2026-11-24 on the maintainer's machine, on the Stellar test network; part 3 (the validation of the opt-in on our own service) on 2026-11-23 on Stellar mainnet. The recent-failures line is built (since week 1) and has no run with a failure in its history yet; "resource consumed" was run on 2026-11-27 (below).**

### MPP through `wasit run`, on the maintainer's machine (2026-11-24)

`wasit run`, the command the Action runs, now runs the MPP checks in the payment tier, on `stellar:testnet` only and by the same rules as x402: the event, `operatedByMe` and the key variable. MPP-01 (charge) is planned from the service's unpaid answer before anything is signed and held to the same caps as x402, at most $1.00 a payment and one $5.00 budget for the run; the payment it signs must be the planned one. The channel checks (MPP-10, 11, 12 and 14) sign commitments off-chain and send no transaction. MPP-13, which closes a channel for good, is never run by `wasit run`. The maintainer ran it in their own terminal against the local MPP test services of Wasit's repository; the keys came from their local environment file and are in no output.

| Run | Result | Proof |
| --- | --- | --- |
| MPP charge, one endpoint | The plan printed first ("MPP-01 10000 (base units)", "could spend up to $0.001 of the $5.00 cap"); MPP-01 passed: the payment settled for exactly the advertised amount, read from the transfer event; exit 0. Read afterwards on Horizon: one successful operation, the payer debited and the receiver credited 0.0010000 USDC | [`4349…bf83`](https://stellar.expert/explorer/testnet/tx/43499f50af379f20467b31645815e4d31db250bef4315ce98d5ed22eb83cbf83) · [excerpts](week-2/copies/mpp-local-run/excerpts-of-the-runs.txt) · [comment](week-2/copies/mpp-local-run/charge-comment.md) |
| MPP channel, one endpoint | MPP-11, MPP-12 and MPP-14 passed, MPP-10 skipped (the channel's expected terms were not in the config), MPP-13 not listed; nothing charged to the cap; exit 0 | [excerpts](week-2/copies/mpp-local-run/excerpts-of-the-runs.txt) · [comment](week-2/copies/mpp-local-run/channel-comment.md) |

The two comments were written by `wasit ci-report` from the reports of these runs, the same command the Action runs: the charge comment links the payment on Stellar Expert, as the x402 comment does for X402-06. No pull request was involved: this is the comment format, not yet a run in the example project.

The code is commit `bd9209a` on a local branch of the week 3 work, which becomes public with the release; until then the copies are the readable record. The comments' version line reads 0.8.0-beta.1 because the local build keeps the pre-release's version number: the published 0.8.0-beta.1 does not have this code. Not run yet: MPP in the example project through the Action (with the release), and a service that is not ours.

### Part 3: the validation of the opt-in (2026-11-23)

### What was run, and where

The maintainer ran every command below in their own terminal; no agent held a mainnet key or ran a mainnet command. The service under test is a copy of the example project's seller with **our own facilitator** (the official SDK's facilitator, in process) and a **free public mainnet RPC**, listening on `127.0.0.1` only. Two accounts, both the maintainer's own and made only for this: the payer [A](https://stellar.expert/explorer/public/account/GCJPZARVX662YFJXYNAXDJLOEVHJF5TU7TGQDV5Z4I2M65NZSL25AL7V) (a small USDC balance, never above the $10 the plan allows) and the receiving address and facilitator [B](https://stellar.expert/explorer/public/account/GBFTF5QOLLBF34T6G4GZBOL7VLYQ4GBHNVS6LKFWIZV5F2N5Y35QL6OZ). Every payment went from A to B. The code is the local branch of the opt-in (it is not pushed before the validation is accepted, so the Action cannot build it from a ref anyone can name): commit `2e5ea94` for the first set of runs and, after one change made from what they showed (below), commit `9eff947` for the second set, and, after a second, smaller change (below), commit `c8cf72a` for the third set. All three commits are expected to become public with the release (the final report names the commit the last runs were made on); until then the ledger copies below are the readable record of each run.

Each paid run writes a **run ledger** before the key signs: one entry per signature, the answer's status, the settlement hash, and the payer's balances before and after (read on public Horizon). The copies are in [`week-2/copies/mainnet-validation/`](week-2/copies/mainnet-validation/) and name no key; each was compared with Stellar Expert and Horizon by hand.

https://stellar.expert/explorer/public/ here is `https://stellar.expert/explorer/public/`.

### Runs and proofs (first set, commit `2e5ea94`)

| Run | Result | Proof |
| --- | --- | --- |
| Dry run, no key | Plan on `stellar:pubnet`, the one payee, USDC, worst case $0.045 | [excerpts](week-2/copies/mainnet-validation/excerpts-of-the-runs.txt) |
| Six refusals with the payer's key present: no `--mainnet`; a price of $1.01 (above the $1.00 cap); two endpoints (worst case $8.00, above the $5.00 run cap); the payee changed; another asset; another network | Each refused, "Nothing was signed", no ledger opened, balances unchanged | [excerpts](week-2/copies/mainnet-validation/excerpts-of-the-runs.txt) |
| First paid run, price $0.01, one endpoint with the reject case | X402-01 to X402-11 pass; one transfer of 100000 base units A to B | [`98d1b511…5288`](https://stellar.expert/explorer/public/tx/98d1b511f9726ca9833836cec4648808e9bdae571b7d96b2b2fe8957fc285288) · [ledger](week-2/copies/mainnet-validation/01-first-paid-run-0.01-usd.ledger.json) |
| Paid run at exactly $1.00 (second attempt) | X402-06 passes: one transfer of 10000000 base units; the checks that sign again could not (the payer held $0.27 after the first payment): no verdict | [`379c7b70…1410`](https://stellar.expert/explorer/public/tx/379c7b7003582246b2f8c6ab45fe7cfbede15788890ccf0dedc0c326d12d1410) · [ledger](week-2/copies/mainnet-validation/03-1.00-usd-attempt-2.ledger.json) |
| A service that settles what it should refuse (lax mode), price $0.01 | X402-09 and X402-11 **fail** as designed; each settlement read back from the transfer event; ledger consistent; exit 1 | [`6fb84ff8…9fbd`](https://stellar.expert/explorer/public/tx/6fb84ff840e4c454c952ad330011e65536053ebcb6ab0a071fdfc55ba3f59fbd) (X402-06) · [`788c08d0…df7a`](https://stellar.expert/explorer/public/tx/788c08d0d8ca9b95c90191546f1084e3e53bc4de08243c6e60ae4967b522df7a) (X402-09) · [`ad1f3ef5…8682`](https://stellar.expert/explorer/public/tx/ad1f3ef57578a440148d7f30268750c8094c17f8a5beae4cb81e01aa68618682) (X402-11) · [ledger](week-2/copies/mainnet-validation/04-lax-service.ledger.json) |
| The MCP server's mainnet tool, started by a small client script (not an agent), price $0.01 | `conformant`, progress notifications, ledger consistent; the two ordinary tools asked for `stellar:pubnet` refuse | [`08b91199…e197`](https://stellar.expert/explorer/public/tx/08b911996f55c062572ff6a0154194b22fa4d5ab684bbaed1fbf2d787b31e197) · [ledger](week-2/copies/mainnet-validation/05-mcp-tool-0.01-usd.ledger.json) |
| First $1.00 attempt, before the second | The facilitator's settlement never reached a ledger; **no funds moved**; X402-06 fails, the rest skip | [ledger](week-2/copies/mainnet-validation/02-1.00-usd-attempt-1-facilitator-failed.ledger.json) (the transaction `0c5d8bf0…c5d2` is not on the chain) |

### One change made from what these runs showed

In the $1.00 run the payer held less than the run needed to finish its checks, so the run ended without a verdict half way. The plan of a mainnet run now reads the payer's USDC and holds it to what the run needs: the prices of the endpoints plus the highest price again. Below that, the run is refused before anything is signed and the message says how much is missing; at or above it but below the run's worst case, the plan warns that a service which settles what it should refuse can take more. Commit `9eff947`.

### Second set, commit `9eff947`

| Run | Result | Proof |
| --- | --- | --- |
| Dry run | also prints the minimum a paying run will hold the payer to | [excerpts](week-2/copies/mainnet-validation/excerpts-of-the-runs.txt) |
| Six refusals again | each refused as before | [excerpts](week-2/copies/mainnet-validation/excerpts-of-the-runs.txt) |
| $1.00 against a payer holding $1.24 | **refused at the plan**: "needs at least $2.00 to finish its checks ... $0.7615614 short. Nothing was signed." | [excerpts](week-2/copies/mainnet-validation/excerpts-of-the-runs.txt) |
| Paid run, price $0.01 | X402-01 to X402-11 pass | [`12a1e20e…5d8f`](https://stellar.expert/explorer/public/tx/12a1e20e1a70d6160c463c200946f6734e14c43938469cfd415f757ac8c15d8f) · [ledger](week-2/copies/mainnet-validation/06-rerun-0.01-usd.ledger.json) |
| Paid run at exactly $1.00, payer holding $4.22 | **X402-01 to X402-11 all pass**, with the new warning (balance below the worst case of $4.50) | [`ca6c9779…76e9`](https://stellar.expert/explorer/public/tx/ca6c977926028a5afb7f6cad903174f67e516ce8bd428adf7b8656e3bcac76e9) · [ledger](week-2/copies/mainnet-validation/07-rerun-1.00-usd.ledger.json) |
| The MCP server's mainnet tool, price $0.01 | `conformant`, ledger consistent | [`c403b83e…b29f`](https://stellar.expert/explorer/public/tx/c403b83e8901c61aa98ab119b24ad424c786358d62844572146a99bff779b29f) · [ledger](week-2/copies/mainnet-validation/08-rerun-mcp-tool-0.01-usd.ledger.json) |

### One more change, and a third set, commit `c8cf72a`

The warning described above also printed on a run refused for another reason, where nothing is signed and no funds can be lost. A refused plan now carries no warning; a plan that starts is unchanged. The change touches only the text of the plan.

| Run | Result | Proof |
| --- | --- | --- |
| Dry run | worst case $0.045, exit 0 | [excerpts](week-2/copies/mainnet-validation/excerpts-of-the-runs.txt) |
| Two endpoints at $1.00, payer holding $3.2146205 (above the minimum of $3.00, below the worst case of $8.00) | refused for the $5.00 run cap, "Nothing was signed", exit 2, the funds line printed and **no warning**; no ledger opened | [excerpts](week-2/copies/mainnet-validation/excerpts-of-the-runs.txt) |
| Paid run, price $0.01 | X402-01 to X402-11 pass; ledger consistent | [`3cc8aac7…0382`](https://stellar.expert/explorer/public/tx/3cc8aac77606b023c6dd2f8c3ba85c30372a7c33224465bcbc45c985c45b0382) · [ledger](week-2/copies/mainnet-validation/09-rerun-c8cf72a-0.01-usd.ledger.json) |

Read afterwards on public Horizon (no key): the payer's USDC went from 3.2146205 to 3.2046205 and its XLM did not move; the receiver's USDC rose by 0.01 and its XLM fell by the fee of 12103 stroops. The transaction has one operation, from the receiver's account, and moves 0.01 USDC from the payer to the receiver. The paid path of the warning on a run that starts was not repeated on this commit; it is covered by the offline tests and was seen on mainnet in the second set. The paid run of $1.00, lax mode and the MCP tool were not repeated on this commit: only the plan's text changed.

### What the runs show

- **A payment within the cap is read back from the chain.** Each paid run's X402-06 names the settlement; the ledger and Stellar Expert agree on the transaction, the amount, the two addresses and the fee. A transfer of exactly $1.00 is accepted.
- **A payment above the cap, a run that could spend above the run cap, another payee, another asset and another network are each refused before anything is signed.** No refusal opened a ledger or moved a balance.
- **A service that settles what it should refuse is caught.** In lax mode the underpayment and the refused request were both settled; Wasit failed both checks, named both settlements, and the ledger still matched the chain.
- **The payer's balances matched the ledger after every paid run.** Its USDC went down by exactly the settlements the run verified, and its XLM did not move during a run (the payer's XLM differs between runs because the account was topped up and swapped by hand between them).
- **Spent in all:** 2.075 USDC moved from A to B in ten settlements (first set $1.045, second $1.02, third $0.01), and B paid ten network fees of 12103 stroops each (about 0.012 XLM).

### What went wrong or is open

- **One facilitator failure.** The first $1.00 attempt: our facilitator's settlement transaction never reached a ledger. No funds moved (the chain and the balances show it), and the authorization had expired. Wasit reports this as a failed X402-06, with a hint that it may be the facilitator's or its RPC's failure: from the target's answer it cannot tell a target that refuses a valid payment from a facilitator that fails to send. The cause is not established; a raised inclusion fee was used afterwards, and the fee charged did not change, so it is not shown to be the cause.
- **The free RPC timed out once** while Wasit checked which network it serves; Wasit stopped before anything was sent, as it should.
- **One message was noisy, and was changed:** the "funds can be lost" warning also printed when a run was refused for another reason (nothing is signed then). It is now added only to a run that starts. Commit `c8cf72a`; the third set shows the refused run without it.
- **Not run:** the Action's paid path on mainnet (by design: our key never goes into GitHub secrets), a window of days (these runs are minutes), MPP (it stays on test networks), a service that is not ours, and a close that empties or rotates the accounts: the maintainer chose to keep both accounts as they are (see "The close").

### The close

After the last run the maintainer unset the two key variables in the shell they had used (`WASIT_MAINNET_PAYER_SECRET` and the facilitator's); the variables read empty there (a terminal closed earlier cannot be checked). The ledger folder held no lock file. The maintainer did **not** empty or rotate the payer account: it was kept as it is, with its key in the maintainer's own terminal and backup. Read afterwards on public Horizon (no key): no transaction followed the last run (`c403b83e…b29f`) on either account, no payment left the payer for any address, and the payer's USDC stayed below the $10 the plan allows. The totals reconcile: the payer's USDC at the start, plus what the maintainer added, minus the 2.065 USDC spent, equals what Horizon showed after the last run; the receiver's USDC equals the 2.065 paid in minus the amount the maintainer sent back to the payer.

Not found in the runs, by their own results and ledgers: a signature without a ledger entry, a transfer outside the plan, or a spend above the plan. This is a reading of the result files and ledgers by the maintainer's session, not a second check by another party.

**After the third set (`c8cf72a`).** The maintainer reported unsetting the two key variables again, in both shells (not checked by this session). The ledger folder held no lock file. Read on public Horizon (no key): the latest transaction on both accounts is the third set's paid run (`3cc8aac7…0382`), and the two before it are the earlier settlements. The payer's USDC is 3.2046205, its XLM is unchanged, and it stayed below $10. The totals still reconcile: 3.2146205 before the run, minus the 0.01 spent, equals what Horizon showed after it. The accounts were again kept, not emptied or rotated.

### "Resource consumed", on the maintainer's machine (2026-11-27)

A single-use resource answers a new request with 409 once its payment was served. Before this change the checks that need a new
challenge (X402-07, 09, 10 and 11) read that as an unreadable challenge and ended as `ERROR (harness)`. They are now skipped with the
reason "resource consumed" (`skipKind: resource-consumed`): nothing is signed for them, the route is not asked again after its 409,
and X402-08, the replay, which needs no new challenge, still runs.

The maintainer ran `wasit run` against a paywall of the repository's test fixtures that sells its resource once (the official x402
middleware and the public test-network facilitator, on the Stellar test network). X402-01 to X402-06 passed, X402-06 settled
on-chain ([payment on Stellar Expert](https://stellar.expert/explorer/testnet/tx/f94672c60f6b9a730a210011aef09bd4c7edc5de472384d18e5a70044a2d647b)); X402-07, 09, 10 and 11 were skipped as "resource consumed", none as an error; X402-08
passed (the replay was refused with 409); the endpoint was graded conformant, exit 0, and the run charged $0.01 of the $5.00 cap.
The same payment was read on Horizon: successful, the payer debited 0.0100000 USDC and the receiving address credited the same.
`wasit ci-report` then wrote the comment with the skips and their reason. Copies: [terminal and read-back](week-3/copies/resource-consumed-run/excerpts-of-the-run.txt) · [comment](week-3/copies/resource-consumed-run/comment.md) ·
[report](week-3/copies/resource-consumed-run/report.json). The code is commit `16c6500` on a local branch of the week 3 work, which
becomes public with the release; the version line of the comment reads 0.8.0-beta.1 because the local build has not changed its version
number. A route that answers 409 before any payment of the run gets no payment at all (X402-06 is skipped with that reason); that case is
covered by offline tests only.

### Copies

[`week-2/copies/mainnet-validation/`](week-2/copies/mainnet-validation/): the nine run ledgers and [excerpts of the output](week-2/copies/mainnet-validation/excerpts-of-the-runs.txt) (the lines that carry each result, copied from the maintainer's terminal). The full terminal logs are kept by the maintainer. The linked transactions open on Stellar Expert without a login.
