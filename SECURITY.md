# Security Policy

Wasit runs real payment flows against live services and signs with a real key.
That makes it a tool that can spend money, permanently close a payment channel,
and — if pointed at infrastructure you do not own — put load and unwanted
transactions on somebody else's service. This document states how it handles
keys, what it will and will not do on its own, and how to report a problem.

## Testnet only

Wasit is built and tested for testnets: Stellar testnet, and for the x402
payment checks Base Sepolia, Ethereum Sepolia and Solana devnet, whose mainnets
it does not pay on at all. Several checks settle real transactions, and one
permanently closes a payment channel.

Nothing in the tool prevents a `stellar:pubnet` network identifier from
parsing, but pubnet deliberately has no default RPC endpoint, so a pubnet run
has to be configured on purpose rather than reached by accident. **Do not do
this.** No check in the catalogue has been validated against mainnet
conditions, and the destructive check is irreversible wherever it runs.

Nor can a target choose the network. The payment checks sign only for the
network the run names: `X402-06` to `X402-10` pay only an option on
`--network`, and `MPP-01` refuses a challenge for any other network before
anything is signed, both on its unpaid read and on the request it pays. `MPP-01`
pays through the run's RPC endpoint, not the SDK's default for the network, and
pays once per run. Before 0.7.0, `MPP-01` let the SDK sign for whichever
network the challenge named, through the SDK's default endpoint for it, so a
target asking for `stellar:pubnet` could have a mainnet transfer signed by the
payer key if that account holds mainnet funds (read from the SDK's source, not
run). Use a payer key that has never held mainnet funds. The advisory is
[GHSA-wm3g-w88q-73xx](https://github.com/wasit-dev/wasit/security/advisories/GHSA-wm3g-w88q-73xx).

## Authorization

**Only run Wasit against a service you own, or one whose operator has given you
explicit written permission to test.**

This is an operating policy, binding on the maintainer and on every user of the
tool. It is not a feature of the software, and it cannot be: no tool can
determine from a URL alone who owns the service behind it. The software will
not stop you from pointing it somewhere you should not. You are responsible for
where you point it.

The tool does enforce one narrower guard, described under *Destructive checks*
below, but that guard is about preventing an irreversible action taken by
mistake — not about establishing that you were authorised in the first place.

## Checks that spend money

Three checks settle or attempt real payments. Each call spends; repeated calls
spend repeatedly.

| Check | What it does |
|---|---|
| `X402-06` | Settles a valid x402 payment against the target |
| `X402-07` | Attempts a payment with a deliberately corrupted signature |
| `MPP-01` | Settles a full MPP charge-mode payment |

This is inherent to what they verify rather than an implementation choice: a
payment flow that was never exercised cannot be verified on-chain, and charge
mode has no dry run.

The default posture is the cheap one. `X402-06` and `X402-07` are skipped
entirely when no payer key is present, and `--read-only` (CLI) or
`readOnly: true` (MCP) restricts an x402 run to the free checks. `MPP-01` has
no read-only mode and always spends when it runs.

Over MCP these tools declare `idempotentHint: false` and say plainly in their
descriptions that each call spends, because an agent needs to know that before
deciding to retry on timeout or run a suite in a loop. An agent that retries a
spending check will drain the payer account, at which point every MPP check
fails for reasons that look nothing like the cause.

## Destructive checks

`MPP-13` closes a payment channel. The settlement is final, the channel can
never be reopened, and no later check can run against it.

It is skipped by default in both front ends. Running it requires two
independent things:

1. An explicit opt-in on the process — `--allow-destructive` on the CLI, or
   `WASIT_ALLOW_DESTRUCTIVE=1` / `--allow-destructive` when starting the MCP
   server.
2. A named channel the run is permitted to close, which must match the channel
   the target advertises in its own 402 challenge.

Neither alone is enough.

Over MCP the destructive path is a **separate tool**, registered only when the
opt-in is present at process start. Without it, `wasit_mpp_channel_test_with_close`
does not appear in `tools/list` at all. This is deliberate: an
`allowDestructive: true` parameter would be a boolean an agent could set for
itself, which is not human consent in any meaningful sense. An agent cannot
invoke a tool it cannot see.

## Key handling

Wasit signs with keys you supply. It needs them to do its job, and it does the
minimum with them.

- **Keys are read from the process environment only.** Never from a command
  argument, never from a config file committed to a repository.
- **Keys are never accepted as MCP tool arguments.** Every tool reads what it
  needs from the server's own environment, so an agent never handles a key and
  a key can never end up in a conversation transcript. A missing key returns an
  error naming the variable to set, not a prompt to supply one.
- **Keys are never logged, persisted, or transmitted anywhere except to the
  Stellar network as part of a signed transaction.** Check output reports
  public keys and transaction hashes; it does not report secrets.
- **`.env` is gitignored.** `.env.example` documents every variable by name
  with no values.

Use a dedicated testnet account with only as much balance as the run needs. Do
not reuse a key that has any other purpose.

## Reporting and disclosure

Three different things can be wrong, and each is told to somebody different:
a defect in Wasit itself comes to us, a defect Wasit finds in your service
goes to its operator, and a defect in an upstream SDK goes to its
maintainers. The first two are always reported privately. For an upstream
open-source SDK, a defect that is exploitable goes to its maintainers
privately, through their own security policy; a non-exploitable conformance
defect goes to their public issue tracker, where they already triage bugs.
Every upstream report Wasit has filed so far is of the second kind.

### Reporting a vulnerability in Wasit

Report privately first. Do not open a public issue for a security problem.

Email **[contact@usewasit.dev](mailto:contact@usewasit.dev?subject=Wasit%20security%20report)** with:

- What the problem is and what an attacker could do with it
- Steps to reproduce, ideally against the bundled fixture servers
- The versions involved (`@wasit-dev/core`, Node, and the relevant SDK versions)

You should get an acknowledgement within 72 hours. If a fix is warranted, it
will be released before public discussion of the details, and you will be
credited unless you prefer otherwise.

Things that are in scope: key material leaking into output, logs, or MCP tool
arguments; a destructive check running without both required opt-ins; a check
that reports PASS without actually verifying what its pass criteria in
[CHECKS.md](docs/CHECKS.md) claim.

Things that are not: the fact that some checks spend money, or that the tool
will run against a target you were not authorised to test. Both are documented
above and are properties of the tool working as designed.

### Findings about services Wasit tests

When Wasit finds a conformance defect in somebody else's service:

- The operator is told privately first, with enough detail to reproduce it.
- A reasonable window is given to respond before anything is published.
- Aggregate results may be published — how many services were tested and what
  classes of defect appeared — but **no individual service is named without its
  operator's written permission.**
- A defect that is exploitable, rather than merely non-conformant, is treated
  as a vulnerability disclosure rather than a test result, and is not published
  on a timetable of ours.

A FAIL from Wasit is a statement about a specific check against a specific
target at a specific moment. It is not a security assessment. See
[design/scope-boundary.md](docs/design/scope-boundary.md) for what a passing result
does and does not mean.

### Findings in upstream SDKs

Defects found in the official SDKs during development are documented in
[findings/upstream-sdk.md](docs/findings/upstream-sdk.md) and reported to their
maintainers — three so far, filed as
[stellar-mpp-sdk#66](https://github.com/stellar/stellar-mpp-sdk/issues/66),
[#67](https://github.com/stellar/stellar-mpp-sdk/issues/67) and
[#70](https://github.com/stellar/stellar-mpp-sdk/issues/70). Those are protocol,
packaging and developer-experience defects rather than exploitable
vulnerabilities; anything exploitable would go to the maintainers privately and
would not appear in that file until it was resolved.

## Known advisories in a clean install

`npm audit` on a fresh install of all three packages (0.7.0, measured
2026-10-08) reports nine packages: eight high, one moderate. Installing
`@wasit-dev/cli` alone reports eight (seven high, one moderate), since it pulls
a smaller slice of the same graph. None originate in Wasit's own code. They
arrive by two routes:

- `@stellar/mpp@0.7.1` brings older copies of two packages alongside the ones
  Wasit declares. `@stellar/stellar-sdk@15.1.0`, because `@stellar/mpp` peers on
  `^15.1.0`, brings `axios@1.15.0` and `toml@3.0.0` (high). `mppx@0.6.31`,
  because `@stellar/mpp` peers on `^0.6.29`, is matched by the "gas draining"
  advisories (moderate), which affect `mppx` before 0.8.2; the `mppx` Wasit
  declares resolves 0.8.19.
- `@stellar/stellar-sdk@16.3.1`, the version Wasit and `@x402/stellar@2.28.0`
  both resolve, pins `axios@1.18.0`, which axios advisories published since
  0.6.0 now match (fixed in axios 1.20.0). No 16.x release of the SDK moves past
  axios 1.18.0. 17.2.1 pins axios 1.20.0, but `@x402/stellar` 2.28.0, its latest,
  requires `^16.3.0`, so moving Wasit to 17 would install two copies of the SDK.

`@stellar/mpp`, `@x402/stellar` and the three `@wasit-dev/*` packages appear in
that count only because npm marks a package that depends on an affected one.
There is no advisory against Wasit 0.7.0's own code; versions up to 0.6.0 have
the `MPP-01` network issue described under [Testnet only](#testnet-only),
[GHSA-wm3g-w88q-73xx](https://github.com/wasit-dev/wasit/security/advisories/GHSA-wm3g-w88q-73xx).

There is no downstream fix. The levers are `@stellar/mpp`'s two peer ranges,
reported upstream as
[stellar-mpp-sdk#70](https://github.com/stellar/stellar-mpp-sdk/issues/70) and
written up in [findings/upstream-sdk.md](docs/findings/upstream-sdk.md), whose
fix has merged upstream while `@stellar/mpp@0.7.1` is still the latest on npm;
and a release of the Stellar SDK's 16 line on a fixed axios, or `@x402/stellar`
accepting 17 (all checked 2026-10-08).
`npm run verify:clean-install` installs all three packages and prints the
audit on every CI run, so the count is measured rather than remembered.

This is stated here rather than left to be discovered: a tool that checks other
people's compliance should be legible about its own supply chain.

## Supported versions

Wasit is pre-1.0 and published on npm as `@wasit-dev/core`, `@wasit-dev/cli`
and `@wasit-dev/server`. Only the latest published version and `main` are
supported. There are no backports, and check behaviour may change as the x402
and MPP specifications stabilise — which is why every check in
[CHECKS.md](docs/CHECKS.md) records the specification and SDK version it was
verified against, and why every report should record the same.