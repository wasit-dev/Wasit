# Job 02 — Third-Party Validation

Status: 🟡 **IN PROGRESS** · Deliverable: **D2**'s open evidence item —
"at least one third-party ecosystem service tested with the operator's
explicit authorization"

## Goal
Get at least one team actively building x402/MPP on Stellar to either run
Wasit against their own service themselves, or explicitly authorize Wasit
being run against it, and capture the result.

## Model
Find developers actively integrating x402/MPP and suggest **they** run Wasit
against their **own** service. Self-testing needs no permission from anyone;
testing someone else's live service does. This avoids needing to chase
authorization for every candidate found.

## Acceptance criteria
- [ ] At least one third-party service has an actual Wasit run against it, with the operator's explicit authorization (self-test counts).
- [ ] Result captured as terminal output / report, named only with the operator's permission.
- [ ] Findings folded into a written aggregate document (see Job 04).

## Contacted

| Candidate | What they run | Link | Status as of 2026-09-02 |
|---|---|---|---|
| RouteDock (winsznx/routedock) | MPP Charge (provider-a) and MPP Channel (provider-b), live on Cloudflare Workers | github.com/winsznx/routedock/issues/206 | Comment asking explicit permission for non-destructive checks posted; no reply. Note: issue #206 itself is a separate, earlier upstream-SDK bug report (fixed by PR #241) — evidence for the upstream findings, not for this job |
| yripper/stellarpay | x402 + MPP charge + MPP channel in one SDK, live demo on Railway | github.com/yripper/stellarpay#1 | Self-test outreach issue sent (2026-08-31); re-verified open 2026-09-02, no reply yet |
| Stellar-Light/stellar-pay | x402 + MPP charge, live sandbox on Fly.io | github.com/Stellar-Light/stellar-pay/issues/3 | Self-test outreach issue sent (2026-08-31); re-verified open 2026-09-02, no reply yet |
| Blockchain-Oracle/xlmtools | Stellar-native MCP server (`@xlmtools/cli`/`@xlmtools/mcp`), 21 pay-per-call tools, uses `@stellar/mpp` + `mppx` in production on Stellar testnet | github.com/Blockchain-Oracle/xlmtools/issues | Self-test outreach issue opened 2026-09-02. Attempted our own read-only Wasit run first (`wasit test --target https://api.xlmtools.com/search?q=stellar&count=1 --read-only`) to see the shape of their challenge ahead of time: both `api.xlmtools.com` and the root `xlmtools.com` are returning Cloudflare 522 (origin unreachable) as of 2026-09-02, confirmed via curl against the bare domain too — their whole service is down, not just this endpoint. X402-01 correctly FAILed on that basis (got 522, not 402); X402-02..05 SKIPped since no challenge was issued. Not a Wasit or spec finding — just their backend being unreachable right now. Did not proceed to the paid run (X402-06/07) since it would fail regardless while the origin is down. Retry once the outage clears |
| TKCollective/x402-research-skill (the project is "AgentOracle") | AI-agent claim-verification API with an x402 paid tier; live at agentoracle.co | github.com/TKCollective/x402-research-skill/issues | Self-test outreach issue opened 2026-09-02. Read-only Wasit runs confirm the guess in that issue: `/evaluate` returns 200 (still in free beta, `meta.price` literally says "$0.00 (beta; $0.09 USDC per call at GA)"), and `/research` DOES issue a real, well-formed x402 challenge (X402-01..04 all PASS) but its `accepts` network is `eip155:8453` (Base mainnet) only — no Stellar network offered at all, so X402-05 fails on that basis, not a Wasit or spec defect. **Conclusion: AgentOracle cannot currently serve as Stellar third-party evidence** — there is no live Stellar payment option to test against, so no real USDC should be spent testing it. Posted a follow-up comment on the issue with these concrete findings, closing the loop on the question asked in the original post. Revisit only if they reply confirming Stellar support is live/returning |
| fxjrin/defi-copilot | MCP server + REST API selling pay-per-decision DeFi intelligence (best-yield, best-swap) on Stellar via x402, $0.001 USDC per call; testnet-by-default in the published `defi-copilot-mcp` client, mainnet configurable server-side | github.com/fxjrin/defi-copilot | Very strong conceptual fit (same protocol, same network family, same challenge/settle flow Wasit checks) but not testable yet: a read-only Wasit run against `https://api.fxjrin.com/defi/yield/best` fails at the TLS layer (`ERR_TLS_CERT_ALTNAME_INVALID`) — confirmed via `openssl s_client`, the cert served there has no hostname in its SAN, only a bare IP (76.13.192.216), so no HTTPS client can reach the API at all right now. The marketing site (deficopilot.fxjrin.com, on Vercel) is unaffected and loads fine — this is specifically the backend API host being unreachable over TLS. Also worth re-checking once reachable: the package source names its x402 network values `"stellar-testnet"`/`"stellar"` rather than the CAIP-2 `stellar:testnet`/`stellar:pubnet` format X402-05 expects, which may turn out to be a real conformance finding once we can actually see a live challenge. Outreach issue drafted, not yet confirmed sent |

