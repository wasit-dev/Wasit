# Wasit — Continuation Prompt

Paste this as the first message of a new session (or hand it to Opus for a
consult) to pick up the Wasit engagement without re-deriving context. It
covers how to work on this project, where the boundaries are, the writing
rules, and where the actual project status lives. It does not duplicate the
full status; that lives in `.planning/instawards/STATUS.md` and is the
canonical source, updated at the end of every chat that touches it.

---

## 1. What Wasit is

Wasit is an open-source CLI and MCP server that tests whether a developer's
x402 and MPP (Machine Payments Protocol) implementation on Stellar conforms
to the official spec, before they deploy to mainnet. Think Postman/curl for
HTTP API testing, but for x402/MPP protocol conformance. It simulates a
client using the official `@x402/stellar` and `@stellar/stellar-sdk`, sends
real requests to a target service, validates the HTTP response, then
verifies against Stellar RPC that the on-chain settlement actually happened
per spec.

Built solo by Muhammad Dzakwan Najmi (GitHub: dzakwannajmi) for a Stellar
Community Fund Instaward ($3,600 in XLM), submitted through the Stellar
Chapter Ambassador Indonesia program. The SOW is accepted and funded. The
Chapter Lead (Kenny Rivaldi) told Najmi the work is not strictly bound to
the original 30-day window: maximize the project first, reconcile the SOW
wording to match what actually got built. Condition for moving on to SOW 2:
real traction, meaning evidence from real users, not just working software.
Longer-term goal after the Instaward closes out: apply to the SCF Build
Award.

Repo: `github.com/wasit-dev/wasit` (public). Site: `usewasit.dev`. Published
on npm as `@wasit-dev/core`, `@wasit-dev/cli`, `@wasit-dev/server`.

## 2. Status right now

Read `.planning/instawards/STATUS.md` first, every time. It has the job
board, the binding SOW deliverables, open decisions, and a full session log.

