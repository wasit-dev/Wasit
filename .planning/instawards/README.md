# Instawards planning

Tracks Wasit's progress against the Instaward statements of work (SOW), the
deliverables, the evidence and the outreach, separately from the root `README.md`.
The root README is written for a developer deciding whether to use Wasit; this
folder is written for the Chapter Lead and the SCF reviewers checking a SOW
against what was actually built. Mixing the two would force one document to serve
two different readers.

| Folder | What | Start at |
| --- | --- | --- |
| [`sow1/`](sow1/) | SOW 1: the x402 validator, the MPP simulator and the MCP server. Every job is done. | [`sow1/STATUS.md`](sow1/STATUS.md) |
| [`sow2/`](sow2/) | SOW 2: Wasit in CI (a GitHub Action), payment checks and MPP, a network guard, `wasit init`, the example project and guides. In progress: week 1 is done. | [`sow2/STATUS.md`](sow2/STATUS.md) |

Each `STATUS.md` is the single source of truth for its SOW: key facts, the SOW's
own deliverables, a job board (one file per piece of work, numbered), open items
and a session log. Each numbered file has its own goal, acceptance criteria and a
`Result` section filled in as the job progresses. Update the job file and the
`STATUS.md` table together, so they do not drift apart.

Layout modeled on a reference `.planning/instawards/` structure the builder
pointed to (cryptoeights/orbit-protocol), adapted to Wasit's own SOW and status.

Nothing here is meant to be polished prose. It is a working checklist, updated in
place, so status can be trusted at a glance.
