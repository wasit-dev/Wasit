# Product Requirements — Wasit

This document states what Wasit is for, who it is for, and what "done" means
for each deliverable. It is the planning-level counterpart to
[README.md](../README.md)'s "The Problem" section (the pitch) and
[docs/design/scope-boundary.md](design/scope-boundary.md) (the boundary
rules) — this file is the one place that ties problem, users, and requirements
together for anyone reviewing scope, including the Instawards SOW.

## Problem statement

x402 and MPP (Machine Payments Protocol) on Stellar each have an official SDK.
Neither has an independent protocol-compliance tester. `stellar-anchor-tests` fills
this role for the anchor ecosystem — an anchor operator can point it at their
deployment and get an answer about whether their service actually implements
SEP-24/31. Nothing equivalent exists for the agentic-payments stack, so "we
support x402" or "we support MPP" is currently a claim nobody can check.

This is not a hypothetical gap. Building Wasit surfaced three concrete,
reproducible divergences between official documentation/SDKs and what those
same packages actually do — a payment-header name that differs between two
official doc pages, a channel-mode error taxonomy that collapses into one
generic HTTP body, and a parameter (`feePayer.envelopeSigner`) whose name
describes the wrong role. Full detail and upstream issue links are in
README's "The Problem" section and [docs/findings/upstream-sdk.md](findings/upstream-sdk.md).

## Target users

- **A developer building an x402 or MPP service on Stellar testnet** who wants
  to know, before telling anyone it works, whether their implementation
  actually settles payments the way the spec says it does.
- **A developer building an x402 or MPP *client*** (including an AI agent
  calling a paid endpoint) who wants a known-conformant fixture to develop and
  test against, rather than a live production service.
- **An AI agent** (Claude Code, Claude Desktop, or any MCP-compatible client)
  invoking the same checks programmatically over MCP, without a human typing
  CLI flags.

Wasit is explicitly **not** aimed at end users of a payment service, or at
security auditors looking at contract source — see Non-goals below.

## Goals

1. Give a definitive, on-chain-verified answer to "does this service correctly
   implement x402?" and "does this service correctly implement MPP (Charge and
   Channel modes)?" — not a schema check, an actual settled-payment check.
2. Make every check traceable to a written spec clause, so a FAIL is an
   argument, not an opinion.
3. Expose the same check suite from two front ends (CLI for a human, MCP for
   an agent) that can never disagree, because both call the same core logic.
4. Surface defects in the official SDKs/docs discovered along the way, and
   report them upstream rather than silently working around them.

## Non-goals (out of scope by design)

- **Not a security audit.** No contract source or bytecode is read. A passing
  result is not a security clearance — see
  [scope-boundary.md](design/scope-boundary.md).
- **Not mainnet.** Every check assumes testnet; nothing has been validated
  against mainnet conditions, and one check (`MPP-13`) is destructive.
- **Not a hosted dashboard or SaaS.** Wasit is a CLI + MCP server the operator
  runs themselves, against their own or an authorized target.
- **Not a general HTTP/schema validator.** It does not check arbitrary API
  correctness — only the x402 and MPP protocol clauses in
  [docs/CHECKS.md](CHECKS.md).
- **Not a replacement for the operator's own authorization.** Wasit enforces
  nothing about who may be tested; that is a policy stated in
  [SECURITY.md](../SECURITY.md), not a software feature (no tool can determine
  service ownership from a URL alone).

## Requirements, mapped to the SOW's three deliverables

### Deliverable 1 — x402 compliance validator CLI + CHECKS.md catalogue
- MUST simulate a real client against `@x402/stellar`, exercising the full
  402-challenge-payment-settlement flow, not just header shape.
- MUST verify settlement independently against Stellar RPC (the token
  contract's own transfer event), not only trust the service's own 2xx
  response.
- MUST support a `--read-only` mode that runs the free checks (`X402-01`–`05`)
  with no payer key and no spend.
- MUST publish every check's pass criterion and spec-clause reference in
  `docs/CHECKS.md`.
- **Status: done.** `X402-01`–`07` implemented and passing against a real
  fixture server and a real third-party facilitator.

### Deliverable 2 — MPP Charge & Channel simulator, including negative checks
- MUST implement MPP Charge-mode settlement verification (`MPP-01`).
- MUST implement MPP Channel-mode deploy, commitment, replay-rejection, and
  monotonicity checks (`MPP-10`, `11`, `12`, `14`).
- MUST implement the destructive close-settlement check (`MPP-13`) behind an
  explicit opt-in, never on by default, with a target-address guard so it
  cannot close the wrong channel.
- MUST default to testnet only, with no code path that reaches pubnet by
  accident.
- **Status: done.** All five Channel-mode checks plus Charge mode are
  implemented and verified end-to-end on testnet, including a full close
  settlement.

### Deliverable 3 — MCP server wrapper (marked optional in the SOW)
- MUST expose the same checks as MCP tools, consuming the same core logic as
  the CLI (no separate reimplementation).
- MUST NOT accept a signing key as a tool argument — keys are read from the
  server's own process environment only.
- MUST NOT register the destructive tool (`wasit_mpp_channel_test_with_close`)
  in `tools/list` unless the server was started with an explicit human
  opt-in — an agent cannot invoke a tool it cannot see.
- **Status: done**, and taken further than "optional": three tools registered
  by default, a fourth behind the destructive opt-in, verified via raw
  JSON-RPC.

### Cross-cutting requirements
- MUST distinguish "the target is broken" (FAIL), "the target could not be
  reached or was misconfigured" (ERROR), and "the check could not run for a
  reason unrelated to correctness" (SKIP) — never collapse these into one
  signal. See [docs/design/error-model.md](design/error-model.md).
- MUST document the CLI, the MCP server, and configuration well enough that
  someone other than the author can run the suite from a clean clone.
- SHOULD report genuine upstream SDK/doc defects found during development,
  privately first when the defect could be a security issue, publicly via
  a filed issue otherwise.

## Success criteria

- All three deliverables implemented, tested against real (non-mocked)
  fixture servers built on the official SDKs, and reachable from both the CLI
  and the MCP server.
- At least one third-party service tested **with the operator's explicit
  authorization** — this is the one requirement not yet satisfied; see
  README's Status table and the evidence package (`docs/evidence/README.md`)
  for the current outreach log. An evidence run against public repos without
  contacting the operator does not count toward this.
- Packages published and installable (`npm install -g @wasit-dev/cli`,
  `npx @wasit-dev/server`) — done.
- Upstream defects, where found, filed against the SDK maintainers with
  reproduction steps — done (`stellar-mpp-sdk#66`, `#67`).

## Constraints

- Builder time only — no hosting/VPS/paid infrastructure, no marketing spend,
  per the Instawards budget rationale.
- Testnet-only scope for the funded work; mainnet support is explicitly not
  planned (see Roadmap in README.md).
- SOW effective date is 28 Aug 2026 (when funds were received), not the
  document's draft date — day-count and week-by-week framing should be read
  against that date.
