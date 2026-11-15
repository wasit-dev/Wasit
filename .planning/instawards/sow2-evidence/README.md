# SOW 2: evidence, week by week

This folder holds the proof of what was built in SOW 2, filed as it happens, so that each week can be reviewed from links instead of explanations. Each week has its own folder with a page that says what was planned, whether it is done, and where to see it.

| Mark | Meaning |
| :---: | --- |
| ✅ | Built, and shown in a real run or a public page. The link opens it. |
| 🟡 | Built and tested, but shown only in part, or only on the maintainer's machine. |
| ⬜ | Planned for a later week. |

## Overview

| Week | Planned | Status | Page |
| :---: | --- | :---: | --- |
| 1 | The read-only Action for GitHub: it runs Wasit's five read-only checks on every pull request and comments the result. The configuration file. "Unsupported" results. The workflow in the example project | ✅ | [Week 1](week-1/proof.md) |
| 2 | The payment checks in CI on test networks, a new check that a refused request does not settle, the network guard, and a pre-release for beta testers | 🟡 First layer of the guard built (in the [draft pull request](https://github.com/wasit-dev/Wasit/pull/23)); the rest not started | |
| 3 | The payment checks for MPP, `wasit init` (setup command), the key setup on the test network, the recent-failures line | ⬜ | |
| 4 | Demo mode, guides, the install-time guarantees, the software bill of materials, the release and the final report | ⬜ | |

## What is not in a page yet

A page is added to a week's folder when there is something to show for it, and only with proof that opens. Nothing is listed as done on the strength of a description alone.

## Where the proof lives

- The code is in this repository (Wasit). Work in progress sits on branches and in pull requests, linked from each page.
- The example project (a small paid web service plus the Wasit workflow) is a separate repository, linked from each page. Where it is private at the time of a review, the page keeps text copies of what the live links show, in that week's `copies/` folder.
- A copy is weaker than the live link; the live link is the authoritative one.
