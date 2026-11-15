# Job 00 — Read-only GitHub Action

Status: ✅ **DONE** (2026-11-15) · Deliverable: **D1** · Week: **1** · Depends on: —

## Goal

A GitHub Action that a builder adds to their own repository. On every pull
request it starts their x402 service inside the job, runs Wasit's read-only
checks (X402-01 to X402-05) and shows the result as a check on the pull request
and as one comment that is updated on each push. The comment has one row per
endpoint, counts per group of checks, what changed compared with `main`, and for
each failure the reason, the expected and actual values and a link to the fix.

No payment is made and nothing is signed in this tier.

## Acceptance criteria

- [x] The Action starts the service inside the job, runs X402-01 to X402-05, and writes the check and the job summary.
- [x] `wasit.config.json` lists the endpoints, methods, request bodies and environments.
- [x] A service Wasit cannot grade (x402 version 1, or a network Wasit does not support) is reported as "unsupported", not as a failure.
- [x] If nothing could be tested (the service did not start or never answered), the job fails instead of passing.
- [x] Each failure names the reason, what was expected and what was found.
- [x] The comment compares with `main`, links to the fix and names the Wasit and SDK versions.
- [x] The comment is updated on each push, not added again.
- [x] The result the plan asks for at the end of week 1: green on a service that conforms, red on a deliberately broken one, with the comment showing what changed.

## What shipped

