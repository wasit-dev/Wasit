# Job 01 — Example project with the Wasit workflow

Status: 🟡 **IN PROGRESS** (workflow done 2026-11-15; payment and MPP runs follow) · Deliverable: **D3**, and the place where the **D2** runs are shown · Weeks: **1, 2, 3** · Depends on: #0

## Goal

A ready-to-use example project with the Wasit workflow already set up, so a
builder can try Wasit in CI on a copy first, then add the same workflow to their
own repository. It is also where the payment-tier and MPP runs of D2 are shown.

## Acceptance criteria

- [x] The example project exists with the Wasit workflow (week 1).
- [x] `main` conforms, and a pull request with a deliberate defect gives the red run (week 1).
- [ ] Payment-tier runs, each with a Stellar Expert link (week 2, job 02).
- [ ] A pull request from a fork shows the payment checks were not run (week 2: a fork and pull request 5 exist, but this needs the payment tier first).
- [ ] MPP charge and channel routes with runs in the same comment format (week 3, job 03).
- [x] The repository is public (since 2026-11-15, earlier than planned).

## What shipped

Repository: <https://github.com/dzakwannajmi/x402-example-paywall> (public since 2026-11-15; every link below opens without a login).

- **The seller.** A small x402 seller on the Stellar test network with one paid route, `GET /paid`, rendered from the workshop starter kit.
- **`scripts/serve.mjs`.** Starts the seller with a small local stand-in for the facilitator, so the job needs no internet access for the service and contacts no third-party service. The stand-in can only answer "what do you support", so this tier cannot verify or settle a payment.
- **`wasit.config.json`.** How to start the seller, where it listens, and which endpoint to check.
- **`.github/workflows/wasit.yml`.** Install, start, check, comment. The Action is pinned to a full commit SHA, and so are `checkout` and `setup-node`. Today it points at commit `5c498cd` of the Action.
- **README and MIT licence.**

## Proof

| What | Status | Proof |
| --- | --- | --- |
| The workflow file | ✅ | [`wasit.yml`](https://github.com/dzakwannajmi/x402-example-paywall/blob/main/.github/workflows/wasit.yml) |
| `main` conforms (green) | ✅ | [Run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43706042000) (second run, Action at `5c498cd`) · [copy](week-1/copies/run-main-after-fix.log.txt) · first run: [run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43697947796) |
| A deliberate defect gives the red run | ✅ | [Pull request 1](https://github.com/dzakwannajmi/x402-example-paywall/pull/1): a "friendlier network name" breaks check X402-05 |

Six pull requests are kept open on purpose, as proof. They must not be merged.

| Pull request | The change | What the comment shows |
| --- | --- | --- |
| [1](https://github.com/dzakwannajmi/x402-example-paywall/pull/1) | Rewrites `stellar:testnet` as `stellar-testnet` in the payment request | Red: X402-05 fails, with expected and actual values |
| [2](https://github.com/dzakwannajmi/x402-example-paywall/pull/2) | Removes the receiving address from the payment request, then puts it back | Red after the first push, green after the second; the same comment is updated |
| [3](https://github.com/dzakwannajmi/x402-example-paywall/pull/3) | Changes the default port, so the service never answers where the config looks | "No verdict": nothing was graded, the job fails |
| [4](https://github.com/dzakwannajmi/x402-example-paywall/pull/4) | Puts the payment request in the body, the old x402 version 1 style | "Unsupported", not a failure |
| [5](https://github.com/dzakwannajmi/x402-example-paywall/pull/5) | Adds `*.log` to `.gitignore`, opened from a fork of the repository | No comment, because the token of a fork is read-only; the check passes |
| [6](https://github.com/dzakwannajmi/x402-example-paywall/pull/6) | The seller names `stellar:pubnet` in its payment request (local seller and local stand-in facilitator; no payment can be made) | Green: "1 graded on local, stellar:pubnet"; the comment says the payment checks were not run and nothing was signed. Week 2 proof, see job 02 |

## Not shown yet

- ⬜ Payment-tier runs, MPP routes, and the payment-tier half of the fork case (payment checks not run on a fork) (later weeks).

## Result

Partial progress 2026-11-15: the workflow runs on pull requests and on `main`
in the example project; green and red runs, the update of the comment, "no
verdict" and "unsupported" are shown (see job 00).

Update 2026-11-15 (later): the repository was made public, earlier than the
plan (the pre-release). Before the change, its files, its whole history and the
four pull requests were searched for keys and for text that does not belong on a
public page; none was found, and the repository holds no secret. The MIT
License text is unchanged; its copyright line now names the project's author.

Update 2026-11-15 (fork): pull request 5, opened from a fork, ran the read-only
workflow without a comment (see job 00). It is kept open with the other four.

Update 2026-11-15 (pubnet): pull request 6 changes what the local seller names
in its payment request to `stellar:pubnet`, and the read-only workflow passes on
it (see job 02). It is kept open too; none of the six may be merged.
