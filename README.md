<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="frontend/public/logo-light.svg" />
  <img src="frontend/public/logo-dark.svg" alt="Wasit" width="360" />
</picture>

# Wasit

**Protocol-compliance testing for x402 and MPP.**

Wasit runs the real payment flow against a live service, not a mock of it, and
it is not a schema validator: a response can have every field in the right place
and still take money without settling it. Settlement is verified on-chain, from
the chain's own record of the transfer rather than the service's response: the
token contract's transfer event on Stellar, the token's `Transfer` log on Base
and Ethereum, the token balances on Solana. x402 is tested on Stellar testnet,
Base Sepolia, Ethereum Sepolia and Solana devnet; MPP on Stellar testnet.

[![CI](https://github.com/wasit-dev/wasit/actions/workflows/ci.yml/badge.svg)](https://github.com/wasit-dev/wasit/actions/workflows/ci.yml)
[![Testnets](https://img.shields.io/badge/Testnets-Stellar%20%C2%B7%20Base%20%C2%B7%20Ethereum%20%C2%B7%20Solana-7c3aed)](docs/guides/cli.md)
[![x402](https://img.shields.io/badge/Protocol-x402%20v2-0891b2)](https://x402.org)
[![MPP](https://img.shields.io/badge/Protocol-MPP-111827)](https://paymentauth.org)
[![MCP](https://img.shields.io/badge/Interface-CLI%20%2B%20MCP-16a34a)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org)

[Website](https://usewasit.dev) ·
[Walkthrough Video](https://youtu.be/5SbNf7j4dbc) ·
[Check Catalogue](docs/CHECKS.md) ·
[CLI Guide](docs/guides/cli.md) ·
[MCP Guide](docs/guides/mcp.md) ·
[Configuration](docs/guides/configuration.md) ·
[Design Notes](#design-notes)

</div>

---

## Table of Contents

- [How It Works](#how-it-works)
- [Who You May Point It At](#who-you-may-point-it-at)
- [What a Passing Result Means](#what-a-passing-result-means)
- [The Problem](#the-problem)
- [Status](#status)
- [Install](#install)
- [Building from source](#building-from-source)
- [Trying It](#trying-it)
- [Design Notes](#design-notes)
- [Roadmap](#roadmap)

---

## How It Works

Wasit talks to two things: the service under test, over HTTP, and the chain the
payment settles on, over RPC. It never trusts the first about what happened on
the second.

```mermaid
flowchart TB
    subgraph interfaces["Two front ends, one core"]
        CLI["wasit CLI"]
        MCP["wasit-mcp<br/>MCP server"]
    end

    CORE["@wasit-dev/core<br/>check suites"]

    subgraph target["The artifact under test"]
        SVC["Your running service"]
    end

    CHAIN["Chain RPC<br/>Stellar, Base, Ethereum, Solana testnets"]

    CLI --> CORE
    MCP --> CORE
    CORE -->|"1 . unpaid request"| SVC
    SVC -->|"2 . 402 + challenge"| CORE
    CORE -->|"3 . signed payment"| SVC
    SVC -->|"4 . 2xx + receipt"| CORE
    CORE -->|"5 . verify independently"| CHAIN

    style CHAIN stroke-width:2px
```

Step 5 is the point of the tool. The challenge in step 2 states what the service
wants paid; the receipt in step 4 states what it claims happened. Wasit compares
both against what the chain actually recorded — including the token's own
record of the transfer, not just the transaction it was asked to make.

The CLI and the MCP server are thin adapters over the same suite functions. They
cannot disagree about the same target, because there is only one implementation
of each check.

---

## Who You May Point It At

Wasit settles real payments and can permanently close a payment channel, so
pointing it at a service is an action taken against someone else's system.
**Testing any target outside your own control requires the operator's explicit
written authorization.** That is a rule binding on the builder and on every user
of the tool, not a feature of the software: no tool can work out from a URL
alone who owns the service behind it.

Two guards follow from that rather than replace it. The destructive check does
not run at all without an explicit opt-in, and in the MCP server the destructive
tool is not even registered unless a person started the process intending it to
exist. Everything else is on the operator running the tool.
[SECURITY.md](SECURITY.md) states the full policy, including how keys are
handled and how findings about someone else's service are disclosed.

---

## What a Passing Result Means

A passing run means one thing: at the moment of the run, against the target
given, the service implemented the checked clauses of the x402/MPP specs
correctly, and the settlements it claimed were confirmed on-chain — against the
spec and SDK versions the report names.

It is not a security assessment, not an audit, and not a statement about the
safety of the contracts a service settles through, its key management, its
infrastructure, or its business logic. No source is read and no bytecode is
analysed. That is a different artifact under test, and it belongs to dedicated
tooling — Scout, the Certora Sunbeam Prover, Komet, OpenZeppelin's Soroban
detectors — which Wasit is built to run alongside rather than replace.

Only the target URL given was tested. Only clauses with a catalogue entry were
checked; every entry traces to a written clause, and clauses without one are
simply not covered yet. A service can also regress after passing. The full
boundary is in [docs/design/scope-boundary.md](docs/design/scope-boundary.md).

---

## The Problem

x402 and MPP have an official SDK. They have no independent protocol-compliance tester.

`stellar-anchor-tests` fills that role for the anchor ecosystem: an anchor
operator points it at their deployment and gets an answer about whether their
service actually implements the protocol. Nothing equivalent exists for the
agentic-payments stack, so "we support x402" is currently a claim nobody can
check.

That gap is not theoretical. Three concrete divergences turned up while building
this tool, all against official, current packages:

**The payment header has two names.** Stellar's own documentation uses
`PAYMENT-REQUIRED` in one place and `X-Payment` in another. A client written
from one page will not find the header emitted by a server written from the
other. `X402-02` deliberately accepts either, because refusing one would mean
failing services that followed official documentation — but a service cannot
know which convention its callers expect. This is a documentation defect
upstream, and it is exactly the kind of thing a protocol-compliance tester exists to
surface.

**A whole error taxonomy is unreachable.** In MPP channel mode, every rejection
— replay, non-monotonic commitment, bad signature, a channel already settling —
returns an identical HTTP 402 body. The SDK defines precise error types for each
of these and none are reachable, because of a class-hierarchy mismatch between
two packages. An operator debugging a rejected payment cannot tell which rule
they broke. See [docs/CHECKS.md](docs/CHECKS.md#mpp--channel-mode)
and the full write-up in [docs/findings/upstream-sdk.md](docs/findings/upstream-sdk.md).
Filed upstream as [stellar-mpp-sdk#66](https://github.com/stellar/stellar-mpp-sdk/issues/66);
independently confirmed by [RouteDock's fix](https://github.com/winsznx/routedock/pull/241)
for the same defect.

**A parameter named for one thing does another.** `feePayer.envelopeSigner`
reads like the account paying transaction fees. It is actually the account
providing authorisation, and the channel contract requires different accounts
for different operations. Getting it wrong produces a transaction that reaches
the chain and fails there, surfaced by the SDK as `[object Object]`. Filed
upstream as [stellar-mpp-sdk#67](https://github.com/stellar/stellar-mpp-sdk/issues/67).

Wasit exists so these are found by a tool, before they are found by a user.

---

## Status

| Area                                   | Status                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| x402 read-only checks (`X402-01`–`05`) | Done, on a challenge from any chain; verified against a real facilitator                                                                                                                                     |
| x402 payment checks (`X402-06`–`10`)  | Done on Stellar testnet, Base Sepolia, Ethereum Sepolia and Solana devnet, settlement verified from each chain's own record                                                                                    |
| MPP charge mode (`MPP-01`)             | Done, settlement verified from contract events; pays only on the run's network                                                                                                                               |
| MPP channel mode (`MPP-10`–`14`)       | Done, including destructive close                                                                                                                                                                            |
| CLI                                    | Done — six subcommands, `wasit serve` among them, plus an interactive dashboard                                                                                                                              |
| Testnet wallet tooling                 | Done — `wasit wallet` create/fund/status on Stellar testnet, and for the x402 payer on Base Sepolia, Ethereum Sepolia and Solana devnet                                                                      |
| MCP server                             | Done, three tools + one behind an opt-in                                                                                                                                                                     |
| Error taxonomy and exit codes          | Done                                                                                                                                                                                                         |
| Wasit's own test suite                 | Done — offline (no keys, no target, no network); type-check and tests both run in CI                                                                                                                          |
| Testing against third-party services   | Done — one third-party service, [defi-copilot](docs/evidence/2026-09-28-authorized-third-party-run.md), tested with its operator's written authorization as a local instance, plus Stellar's own reference implementations ([x402](docs/evidence/2026-09-06-reference-implementation-run.md), [MPP](docs/evidence/2026-09-24-official-sdk-reference-run.md)); reported in aggregate in [conformance-findings.md](docs/findings/conformance-findings.md) |
| Upstream reports to SDK maintainers    | Filed — [stellar-mpp-sdk#66](https://github.com/stellar/stellar-mpp-sdk/issues/66), [#67](https://github.com/stellar/stellar-mpp-sdk/issues/67), [#70](https://github.com/stellar/stellar-mpp-sdk/issues/70) (closed; fix merged, unreleased), [#82](https://github.com/stellar/stellar-mpp-sdk/issues/82) (fixed in [#83](https://github.com/stellar/stellar-mpp-sdk/pull/83), verified), [#89](https://github.com/stellar/stellar-mpp-sdk/issues/89) |
| Published to npm                       | Yes — `@wasit-dev/core`, `@wasit-dev/cli`, `@wasit-dev/server`                                                                                                                                               |
| Mainnet                                | Out of scope — see [Design Notes](#design-notes)                                                                                                                                                             |

Sixteen checks are implemented and reachable from both front ends. Every one is
traced to a written spec clause in [docs/CHECKS.md](docs/CHECKS.md); a check that
cannot be traced is out of scope by construction.

---

## Install

Requires Node.js `>=22`.

```bash
# run it once, no install
npx @wasit-dev/cli test --target https://your-service.example/paid --read-only

# or keep it around
npm install -g @wasit-dev/cli
wasit test --target https://your-service.example/paid --read-only
```

That runs `X402-01` through `X402-05` against your own service. It costs
nothing, needs no keys, and settles no transaction. `wasit checks` lists every
check the tool can run, and `--json` on any run gives machine-readable output.

Running `wasit` with no arguments in a terminal opens an interactive dashboard
— the same checks, plus a check catalogue browser and a testnet wallet screen,
driven by arrow keys. Piped or in CI it prints help instead, so nothing that
scripts Wasit today changes behaviour. `wasit wallet create|fund|status`
is the same wallet tooling as plain subcommands: on Stellar it generates
testnet keys, funds them through Friendbot, and opens a USDC trustline; with
`--network` it generates the x402 payer for Base Sepolia, Ethereum Sepolia or
Solana devnet and shows its USDC. `wasit serve` runs a local x402 paywall that
misbehaves on purpose, to test an agent that pays. All of it is covered in
[docs/guides/cli.md](docs/guides/cli.md).

The checks that settle a real testnet payment — `X402-06` to `X402-10`,
`MPP-01`, and the channel suite — need a funded testnet account.
[docs/guides/configuration.md](docs/guides/configuration.md) explains each value
and where to get it. For the MCP server, see
[docs/guides/mcp.md](docs/guides/mcp.md).

## Building from source

Only needed to change Wasit itself, or to run the bundled fixture servers below.
Developed and verified on Node **v26.8.1**; CI runs Node 22 and 24.

```bash
git clone https://github.com/wasit-dev/wasit.git
cd wasit
npm install
npm run build
cp .env.example .env
```

Before publishing, verify the packages as a user receives them rather than as
the repo builds them:

```bash
npm run verify:clean-install
```

A checkout deduplicates one dependency graph across all three workspaces; a
clean install resolves each package's own declared ranges and can nest a second
copy of something the checkout collapsed into one. So a green checkout can
still ship a broken tarball — `0.1.1` documented `wasit checks` and `--json`
that the published package did not contain. This packs the three packages,
installs them into an empty project, and drives the result the way a user
would: the CLI's own binary and the MCP server over stdio. It runs in CI too.

---

## Trying It

Eight fixture servers are bundled. Seven are real servers built on the official
SDKs, not mocks — testing against a mock would mean testing against our own
assumptions, and one of the defects listed above was found precisely because the
fixtures are real. The other is a deliberate misbehaver, described below. The
Base Sepolia, Ethereum Sepolia and Solana devnet fixtures start only when `.env`
names their payee (`EVM_PAYEE_ADDRESS`, `SVM_PAYEE_ADDRESS`). The Ethereum Sepolia
one also needs `EVM_FACILITATOR_PRIVATE_KEY`: it runs the official SDK's
facilitator itself, which pays the gas from that key.

Start them all at once:

```bash
./scripts/fixtures.sh start     # start, then `status`, `logs`, `stop`
```

Or start them, run every suite against them, print one summary and stop them
again, in a single command:

```bash
./scripts/run-all.sh            # free checks only: X402-01..05, MPP-10..12/14
./scripts/run-all.sh --full     # also X402-06..10 and MPP-01, which move testnet funds
./scripts/run-all.sh --npm      # run the published CLI instead of this checkout
```

`MPP-13` never runs from this script: it closes a channel permanently. The exit
code follows the CLI's.

Or run any of them by hand, one terminal each:

```bash
npx tsx packages/core/test/fixtures/x402-real-server.ts             # :3001/protected
npx tsx packages/core/test/fixtures/mpp-charge-server.ts            # :3002/data
npx tsx packages/core/test/fixtures/mpp-channel-server.ts           # :3003/data
npx tsx packages/core/test/fixtures/mpp-channel-refusing-server.ts  # :3004/data
npx tsx packages/core/test/fixtures/x402-evm-server.ts              # :3005/protected, Base Sepolia, EIP-3009
npx tsx packages/core/test/fixtures/x402-evm-permit2-server.ts      # :3006/protected, Base Sepolia, Permit2
npx tsx packages/core/test/fixtures/x402-svm-server.ts              # :3007/protected, Solana devnet
npx tsx packages/core/test/fixtures/x402-evm-sepolia-server.ts      # :3008/protected, Ethereum Sepolia
```

The refusing one (`:3004`) issues valid channel challenges and then refuses every credential. It
is not a conformance target and must never be used as one. It exists to
reproduce, on demand, a run where the precondition a channel check needs cannot
be established, so the reporting path for that case can be exercised without
racing two runs against a real channel. Pointed at it, `MPP-11`, `MPP-12` and
`MPP-14` all report `ERROR (setup)` and the run exits `2`.

Then, from another terminal:

```bash
# x402 — read-only, free
node packages/cli/dist/index.js test --target http://localhost:3001/protected --read-only

# x402 — full flow, settles a real testnet payment
node packages/cli/dist/index.js test --target http://localhost:3001/protected

# x402 on Base Sepolia — the same checks, paid in Base Sepolia USDC
node packages/cli/dist/index.js test --target http://localhost:3005/protected --network eip155:84532

# MPP charge — settles a real testnet payment
node packages/cli/dist/index.js mpp-charge --target http://localhost:3002/data

# MPP channel — free; MPP-13 is skipped unless explicitly enabled
node packages/cli/dist/index.js mpp-channel --target http://localhost:3003/data
```


A passing run looks like this, from the Stellar fixture on 0.7.0:

```
PASS  X402-01  402 Response Status
      Server responded with 402 as required.
...
PASS  X402-06  Signature Resubmit Accepted
      Valid payment accepted (HTTP 200) and settled on-chain for exactly the advertised 100000 base units of CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA to GDPAPDZWAKBXUPCNMI4YHAZ7DS7UOUTPGXAFDSWZG4URRMWHFSQTDQBM, verified from the transfer event (tx 1b569989e64253c8fd4714400e7aa08b126db4b049573e88fa7febe0e9f1792d).
PASS  X402-07  Invalid Signature Rejected
      Payment with a corrupted authorization signature correctly rejected (HTTP 402: invalid_exact_stellar_payload_simulation_failed).
PASS  X402-08  Payment Replay Rejected
      The same payment, sent again, was refused (HTTP 402: invalid_exact_stellar_payload_simulation_failed).
PASS  X402-09  Underpayment Rejected
      A validly signed payment for 50000 of the advertised 100000 base units was refused (HTTP 402: invalid_exact_stellar_payload_wrong_amount).
PASS  X402-10  Expired Authorization Rejected
      A payment whose authorization had expired was refused (HTTP 402: invalid_exact_stellar_payload_simulation_failed).

10 passed.
```

A failing one distinguishes what broke from what was never tested, and says what
to change:

```
FAIL  X402-01  402 Response Status
      Expected status 402, got 404.
      Fix: A 404 usually means the wrong path or method. Check the URL, and pass the method the endpoint uses (--method POST, MCP `method`).
      Docs: https://usewasit.dev/docs/checks/x402

SKIP  X402-02  Payment Header Present
      Skipped: the target answered 404 rather than 402, so it issued no payment challenge to inspect.
...
0 passed, 1 failed, 4 skipped.
```

---

## Design Notes

Four decisions shape everything else. Each has its own page.

**[The error model](docs/design/error-model.md)** — "your service is broken" and
"we never reached your service" are different claims, and a tool that conflates
them is worse than no tool. Wasit reports FAIL, ERROR, and SKIP separately, and
exits `0`/`1`/`2` accordingly. One broken challenge produces one finding, not
one per check that depended on it.

**[Destructive and costly checks](docs/design/destructive-checks.md)** — closing
a payment channel is permanent. Over MCP, the tool that can do it is not
registered at all unless a human starts the server with an explicit opt-in: an
agent cannot call what it cannot see. Checks that spend money without being
destructive are a separate category, disclosed rather than gated.

**[Scope boundary](docs/design/scope-boundary.md)** — Wasit tests running service
behaviour. It does not audit contract source or bytecode, and passing it is not a
security clearance. Knowing what a passing result does _not_ mean is part of the
deliverable.

**Verify against compiled source, never against types.** Every API used here was
confirmed by reading the shipped `.js` in `node_modules` before any code was
written against it. Twice during development a documented behaviour turned out
to contradict the implementation, and both times the implementation was what
users actually experience. The revision notes in
[docs/CHECKS.md](docs/CHECKS.md) record where this changed a pass criterion.

---

## Roadmap

- x402 payments on BNB Smart Chain testnet (its read checks already apply)
- Expand the catalogue as the x402 and MPP specs stabilise
- Evidence documents under `docs/evidence/` for each verified run

Not planned: mainnet support, contract auditing, a hosted service.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).
