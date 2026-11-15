# Job 03 — MPP, recent failures, own facilitator, validation of the opt-in

Status: ⬜ **NOT STARTED** · Deliverable: **D2** · Week: **3** · Depends on: #2

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

- [ ] MPP charge and channel runs in the example project, in the same comment format.
- [ ] The line with recent failure counts in a run comment.
- [ ] A run against a single-use test paywall shows "resource consumed".
- [ ] Our own facilitator and a free mainnet RPC are running for the example service.
- [ ] The validation is run and its written findings are published (or the reason the opt-in is not offered).

## Result

Not started.
