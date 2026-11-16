# Wasit Instawards SOW 2 — Master Status

> **READ THIS FIRST** for anything about SOW 2. Single source of truth for the
> engagement. Updated at the end of every working session.

Last updated: 2026-11-16: week 1 is done and shown in real runs (job 00 and
job 01). In job 02 the payment tier runs on `main` of the example project and
is not run on a pull request from a fork. The new check, the opt-in and the
pre-release are the next work. The example project is public, so every link in
the review table opens without a login.

---

## What this is

Instawards is a Stellar Community Fund (SCF) program. SOW 2 is the second
statement of work for Wasit, an open-source x402/MPP protocol-compliance tester
for Stellar. It is **accepted** (acceptance message of 2026-11-11). The sprint
started on 2026-11-14 and runs four weeks, with the last two days for the final
report.

SOW 2 puts Wasit into the builder's own workflow:

1. **D1:** a GitHub Action that runs the read-only checks on every pull request.
2. **D2:** the payment checks and MPP in the same Action, a new check, and a
   network guard that keeps payments on test networks unless a capped opt-in is
   switched on.
3. **D3:** `wasit init`, an example project, and guides.

Working style: **one job = one file** in this folder. At the end of a session,
write the result into the job file and update the tables below. Every claim that
a thing is done has a link that opens it (see `07-evidence-submission.md`).

---

## Weekly review: click to check

This table is for screening a week without reading the rest.

