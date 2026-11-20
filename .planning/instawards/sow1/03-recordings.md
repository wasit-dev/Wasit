# Job 03 — Recordings

Status: ✅ **DONE** (D1, D3 and the walkthrough video) · Deliverable: **D1 + D3 + Overall** (evidence) ·
Depends on: #1 (npm publish, so the recordings show the real published
packages, not a local checkout)

## Goal
Produce the three recordings the SOW lists as evidence, all still missing.

## Required recordings

1. **D1 — x402 validator terminal recording / GIF.** Shows `wasit test
   <target>` running against a sample service and producing a pass/fail
   report. Can reuse `docs/evidence/2026-08-15-third-party-run.md`'s targets
   or a fresh run against a self-hosted reference service.
2. **D3 — MCP screen recording.** Shows a compliance check triggered
   directly from Claude Code via the MCP server (`docs/guides/mcp.md` has
   the exact `claude mcp add` command to set this up first).
3. **Overall — two-minute walkthrough video.** Plain-language summary of
   what Wasit is and does, feeding into the one-page completion summary in
   Job 04. This is the primary artifact the Chapter Lead reviews.

## Acceptance criteria
- [ ] D1 recording made, hosted somewhere linkable (GitHub, YouTube, Loom).
- [ ] D3 recording made, same.
- [x] Overall walkthrough video made, under ~2 minutes as the SOW specifies.
- [ ] All three links recorded here and carried into `04-evidence-submission.md`.

## Notes
Use the already-published `@wasit-dev/cli` / `@wasit-dev/server` (via `npx`)
in the recordings rather than a local build — that's what a real user
installs, and it doubles as another live confirmation the npm packages work
end to end. Keep each recording short and focused on one thing; three short
clips are easier to review than one long one.

## Result

**2026-09-18 — D1 recording done.** `docs/media/d1-x402.gif` (620 KB) with the
raw capture beside it as `d1-x402.cast`. Recorded from the published package via
`npx -y @wasit-dev/cli@0.4.0`, opening with `--version` printing `0.4.0` so the
recording proves which artifact produced the output. Four shots: version,
`checks --protocol x402` listing all seven, a read-only run at 5 passed, and a
full run at 7 passed including a settled payment (`X402-06`) and a rejected
corrupted signature (`X402-07`). Embedded in the README's Trying It section.

That recording doubles as the x402 half of a registry parity run for 0.4.0,
which `docs/evidence/2026-09-17-cross-check-isolation-run.md` lists as an open
gap: every command in it came from the registry rather than a local build.

**D3 recording captured, not yet published.** Raw capture
`docs/media/d3-mcp-session.mov` (26 MB), compressed to
`docs/media/d3-mcp-session.mp4` (2.2 MB, 1280x1386, 60s). Both are kept out of
git: `.gitignore` excludes `docs/media/*.mov|mp4|webm`, because large binaries
do not belong in a history they can never be removed from. The video is
published as a GitHub Release asset on `v0.4.0` instead, and the link recorded
here once uploaded. At 2.2 MB it also fits GitHub's attachment limit, so
dragging it into the release description gives a player that runs in the page
rather than a file a reviewer has to download.

A poster frame, `docs/media/d3-mcp-session-poster.png`, **is** committed: it is
the last frame, showing the MPP channel suite conformant immediately after the
charge tool call in the same session. Both recordings sit side by side in a
two-column table in the README's Trying It section, each clickable, so the front
page carries the evidence without either one dominating the scroll.

**Still open:** the two-minute walkthrough video, and hosting links for D3.

**2026-09-24 — D3 hosting link recorded.** The MCP session video is embedded in the
[`v0.4.0` GitHub Release](https://github.com/wasit-dev/wasit/releases/tag/v0.4.0)
description as a `user-attachments` video, playable in place. D1 and D3 are both
carried into `04-evidence-submission.md`. **Only the two-minute walkthrough video
remains**, deliberately deferred and with no script written yet.

**2026-09-25 — walkthrough video published:** https://youtu.be/5SbNf7j4dbc. Script (EN/ID) kept local-only in
`local/walkthrough-script.md`. Job 03 is complete.