As of 2026-09-20: all three packages published at **0.4.0**, tagged `v0.4.0`
and pushed. Three upstream SDK findings filed
([#66](https://github.com/stellar/stellar-mpp-sdk/issues/66),
[#67](https://github.com/stellar/stellar-mpp-sdk/issues/67),
[#70](https://github.com/stellar/stellar-mpp-sdk/issues/70)).

**0.4.0 fixed two defects in Wasit itself**, both about claims it had no basis
for, and both worth knowing before touching the MPP code. First, `Mppx.create`
replaces `globalThis.fetch` with a wrapper bound to one payment method unless
`polyfill: false` is passed, so after `MPP-01` every later channel-mode 402 in
the same process was refused by that wrapper instead of by the service. The CLI
never showed it (fresh process per invocation); the MCP server did, which meant
only the first payment-mode check in a session had been trustworthy. Fixed at
the call site and structurally, by having `fetchTarget` unwrap any
`Symbol.for("mppx.fetch.wrapper")` before use. Second, `MPP-11`, `MPP-12` and
`MPP-14` each need one advancing commitment accepted before they can probe, and
a refusal of that step used to be reported as FAIL; it is now retried three
times against fresh challenges and then reported as `ERROR` with the new
`errorKind: "setup"` and exit code 2. Full write-up:
`docs/evidence/2026-09-17-cross-check-isolation-run.md`.

Local test loop: `./scripts/fixtures.sh start|status|logs|stop` runs all four
fixture servers from one terminal (x402 :3001/protected, charge :3002/data,
channel :3003/data, and a deliberately refusing channel :3004/data that
reproduces a setup failure on demand). `packages/core/test/manual/charge-then-channel.ts`
runs both MPP suites in one process, which is the shape the MCP server has and
the only way to catch cross-check leakage.

Job board state: **Job 03 (recordings)** has the D1 terminal GIF done
(`docs/media/d1-x402.gif`, recorded from the published package) and the D3 MCP
session captured and already embedded in the `v0.4.0` GitHub Release
description; the **two-minute walkthrough video is the one item left**, and
Najmi has chosen to defer it deliberately rather than have a script drafted
from scratch. A prior claim that its script and shot list were already written
could not be verified anywhere in the repo, `.planning/`, or project memory as
of 2026-09-20; treat that as not written until Najmi says otherwise. **Job 02 (third-party validation with operator
authorization)** is still open and is the one SOW line Najmi cannot close
alone. **Job 04 (evidence submission)** is unblocked on everything except
those two.

Also open, not a SOW item:
[stellar/stellar-dev-skill#136](https://github.com/stellar/stellar-dev-skill/pull/136)
adds Wasit to the Community skills list on skills.stellar.org. Checks green,
Copilot approval recommended, human review pending. The skill file itself stays
in this repo at `skills/wasit/SKILL.md`; only a card linking to its raw URL goes
upstream. A merge means listed, not endorsed, and the site says so explicitly,
so the completion summary must not read it as approval. Confirm with
`curl -s https://skills.stellar.org/llms.txt | grep -i wasit` once merged.

One thing deliberately left undone and worth not re-deriving: no registry
parity run exists yet for 0.4.0 (the D1 recording covers the x402 half of it).
The GitHub Release for `v0.4.0` already has the MCP video embedded in its
description (verified 2026-09-20 by resolving the `user-attachments` link in the
release body to its underlying `video/mp4` asset); do not redo that.

For full technical history (every check implemented, every bug found and
fixed, every architecture decision and why), read the memory files in order:
`/areas/wasit.md`, then `/areas/wasit-2.md`, then `/areas/wasit-3.md`. Also
read `/projects/<wasit-project-id>/learnings.md` (hard-won technical facts,
read before touching any SDK) and `/projects/<wasit-project-id>/ways-of-working.md`
(the condensed version of sections 3 and 4 below, kept in memory for
cross-session recall).

## 3. Boundaries — always Najmi's call

Architecture, design, and scope decisions belong to Najmi. Propose options
with real trade-offs; never decide and run with one unilaterally. This
includes things like version bumps, dependency changes, what a check's pass
criteria should be, and how to interpret an ambiguous spec clause.

Execution split, confirmed 2026-09-15: with the local folder connected,
read, edit, and verify files directly on Najmi's machine (`device_bash`)
instead of handing him copy-paste commands. `git add`, `git commit`,
`git push`, and every `npm` action (`install`, `publish`, version bumps that
touch a registry) stay exclusively his. Never run any of it, even if asked
to "just commit this"; hand back the exact commands instead, the way this
project always has.

Never use Claude's own cloud sandbox for this project (no cloning, no
installs, no builds, no tests inside the cloud container). All execution
that isn't file editing happens on Najmi's machine when connected, or as
copy-paste commands he runs himself and pastes the output back from,
matching his standing token-saving preference.

Never guess a package's API. Before writing implementation code against an
SDK, read the real source (`grep`/`cat`/`sed`, or the actual `.d.ts`) and
confirm namespace, signature, and behavior from what's actually there.

Destructive on-chain actions (MPP-13 close, deploying a disposable channel)
always need explicit confirmation before running, and always target a
disposable resource that isn't the regression channel used by MPP-10/11/12/14.

Secrets live in `.env`, read from there at runtime, never hardcoded, never
logged, never echoed back even in an error message.

Escalate to Opus after two failed fix attempts on the same bug, or on a
genuinely ambiguous architecture call. When escalating, or roughly every 20
turns of active coding work, prepare a fresh version of this continuation
prompt rather than letting context accumulate indefinitely.

## 4. Writing rules

Talk to Najmi in Bahasa Indonesia. Code, comments, types, function and
variable names, docstrings, commit messages, and every technical identifier
stay in English, regardless of what language the conversation is in.

Never use the em dash character in anything written for him: chat, drafts,
docs, commit messages. Use a comma, a colon, or parentheses instead.

Outreach messages and GitHub issues drafted for him to send: flowing prose,
no dash or bullet lists. A message that reads as an obviously AI-generated
list of points is a message he won't send.

Production code and its comments reflect final, accurate intent. Guessing
or placeholder content is fine while debugging or searching, never in what
ships.

Run the `/stop-slop` pass (section 5) on every code comment, UI string, and
piece of documentation before calling it finished, including a correction
pass over content that already exists, not only what gets freshly generated.

## 5. `/stop-slop`

A skill by this name has been proposed for Najmi's account (or should be,
if this prompt is being used somewhere it wasn't saved yet: ask him to save
it). Its job: catch generic AI-sounding phrasing in code comments, UI copy,
and documentation, and rewrite it into something that reads like a specific
engineer wrote and reviewed it, in the voice this repo already has. Read
`docs/findings/upstream-sdk.md` or recent commit subjects
(`git log --oneline -20`) for what that voice sounds like: exact about
mechanism and cause, states what's confirmed versus what isn't, no filler.

Run it as a real pass, not a mental checklist: after drafting a comment,
docstring, README section, error message, or UI string, reread it
specifically hunting for the patterns below, and rewrite anything that
matches before it ships.

## 6. Files to read first in a new session, in order

1. `.planning/instawards/STATUS.md`, the canonical status.
2. `docs/findings/upstream-sdk.md`, all three upstream findings and their
   current state.
3. Memory: `/areas/wasit.md` → `/areas/wasit-2.md` → `/areas/wasit-3.md` for
   full technical history, then `ways-of-working.md` and `learnings.md` in
   the project's memory folder.
4. `git log --oneline -20` and `git status` in the repo, to see what's
   landed and what's still sitting uncommitted since the last session.