| Week | Dates (our calendar) | What the week plans | Status | Click to check |
| --- | --- | --- | --- | --- |
| 1 | 14 to 20 Nov | The read-only Action, `wasit.config.json`, "unsupported" results, the workflow in the example project | ✅ **DONE** | [Red check and comment, PR 1](https://github.com/dzakwannajmi/x402-example-paywall/pull/1) · [Red, then green, same comment, PR 2](https://github.com/dzakwannajmi/x402-example-paywall/pull/2) · [Green run on `main`](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43697947796) · [From a fork, no comment, PR 5](https://github.com/dzakwannajmi/x402-example-paywall/pull/5) · [Job 00](00-read-only-action.md) · [Evidence table](07-evidence-submission.md) |
| 2 | 21 to 27 Nov | Payment checks in CI on test networks, the new check "rejected request does not settle", the network guard and its caps, a pre-release for beta testers | 🟡 **IN PROGRESS** — the payment tier runs on `main` | [Draft pull request with the code](https://github.com/wasit-dev/Wasit/pull/23) · [Payment tier code, PR 30](https://github.com/wasit-dev/Wasit/pull/30) · [Payment tier on `main`, 10 of 10](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43816426654) · [The payment on Stellar Expert](https://stellar.expert/explorer/testnet/tx/beb0a5f94e2c5cb41cad8f5fe1110020dd004c30022b53b853b30ae5ef905a86) · [From a fork, payment checks not run, PR 5](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43819805398) · [Read-only checks pass on a challenge naming `stellar:pubnet`, PR 6](https://github.com/dzakwannajmi/x402-example-paywall/pull/6) · [Job 02](02-guard-and-payment-tier.md) |
| 3 | 28 Nov to 4 Dec | MPP in the Action, `wasit init` and the test-network key setup, recent-failures line, validation of the capped opt-in on our own service | ⬜ **NOT STARTED** | [Job 03](03-mpp-and-validation.md) · [Job 04](04-init.md) |
| 4 | 5 to 11 Dec | Demo mode, guides, install-time guarantees, SBOM, release, final report | ⬜ **NOT STARTED** | [Job 05](05-guides-and-hygiene.md) · [Job 06](06-release-and-final-report.md) |

Marks: ✅ built and shown in a real run or a public page · 🟡 built and tested,
or shown only in part · ⬜ planned for a later week.

---

## Key facts & decisions (don't re-derive these)

| Thing | Value |
| --- | --- |
| Builder | Muhammad Dzakwan Najmi (contact@usewasit.dev) |
| Website | <https://usewasit.dev> |
| Ambassador Chapter | Stellar Chapter Ambassador Indonesia (the Chapter Lead reviews each week) |
| GitHub repo | <https://github.com/wasit-dev/Wasit> (public) |
| Published packages | `@wasit-dev/core`, `cli`, `server` at 0.7.0 on npm. A pre-release is planned for the end of week 2. |
| The Action's code | Directory `action/` on branch `sow2/s1-action`, offered as the draft [pull request 23](https://github.com/wasit-dev/Wasit/pull/23). It is merged with the pre-release, not before. |
| Example project | <https://github.com/dzakwannajmi/x402-example-paywall> — **public since 2026-11-15** (MIT License); every link to it opens without a login |
| Tests | Offline, no keys, no network. At the last commit on the maintainer's machine: command line 175, core 620, server 10, Action 152, none failing. CI on the draft pull request passes: [run](https://github.com/wasit-dev/Wasit/actions/runs/43706023137) |
| Network | Payment checks run on test networks. Any other network is refused (first layer built). The read-only checks only read the service's answer. |
| Calendar | Week 1: 14 to 20 Nov · week 2: 21 to 27 Nov · week 3: 28 Nov to 4 Dec · week 4: 5 to 11 Dec · 12 and 13 Dec: final report |
| Where proofs are copied | `week-1/copies/` — text copies of the comments and job logs that the live links show, kept as an archive in case a run or a comment is later changed or removed. The live link is authoritative. |

---

## SOW deliverables (binding), in short

- **D1 — Wasit in CI, read-only tier:** an Action that starts the builder's x402 service in the job, runs X402-01 to X402-05, and shows a check plus one updated comment (what changed since `main`, expected and actual values, a link to the fix). A `wasit.config.json` lists endpoints, methods, bodies and environments. "Unsupported" is not a failure; "nothing could be tested" fails the job. Evidence: the workflow file, one passing and one failing run, and a pull request where the check and the comment can be seen.
- **D2 — Payment checks in CI, a new check, and MPP:** the payment tier of the same Action on `main` with a payer key in the builder's secrets, never on pull requests from forks; the new check "rejected request does not settle"; MPP charge and channel checks; a network guard (test networks by default) with a capped, explicit opt-in for the x402 payment checks on Stellar mainnet, validated on our own service before it is offered. Evidence: runs with transaction links, the guard refusing, the validation findings.
- **D3 — `wasit init`, example project, guides:** a setup command that reads the service's 402 answer and writes `wasit.config.json`; the example project; demo mode; guides; install-time guarantees and an SBOM. Evidence: recordings of `init`, the example project, the guides, SECURITY.md, the SBOM.
- **Overall:** a pre-release tag (end of week 2), the release, green CI with test counts, a short video of the Action on a pull request, and a final report with an evidence link for each deliverable.

---

## Job board

| # | Job | File | Week | Status | Depends on |
| --- | --- | --- | --- | --- | --- |
| 0 | Read-only GitHub Action (D1) | `00-read-only-action.md` | 1 | ✅ **DONE** — 2026-11-15, runs and pull requests linked | — |
| 1 | Example project with the Wasit workflow (D3, and the place where D2 runs are shown) | `01-example-project.md` | 1, 2, 3 | 🟡 **IN PROGRESS** — workflow done in week 1; payment and MPP runs come with weeks 2 and 3 | #0 |
| 2 | Network guard, payment tier, new check, opt-in, pre-release (D2) | `02-guard-and-payment-tier.md` | 2 | 🟡 **IN PROGRESS** — the payment tier runs on `main` | #0 |
| 3 | MPP in the Action, recent failures, "resource consumed", own facilitator and RPC, validation of the opt-in (D2) | `03-mpp-and-validation.md` | 3 | ⬜ **NOT STARTED** | #2 |
| 4 | `wasit init` and the test-network key setup (D3) | `04-init.md` | 3 | ⬜ **NOT STARTED** | #2 |
| 5 | Demo mode, guides, SECURITY.md, SBOM, pinned MCP examples (D3) | `05-guides-and-hygiene.md` | 4 | ⬜ **NOT STARTED** | #4 |
| 6 | Release and final report (Overall) | `06-release-and-final-report.md` | 4 | ⬜ **NOT STARTED** | all |
| 7 | Evidence submission: every SOW evidence row with its proof | `07-evidence-submission.md` | 1 to 4 | 🟡 **IN PROGRESS** — week 1 rows filled | all |

---

## Open items

- **Windows.** Not run. The Action supports Linux runners in this SOW.
- **Version number.** The comment names the commit a build came from, but the packages still declare 0.7.0 until the pre-release changes it.
- **The draft pull request 23** waits for the pre-release.
- **Links into the code.** The links to the Action's code point at branch `sow2/s1-action`. After the pre-release merge they are moved to `main`.

---

## Session log

| Date | Focus | Outcome |
| --- | --- | --- |
| 2026-11-16 | A pull request from a fork, payment tier | [Pull request 5](https://github.com/dzakwannajmi/x402-example-paywall/pull/5), from a fork, was brought up to date with `main`, so it runs the workflow that asks for `tier: payment`. In [its run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43819805398) the job had no secrets and a read-only token; X402-01 to X402-05 passed, X402-06 to X402-10 were skipped with "payment checks not run: pull request", the run notes that nothing was signed, and no comment was posted ([copy of the log](week-2/copies/run-pr5-fork-payment-tier.log.txt)). |
| 2026-11-16 | The payment tier on `main` | The example project's workflow now runs the payment tier on a push to `main` and on a run started by hand, with a dedicated testnet payer in the repository secret `WASIT_TESTNET_PAYER`, given to the Wasit step only and not on pull requests. In [the run on `main`](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43816426654) the seller ran as its own user, the plan and the caps were printed before anything was signed, X402-01 to X402-10 passed, and X402-06's payment settled on the Stellar test network ([Stellar Expert](https://stellar.expert/explorer/testnet/tx/beb0a5f94e2c5cb41cad8f5fe1110020dd004c30022b53b853b30ae5ef905a86); [copy of the log](week-2/copies/run-main-payment-tier.log.txt)). A first attempt failed: the runner's sudo ignored the option that passes the environment to the seller's user, and the example's payee did not exist on the test network. Both were fixed before this run. Code: [draft pull request 30](https://github.com/wasit-dev/Wasit/pull/30). |
| 2026-11-15 | Read-only checks on a challenge that names `stellar:pubnet` | A week 2 proof that does not need the payment tier. [Pull request 6](https://github.com/dzakwannajmi/x402-example-paywall/pull/6) makes the local seller name `stellar:pubnet` (its facilitator is a local stand-in that cannot verify or settle). Before the push, the same run was made on the maintainer's machine. In [the Action's run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43724229283) X402-01 to X402-05 passed, the payment checks were skipped by the read-only tier, and the comment says nothing was signed ([copy](week-2/copies/pr-6-comment.md)). It is a local seller, not a deployed mainnet service. The pull request stays open as proof. |
| 2026-11-15 | A pull request from a fork | A fork of the example project, made from a second account of the maintainer, opened [pull request 5](https://github.com/dzakwannajmi/x402-example-paywall/pull/5) (one line in `.gitignore`). In [its run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43722428182) the token had read access only, the Action printed that the pull request is from a fork so no comment is posted, no comment was posted, the check "Wasit" passed, and the job summary shows the verdict ([copy](week-1/copies/pr-5-job-summary.md)). The pull request stays open as proof. |
| 2026-11-15 | The example project made public | Before the change, the files, the whole history and the four pull requests were searched for keys and for text that does not belong on a public page; none was found, and the repository holds no secret. It was then made public, earlier than planned, so the proof links open without a login. The copyright line of the MIT License now names the project's author. The four evidence pull requests stay open. |
| 2026-11-15 | Week 1: build, runs and proof | **The read-only Action runs on pull requests in the example project.** Green on a service that conforms ([run on `main`](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43697947796)); red on a deliberately broken one ([pull request 1](https://github.com/dzakwannajmi/x402-example-paywall/pull/1)); the same comment updated red to green after a second push ([pull request 2](https://github.com/dzakwannajmi/x402-example-paywall/pull/2)); "no verdict" when the service never answered ([pull request 3](https://github.com/dzakwannajmi/x402-example-paywall/pull/3)); "unsupported" for an x402 v1 service ([pull request 4](https://github.com/dzakwannajmi/x402-example-paywall/pull/4)). After the first runs, the comment gained the commit a build came from and a capital letter under "Not graded", and the Action's own references were pinned to commit SHAs; pull requests 3 and 4 were re-run on the new Action. The first layer of the network guard and `stellar-sdk` 16.4.1 (the test network is on protocol 30) went into the same draft pull request. |
| 2026-11-14 | Sprint start: design before code | The design of the three deliverables was written and checked before any code: the configuration file, the Action, the network guard and the opt-in, `wasit init`. The example project is rendered from the workshop starter kit and holds the workflow. |