- **`wasit.config.json`, version 1.** One file read the same way by the command line and the Action. It is strict: an unknown key is an error, and a secret, a secret's variable name, the mainnet opt-in, a flag that enables MPP-13 and a per-payment cap have no place in it. Code: [`config.ts`](https://github.com/wasit-dev/Wasit/blob/sow2/s1-action/packages/core/src/config.ts).
- **`wasit run --read-only`.** Runs the checks for every endpoint of the config and writes one report (`--json`, `--out`). It can start the service itself (`--start`, `--start-if-local`) and compare with the report of the default branch (`--baseline`). Code: [`run.ts`](https://github.com/wasit-dev/Wasit/blob/sow2/s1-action/packages/cli/src/run.ts).
- **The run report and the exit rules.** Each endpoint is `conformant`, `non-conformant`, `unsupported` or `no verdict`. Exit 0: every graded endpoint conforms. Exit 1: an endpoint does not conform, or one graded on `main` is not graded now. Exit 2: nothing could be graded, a check could not run, or the config or service could not be used.
- **`wasit ci-report`.** Renders the pull request comment and the job summary from a report. One sanitiser covers everything a service sent, so a hostile answer cannot inject text, links, mentions or workflow commands into the comment or the log. Code: [`ci-report.ts`](https://github.com/wasit-dev/Wasit/blob/sow2/s1-action/packages/core/src/ci-report.ts).
- **The Action.** A composite action for Linux runners with Node 22: [`action/action.yml`](https://github.com/wasit-dev/Wasit/blob/sow2/s1-action/action/action.yml). The baseline comes from the last successful run on the default branch; the comment is found by a marker and updated; a pull request from a fork is handled (it gets a read-only token, so the comment is skipped with a message). Its own third-party references are pinned to commit SHAs. The template for a builder's repository: [`action/examples/wasit.yml`](https://github.com/wasit-dev/Wasit/blob/sow2/s1-action/action/examples/wasit.yml).
- **A step in CI that tests the Action.**

Tests, offline: command line 175, core 620, server 10, Action 152, none failing (maintainer's machine, last commit). CI on the draft pull request passes: [run](https://github.com/wasit-dev/Wasit/actions/runs/43706023137).

## Proof

Base of the example project: <https://github.com/dzakwannajmi/x402-example-paywall> (public since 2026-11-15; text copies in `week-1/copies/` are kept as an archive).

| What the plan says | Status | Proof |
| --- | --- | --- |
| The Action starts the service, runs X402-01 to X402-05, writes the check and the job summary | ✅ | [Run on `main`, green](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43697947796) · [copy of its log](week-1/copies/run-main-pass.log.txt) |
| `wasit.config.json` with endpoints, methods, bodies and environments | ✅ | [The file in the example project](https://github.com/dzakwannajmi/x402-example-paywall/blob/main/wasit.config.json). Bodies and several environments are covered by automated tests; the example uses one `GET` endpoint |
| "Unsupported", not a failure | ✅ | [Pull request 4](https://github.com/dzakwannajmi/x402-example-paywall/pull/4) · [run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43700642576) · [copy of the comment](week-1/copies/pr-4-comment.md) |
| A failed job when nothing could be tested | ✅ | [Pull request 3](https://github.com/dzakwannajmi/x402-example-paywall/pull/3) · [run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43700635257) · [copy of the comment](week-1/copies/pr-3-comment.md) |
| Failure reasons with expected and actual values | ✅ | [Pull request 1](https://github.com/dzakwannajmi/x402-example-paywall/pull/1): "Expected" and "Actual" · [copy of the comment](week-1/copies/pr-1-comment.md) |
| The comment compares with `main`, links to the fix, names the versions | ✅ | [Pull request 1](https://github.com/dzakwannajmi/x402-example-paywall/pull/1): "New FAIL ... (was PASS on main)", a "Docs" link, versions in the first line. [Pull request 4](https://github.com/dzakwannajmi/x402-example-paywall/pull/4) also names the commit the build came from |
| The comment is updated on each push | ✅ | [Pull request 2](https://github.com/dzakwannajmi/x402-example-paywall/pull/2): the same comment goes from red to green after a second push · [before](week-1/copies/pr-2-comment-before-update.md) · [after](week-1/copies/pr-2-comment.md) |
| Green on a conforming service, red on a broken one | ✅ | Green: the [run on `main`](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43697947796) and the [second run of pull request 2](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43700781299). Red: the [run of pull request 1](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43698068365) |
| A pull request from a fork: no comment, and the check still reports | ✅ | [Pull request 5](https://github.com/dzakwannajmi/x402-example-paywall/pull/5), from a fork · [run](https://github.com/dzakwannajmi/x402-example-paywall/actions/runs/43722428182) · [copy of its log](week-1/copies/run-pr5-fork.log.txt): the job's token has read access only (Actions, Contents, Metadata, PullRequests), the Action prints "this pull request is from a fork, so the token is read-only and no comment is posted", the pull request has 0 comments and the check "Wasit" passes. The result is in the job summary: "Wasit: conformant. 1 graded on local, stellar:testnet", one row for the endpoint, "No change since main" ([copy of the summary](week-1/copies/pr-5-job-summary.md)) |
| The code and its automated checks | ✅ | [Draft pull request 23](https://github.com/wasit-dev/Wasit/pull/23) · [CI run](https://github.com/wasit-dev/Wasit/actions/runs/43706023137): site build, packages on Node 22 and Node 24, preview deploy |

The comment on pull request 1 reads (copy):

> **Wasit: non-conformant.** 1 graded (1 non-conformant) on local, stellar:testnet.
>
> | Endpoint | Protocol | Outcome | Checks |
> | --- | --- | --- | --- |
> | quote-of-the-day | x402 | non-conformant | challenge 4/5, 1 failed; payment not run: read-only tier |
>
> **Changed since main** · New FAIL: quote-of-the-day X402-05 (was PASS on main).
>
> **Failures** · quote-of-the-day: X402-05 Network Identifier Valid · Expected: a CAIP-2 id, namespace:reference, such as stellar:testnet · Actual: "stellar-testnet"

## Not shown yet

- 🟡 **Windows.** Not run.
- 🟡 **The version number.** The comment names the commit a build came from, but the packages declare 0.7.0 until the pre-release, so it reads "Wasit 0.7.0, built from commit ...".
- 🟡 **Reading a deployed service on mainnet.** The plan allows the read-only checks to read a deployed mainnet service. It was run only against a local stand-in whose answer names the main network: five checks passed, no payment made. It was not run against a deployed service.

## Result

Done 2026-11-15: every item of the week 1 plan for D1 is shown in a real run on GitHub.

Partial progress 2026-11-15 (first runs): the green run on `main` and the red run on pull request 1, with the comment showing the comparison with `main`. Pull requests 2, 3 and 4 then showed the update of the comment on a new push, the "no verdict" result and the "unsupported" result.

Partial progress 2026-11-15 (second runs): two small defects seen in the first comments were fixed and shown again. The comment names the commit a build came from, and the reason under "Not graded" starts with a capital letter. The Action's own third-party references are pinned to commit SHAs. Pull requests 3 and 4 were re-run on the new Action and their comments were edited in place; pull requests 1 and 2 keep the comments of the first version.

Update 2026-11-15 (later): the example project is public, so the links above open without a login. The text copies stay as an archive.

Update 2026-11-15 (fork): a pull request from a real fork (pull request 5) ran the workflow. The Action made no comment because the token of a fork is read-only, and the check passed. The result is in the job summary. What the log and the summary show is quoted in the proof table.
