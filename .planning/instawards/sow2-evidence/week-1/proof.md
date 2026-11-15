# SOW 2, week 1: what we build, what is done, where to see it

Status as of 2026-11-15. Week 1 is planned for 14 to 20 November 2026.

| Mark | Meaning |
| :---: | --- |
| ✅ | Built, and shown in a real run on GitHub. The link opens it. |
| 🟡 | Built and tested, but shown only in part, or only on the maintainer's machine. |
| ⬜ | Planned for a later week. |

## In plain words

Wasit is a tester for web services that ask to be paid (the x402 protocol). It acts like a client, reads what the service answers, and says whether the answer follows the protocol.

Until now someone had to remember to run it. In week 1 we build **a GitHub Action**: a step a developer adds to their own repository so that Wasit runs by itself on every pull request (a proposed change to the code). It starts the service, checks it, and writes the result **as a check on the pull request** and **as one comment** that is updated on each new push. The comment also says what changed compared with `main` (the main, trusted version of the code).

The checks used in week 1 are the five that only read the service's answer (X402-01 to X402-05). **No payment is made and nothing is signed.**

A result is one of: **conformant** (follows the protocol), **non-conformant** (a check failed), **unsupported** (Wasit cannot grade this service, which is not a failure), or **no verdict** (nothing could be tested, which fails the job instead of passing it).

## What we said we would build in week 1, and where it stands