## Deprioritized (checked, not a good fit)

alienworld1/rever-ai mentions x402/MPP and lists `@stellar/mpp` as a
dependency but has no substantive protocol handler code and no live
endpoint. HuydZzz/agentforge returned 404, repo gone.
ACTA-Team/brazil-regional-kit mentions x402 only as a listed feature with no
clear implementation. mpprouter/rozo-mpprouter implements a custom Stellar
payment flow that isn't actually the MPP spec, so running Wasit against it
wouldn't produce useful evidence either way.

## Fallback if nothing converts in time

The SOW explicitly allows a substitute: "the remainder self-hosted reference
services built from the official SDKs." If no outreach candidate has run
Wasit or replied by the time evidence needs to close out, stand up a
self-hosted reference service and run Wasit against it under our own
authorization — not as strong as independent third-party validation, but it
satisfies the letter of the requirement and keeps the timeline moving.

## Re-check, 2026-09-24 (week 4)

- **Outreach threads:** yripper/stellarpay#1, Stellar-Light/stellar-pay#3 and
  Blockchain-Oracle/xlmtools#1 are all still open with **zero comments**.
  RouteDock #206 is closed, and the permission comment there got no reply.
- **xlmtools: ruled out.** The 522 outage has cleared, but `api.xlmtools.com`
  now returns 200 with the same HTML page, for an unrelated site, on every
  path, including `/search` and `/health`. The root `xlmtools.com` serves the
  same page. The domain registration is unchanged since April, the repo was
  last pushed 2026-04-14, and `@xlmtools/cli`/`@xlmtools/mcp` were last
  published 2026-04-14/15. Whatever is answering on that host is not the
  operator's API, so there is nothing to test.
- **defi-copilot: ruled out for now.** `api.fxjrin.com` still presents a
  certificate with no subject and no SAN matching the host, so no HTTPS client
  can connect. The repo was last pushed 2026-04-12, and the outreach issue was
  never sent.
- **AgentOracle:** `TKCollective/x402-research-skill` no longer resolves on
  GitHub.
- Wasit was **not** run against either xlmtools or fxjrin. Neither host is
  serving the operator's API, and no operator has authorized a run.

## Why round one got no replies, and round two (2026-09-24)

Round one's message said "Not asking for anything from you — this is just a
heads-up", so it asked no question and gave nobody a reason to reply. The row
this job exists to close needs an explicit yes. Its links also still pointed at
`dzakwannajmi/wasit` instead of `wasit-dev/wasit`.

Round two asks one direct yes/no question. Candidates came from Raven
(`scout.searchProjects` on x402/MPP, filtered to activity since July), then
each repo and endpoint was checked by hand:

| Candidate | Why | Live endpoint | Status |
|---|---|---|---|
| StellarSight (pedro-pelicioni/stellarsight) | x402 Bazaar discovery index on Stellar; repo pushed 2026-09-23; their own issue #3 asks for a seller-side check that validates a listing before it is announced, which is what Wasit does | `https://stellarsight.xyz/v1/fx/usd-brl` answers 402 on `stellar:testnet`; **read-only Wasit run 5/5 PASS**, no payment made. Asset is their own `SXT` token, not USDC, so a full run needs them to send some or to self-test | **Sent 2026-09-24**: [#13](https://github.com/pedro-pelicioni/stellarsight/issues/13) |
| CleverCon (clevercon-protocol/clevercon) | Agent spending vaults that pay external x402/MPP services; pushed 2026-09-22 | None found yet; they are primarily a payer | **Sent 2026-09-24**: [#134](https://github.com/clevercon-protocol/clevercon/issues/134); asks whether they run an endpoint |
| Talos (enliven17/talos-stellar) | Agents sell services via x402; pushed 2026-09-24 | `talos-stellar.vercel.app` returned 500 | Not contacted |
| OFFER-HUB/X402 | Hackathon repo | None; last push 2026-04-12 | Ruled out |

Both posted 2026-09-24 with Najmi's approval.

The SOW fallback was also run the same day, against `stellar/stellar-mpp-sdk`'s
own example servers: `docs/evidence/2026-09-24-official-sdk-reference-run.md`.
It covers the remainder and does not satisfy this job's row.

## Next action
Re-check all threads (round one and two) around 2026-10-01. If StellarSight says yes, run the full x402 suite against
`/v1/fx/usd-brl` and record it as the D2 authorization evidence, naming them
only with permission.
