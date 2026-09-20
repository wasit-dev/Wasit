---
name: wasit
description: Protocol-compliance testing for x402 and MPP (Machine Payments Protocol) on Stellar. Use when building or debugging an x402/MPP service or client on Stellar and you need to know whether it actually conforms to the spec, not just whether it returns 2xx. Runs the real payment flow against a live target and verifies settlement independently on Stellar RPC, from the token contract's own transfer event rather than the service's own response.
---

# Wasit

Wasit is a CLI and MCP server that tests whether an x402 or MPP implementation
on Stellar conforms to the official spec. It is not a schema validator: a
response can have every field in the right place and still take money without
settling it. Wasit sends real requests to a live target, then checks Stellar
RPC directly to see whether the settlement it claims actually happened.

x402 and MPP have official SDKs. Neither has an independent conformance
tester, so "we support x402" is currently an unverifiable claim. Wasit filled
that gap the way `stellar-anchor-tests` fills it for SEP-24/31 anchors, and in
doing so has already surfaced three reproducible defects in the official SDKs
(`stellar-mpp-sdk#66`, `#67`, `#70`), not hypothetical bugs.

Testnet only. Mainnet is explicitly out of scope. Not a security audit: no
source or bytecode is read. Complementary to Scout, the Certora Sunbeam
Prover, Komet, and OpenZeppelin's Soroban detectors, not a replacement for any
of them.

## Quick decision

- Testing your own x402 or MPP service before you ship it, with no keys and no
  cost: `npx @wasit-dev/cli test --target <url> --read-only`.
- Wiring an agent (Claude Code, Claude Desktop, any MCP client) to run checks
  programmatically: read the MCP section below, or the full guide.
- Need to know exactly what a check ID asserts before trusting or disputing a
  result: read `docs/CHECKS.md` in the repository, or the `wasit://checks` MCP
  resource.

## Read the file that matches the task

| Task | File |
|---|---|
| Run checks from a terminal, interactively or scripted | [`docs/guides/cli.md`](https://github.com/wasit-dev/wasit/blob/main/docs/guides/cli.md) |
| Wire an MCP client (Claude Code, Claude Desktop, other) | [`docs/guides/mcp.md`](https://github.com/wasit-dev/wasit/blob/main/docs/guides/mcp.md) |
| Look up what a specific check ID (`X402-0x`, `MPP-0x`) asserts | [`docs/CHECKS.md`](https://github.com/wasit-dev/wasit/blob/main/docs/CHECKS.md) |
| Set up testnet keys and environment variables | [`docs/guides/configuration.md`](https://github.com/wasit-dev/wasit/blob/main/docs/guides/configuration.md) |
| Understand what a passing result does and does not mean | [`docs/design/scope-boundary.md`](https://github.com/wasit-dev/wasit/blob/main/docs/design/scope-boundary.md) |
| Understand how FAIL, ERROR and SKIP differ | [`docs/design/error-model.md`](https://github.com/wasit-dev/wasit/blob/main/docs/design/error-model.md) |

## Essentials

Zero-cost check against your own service, no keys required:

```bash
npx @wasit-dev/cli test --target https://your-service.example/paid --read-only
```

That runs `X402-01` through `X402-05`. Add a payer key
(`--payer-key`/`STELLAR_PRIVATE_KEY`) to also run `X402-06`/`07`, which settle
a real testnet payment. `wasit mpp-charge` and `wasit mpp-channel` cover MPP;
channel mode is free except for the destructive close check, which is opt-in
only (`--allow-destructive`) and never runs by accident.

MCP server, for an agent to call checks directly instead of shelling out:

```bash
claude mcp add --transport stdio wasit \
  --env MPP_STELLAR_NETWORK=stellar:testnet \
  --env STELLAR_PRIVATE_KEY=S... \
  --env MPP_PAYER_SECRET=S... \
  --env COMMITMENT_SECRET_HEX=... \
  -- npx -y @wasit-dev/server
```

| Tool | Checks | Cost |
|---|---|---|
| `wasit_x402_test` | `X402-01`-`07` | `06`/`07` settle real testnet payments |
| `wasit_mpp_charge_test` | `MPP-01` | Settles a real testnet payment every call |
| `wasit_mpp_channel_test` | `MPP-10`-`12`, `14` | Free |
| `wasit_mpp_channel_test_with_close` | + `MPP-13` | Destroys a channel; only registered with an explicit opt-in |

Every tool returns both prose and a `structuredContent` object with `outcome`
(`conformant` / `non-conformant` / `no-verdict`), pass/fail/error/skip counts,
and a per-check result array. `outcome` is the field to read, not an exit
code: an integer means nothing to an agent on its own, and `no-verdict` is
never a pass.

A per-check `status` of `ERROR` carries an `errorKind` of `unreachable`,
`configuration`, `setup` or `harness`, and means no verdict was reached about
the target. Report it as such, never as a defect. `setup` in particular means a
precondition the check needed could not be established: for the channel checks,
that one correctly advancing commitment was refused three times running, which a
channel another payer is using produces just as readily as a non-conformant
target. The right follow-up is a re-run against a channel nothing else is paying
through, not a bug report against the service.

## Related

- `stellar/agentic-payments` (the official Stellar skill covering x402 and MPP
  protocol background, testnet setup, and the two USDC address formats)
  explains the protocols Wasit tests against.
- `stellar-anchor-tests` is the equivalent conformance tester for SEP-24/31
  anchors; Wasit follows the same model for the agentic-payments stack.

## Links

Repository: https://github.com/wasit-dev/wasit
Site: https://usewasit.dev
Packages: `@wasit-dev/core`, `@wasit-dev/cli`, `@wasit-dev/server` on npm