| # | What we build | Status | Where to see it |
| :---: | --- | :---: | --- |
| 1 | The read-only Action: it starts the developer's service inside the job, runs X402-01 to X402-05, writes the check and the job summary | ✅ | [Run on `main`, green](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43697947796) · [copy of its log](copies/run-main-pass.log.txt) |
| 2 | `wasit.config.json`: one file that lists the endpoints, methods, request bodies and environments to test | ✅ | [The file in the example project](https://github.com/dzakwannajmi/x402-example-paywall/blob/main/wasit.config.json) · [the code that reads it](https://github.com/wasit-dev/Wasit/blob/sow2/s1-action/packages/core/src/config.ts). Request bodies and several environments are covered by automated tests; the example project uses one `GET` endpoint |
| 3 | A service Wasit cannot grade (x402 version 1, or a network Wasit does not support) is reported as **unsupported**, not as a failure | ✅ | [Pull request 4](https://github.com/dzakwannajmi/x402-example-paywall/pull/4) · [its run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43700642576) · [copy of the comment](copies/pr-4-comment.md) (refreshed after the Action was updated; the reason starts with a capital letter) |
| 4 | If nothing could be tested (the service did not start or never answered), the job **fails** instead of passing | ✅ | [Pull request 3](https://github.com/dzakwannajmi/x402-example-paywall/pull/3) · [its run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43700635257) · [copy of the comment](copies/pr-3-comment.md) |
| 5 | Each failure says the reason, what was expected and what was found | ✅ | [Pull request 1](https://github.com/dzakwannajmi/x402-example-paywall/pull/1): lines "Expected" and "Actual" · [copy of the comment](copies/pr-1-comment.md) |
| 6 | The comment compares with `main`, links to the fix, and names the Wasit and SDK versions | ✅ | [Pull request 1](https://github.com/dzakwannajmi/x402-example-paywall/pull/1): "Changed since main: New FAIL ... (was PASS on main)", a "Docs" link, and the versions in the first line. With the updated Action the line also names the commit the build came from: see [pull request 4](https://github.com/dzakwannajmi/x402-example-paywall/pull/4) ("built from commit 5c498cd") |
| 7 | The comment is **updated on each push**, not added again | ✅ | [Pull request 2](https://github.com/dzakwannajmi/x402-example-paywall/pull/2): the same comment goes from red to green after a second push · [before](copies/pr-2-comment-before-update.md) · [after](copies/pr-2-comment.md) |
| 8 | The Wasit workflow is added to the example project (Deliverable 3, week 1) | ✅ | [`.github/workflows/wasit.yml`](https://github.com/dzakwannajmi/x402-example-paywall/blob/main/.github/workflows/wasit.yml) |

### The result the plan asked for at the end of week 1

> The read-only Action runs on pull requests in the example project: green on a service that conforms, red on a deliberately broken one, with the comment showing what changed.

✅ **Done.**

- Green: the [run on `main`](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43697947796) and the [second run of pull request 2](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43700781299) (check "Wasit" passes).
- Red: [pull request 1](https://github.com/dzakwannajmi/x402-example-paywall/pull/1), whose change rewrites the network name in the payment request, so check X402-05 fails. Its [run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43698068365) is red.
- The comment on pull request 1 reads (copy):

> **Wasit: non-conformant.** 1 graded (1 non-conformant) on local, stellar:testnet.
>
> | Endpoint | Protocol | Outcome | Checks |
> | --- | --- | --- | --- |
> | quote-of-the-day | x402 | non-conformant | challenge 4/5, 1 failed; payment not run: read-only tier |
>
> **Changed since main** · New FAIL: quote-of-the-day X402-05 (was PASS on main).
>
> **Failures** · quote-of-the-day: X402-05 Network Identifier Valid · Expected: a CAIP-2 id, namespace:reference, such as stellar:testnet · Actual: "stellar-testnet"

## The evidence list of the plan for Deliverable 1

| Evidence the plan lists | Status | Link |
| --- | :---: | --- |
| The workflow file | ✅ | [`wasit.yml`](https://github.com/dzakwannajmi/x402-example-paywall/blob/main/.github/workflows/wasit.yml) |
| One passing run | ✅ | [Run on `main`](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43697947796) |
| One failing run | ✅ | [Run of pull request 1](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43698068365) |
| A pull request where the check and the comment can be seen without technical knowledge | ✅ | [Pull request 1](https://github.com/dzakwannajmi/x402-example-paywall/pull/1): the check "Wasit" is red, and one comment explains why |

## How to check it yourself (about five minutes)

1. Open [pull request 1](https://github.com/dzakwannajmi/x402-example-paywall/pull/1). Near the bottom, the check **Wasit** shows a red cross. Read the comment from `github-actions`: it names the failing check, what was expected and what was found.
2. Open [pull request 2](https://github.com/dzakwannajmi/x402-example-paywall/pull/2). It has two commits. After the first the check was red; after the second it is green, and the **same** comment now says "conformant". The "Commits" tab shows both.
3. Open [pull request 3](https://github.com/dzakwannajmi/x402-example-paywall/pull/3) and [pull request 4](https://github.com/dzakwannajmi/x402-example-paywall/pull/4) to see the "no verdict" and "unsupported" comments.
4. Open the [run on `main`](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43697947796), the job **Wasit**, to read the log. The line "Result: 1 graded (exit 0)" is the pass.

The example project is a private repository at the time of this review. Every link above that points to it has a text copy in the folder [`copies/`](copies/), so the results can be read without access; the live pages are the authoritative ones. The comments on pull requests 3 and 4 were refreshed after the Action was updated to commit `5c498cd`; the comments on pull requests 1 and 2 are those of the first version of the Action.

## The code behind it

| What | Status | Link |
| --- | :---: | --- |
| The code of the Action, the `wasit run` command and the comment, offered for review as a draft pull request to `main` | ✅ | [Pull request 23 of Wasit](https://github.com/wasit-dev/Wasit/pull/23) (public, draft) |
| Its automated checks pass: the site build, the packages on Node 22 and on Node 24 (which include a test of the Action), the preview deploy | ✅ | [CI run](https://github.com/wasit-dev/Wasit/actions/runs/43701892729) |
| The same checks for the last commit, `5c498cd` (it names the commit a result was built from, and pins the Action's references) | ✅ | [CI run](https://github.com/wasit-dev/Wasit/actions/runs/43706023137) |
| A second run on `main` with the updated Action: the report names its build (`"build": "5c498cd"`) and still reads the baseline written by the first run | ✅ | [Run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43706042000) · [copy of its log](copies/run-main-after-fix.log.txt) |
| Automated tests on the maintainer's machine at the last commit: 175 (command line), 620 (core), 10 (server) and 152 (Action), none failing | 🟡 | Run locally |

## Not shown yet

- 🟡 **A pull request from a fork.** The code handles it (GitHub gives such a pull request a read-only token, so the comment is skipped with a message and the check still reports). It has not been run from a real fork, which needs a second GitHub account.
- 🟡 **Windows.** Not run. The Action supports Linux runners in this plan.
- 🟡 **The version number.** The comment names the commit a build came from, but the packages still declare the number 0.7.0 until the pre-release changes it, so the first words read "Wasit 0.7.0, built from commit ...".
- 🟡 **Reading a service on mainnet.** The plan allows the read-only checks to read a deployed mainnet service. It was run only against a local stand-in whose answer names the main network: the five checks passed with no payment. It has not been run against a deployed service.
- ⬜ **Everything that pays, and everything from weeks 2 to 4**: see the [overview](../README.md).
