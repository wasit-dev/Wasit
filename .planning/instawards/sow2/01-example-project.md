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
- [ ] A pull request from a fork shows the payment checks were not run (week 2, needs a second GitHub account).
- [ ] MPP charge and channel routes with runs in the same comment format (week 3, job 03).
- [ ] The repository is public (with the pre-release).

## What shipped

Repository: <https://github.com/dzakwannajmi/x402-example-paywall> (private at the time of this review).

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

Four pull requests are kept open on purpose, as proof. They must not be merged.

| Pull request | The change | What the comment shows |
| --- | --- | --- |
| [1](https://github.com/dzakwannajmi/x402-example-paywall/pull/1) | Rewrites `stellar:testnet` as `stellar-testnet` in the payment request | Red: X402-05 fails, with expected and actual values |
| [2](https://github.com/dzakwannajmi/x402-example-paywall/pull/2) | Removes the receiving address from the payment request, then puts it back | Red after the first push, green after the second; the same comment is updated |
| [3](https://github.com/dzakwannajmi/x402-example-paywall/pull/3) | Changes the default port, so the service never answers where the config looks | "No verdict": nothing was graded, the job fails |
| [4](https://github.com/dzakwannajmi/x402-example-paywall/pull/4) | Puts the payment request in the body, the old x402 version 1 style | "Unsupported", not a failure |

## Not shown yet

- ⬜ Payment-tier runs, MPP routes, and a pull request from a fork (later weeks).
- ⬜ A public repository: planned with the pre-release.

## Result

Partial progress 2026-11-15: the workflow runs on pull requests and on `main`
in the example project; green and red runs, the update of the comment, "no
verdict" and "unsupported" are shown (see job 00).
