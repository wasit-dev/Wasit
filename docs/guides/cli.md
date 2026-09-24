# CLI Guide

The `wasit` binary is a thin adapter over `@wasit-dev/core`. Every check it runs is
the same code the MCP server runs, so the two cannot disagree about the same
target.

Install and run it directly with npx (no local install needed), or install
globally for a shorter `wasit` command:

```bash
npx @wasit-dev/cli <subcommand> [options]
# or: npm install -g @wasit-dev/cli && wasit <subcommand> [options]
```

Every subcommand also has its own `--help`, with worked examples and cost
notes: `wasit <subcommand> --help`.

## Interactive mode

Running `wasit` with no subcommand at all, in a real terminal, opens a small
menu instead of printing help:

```bash
wasit
```

The menu screen shows which environment variables are already set
(`STELLAR_PRIVATE_KEY`, `MPP_PAYER_SECRET`, `COMMITMENT_SECRET_HEX`) before
you pick anything, so a
missing key is visible up front rather than discovered after typing a
target URL. Pick x402 (read-only checks), MPP channel (non-destructive
checks), MPP charge, or browse the check catalogue, then type a target URL.
Each action reuses the same environment-variable defaults as the matching
subcommand below.

This is deliberately narrower than the subcommands themselves: no
`X402-06`/`07` payment checks, no `--allow-destructive`, no header/method/body
overrides, no `--json`. Anything past "run the safe default checks and read
the result" still goes through the direct subcommand — `wasit test
--payer-key ...`, `wasit mpp-channel --allow-destructive ...`, and so on. MPP
charge always settles a real payment (it has no read-only mode), so picking it
asks for an explicit confirmation before anything runs.

Keys: arrows + Enter to move and select, Esc to go back, `q` to quit from any
screen without a text field, Ctrl+C to quit immediately from anywhere,
including mid-keystroke while typing a target URL. Once a run finishes, `s`
saves its results as JSON (the same shape as `--json` below) to
`wasit-<protocol>-<timestamp>.json` in the current directory.

A run in progress shows a live elapsed timer next to the spinner; the
summary line at the end adds the total run time and the average time per
check. A missing key or an invalid target is reported as its own focused
error screen rather than a stack trace, since no check ever ran.

"Manage testnet wallets" on the menu opens the same generate/fund flow as
`wasit wallet` below, but interactively: it shows all three roles' status up
front, and after generating a key it asks whether to save it straight to
`.env` (updating the running process's environment immediately, so the menu
reflects it without restarting `wasit`) or just display it for you to copy.
The `.env` it writes is the one in the directory `wasit` was started from,
written atomically and with owner-only permissions (`0600`).

A generated secret is shown on screen in both cases — skip this screen if
you are recording your terminal.

Piping `wasit` into something else, or running it in CI, does not open the
menu — it falls back to printing help, exactly as before this existed.

## Wallet setup

```bash
wasit wallet status [--role x402|mpp-charge] [--json]
wasit wallet create --role x402|mpp-charge|mpp-channel [--fund]
wasit wallet fund --role x402|mpp-charge [--asset xlm|usdc] [--amount <n>]
```

Testnet-only convenience commands for the payer keys the other subcommands
read from `.env` — none of them take a `--network` flag, since Friendbot, the
printed USDC issuer, and the whole idea of a disposable generated key only
make sense on testnet.

`status` shows each configured role's on-chain balances (or "not yet created"
for a key that has never been funded). `create` generates a new key and
prints the exact `.env` line(s) to paste — it never writes to `.env` itself,
so it can never overwrite something already there. `mpp-channel` generates a
commitment key (a raw hex ed25519 seed that signs off-chain, not a funded
account — see [Configuration](configuration.md#getting-testnet-keys));
`x402` and `mpp-charge` generate a funded-account keypair. `status` and
`fund` reject `--role mpp-channel` outright, since it has no account to
inspect or fund.

A key that is set but malformed — a truncated paste, a `G...` public key, or
a hex commitment seed in a Stellar-secret slot — is reported by name ("`X` is
not a valid Stellar secret key") and exits 2, rather than surfacing as an SDK
error. `status` reports it against that one role and still checks the other.

`fund --asset xlm` calls Stellar's public Friendbot directly and is fully
automatic. `fund --asset usdc` creates a trustline to Circle's official
testnet USDC issuer automatically, but **actually receiving a balance always
needs a human step**: there is no scriptable, unauthenticated USDC faucet for
Stellar. Either visit https://faucet.circle.com once yourself (paste the
public key `wasit wallet fund` prints), or set
`WASIT_USDC_DISTRIBUTOR_SECRET` in `.env` to an account you already funded
that way — every run after that sends automatically from it.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every check that ran conformed |
| `1` | At least one conformance failure |
| `2` | At least one check produced no verdict |

A run with both a failure and an error exits `1`: a real finding outranks a
missing one. Skipped checks never affect the exit code — a skipped check is
neither a pass nor a defect.

An `ERROR` line names why no verdict was reached, in parentheses:

| Kind | Meaning |
|---|---|
| `unreachable` | No HTTP conversation took place at all |
| `configuration` | The run is set up wrongly: bad URL, unknown network, unreadable key |
| `setup` | A precondition the check needed could not be established |
| `harness` | Wasit or one of its dependencies failed |

`setup` appears on `MPP-11`, `MPP-12` and `MPP-14`, which each need one
correctly advancing commitment accepted before they can probe anything. That
submission is retried three times against fresh challenges; if all three are
refused, the check reports `setup` rather than blaming the target, because a
target that refuses valid vouchers and a channel another payer is advancing look
identical from here. Re-run against a channel nothing else is using to tell them
apart. See [../design/error-model.md](../design/error-model.md).

## Check Catalogue

```bash
wasit checks [--protocol x402|mpp-charge|mpp-channel] [--json]
```

Lists every check by ID without needing to open this doc or CHECKS.md: name,
which protocol/subcommand runs it, and whether it is negative (only passes if
the target correctly *rejects* something), destructive, or settles real funds.
This is a quick reference, not a replacement for [CHECKS.md](../CHECKS.md) —
full pass criteria, spec citations, and revision notes only live there.

## x402 (Test)

```bash
wasit test --target <url> [options]
```

| Option | Default | Notes |
|---|---|---|
| `--target <url>` | required | Must include the scheme |
| `--network <id>` | `stellar:testnet` | CAIP-2 |
| `--payer-key <key>` | `STELLAR_PRIVATE_KEY` | Secret key, `S...` |
| `--method <verb>` | `GET` | HTTP method the paid endpoint uses. Endpoints that compute something usually take `POST` |
| `--body <json>` | — | Request body, sent verbatim; implies `Content-Type: application/json` |
| `--header <name:value>` | — | Extra request header the endpoint needs before it will issue a challenge. Repeatable |
| `--read-only` | off | Restricts the run to `X402-01`–`05` |
| `--json` | off | Machine-readable output (see below) instead of formatted text |

Without a payer key the payment checks are skipped automatically, so the default
posture costs nothing. When they do run, **`X402-06` settles a real payment and
`X402-07` attempts one.**

## MPP Charge Mode

```bash
wasit mpp-charge --target <url> [options]
```

| Option | Default | Notes |
|---|---|---|
| `--target <url>` | required | The paid resource |
| `--payer-key <key>` | `MPP_PAYER_SECRET` | Secret key, `S...` |
| `--network <id>` | `MPP_STELLAR_NETWORK` | CAIP-2 |
| `--rpc-url <url>` | testnet default | Required for pubnet |
| `--json` | off | Machine-readable output (see below) instead of formatted text |

**Every run settles a real payment.** There is no read-only mode: charge mode
has no dry run, and a settlement that never happened cannot be verified
on-chain.

## MPP Channel Mode

```bash
wasit mpp-channel --target <url> [options]
```

| Option | Default | Notes |
|---|---|---|
| `--target <url>` | required | The paid resource |
| `--commitment-key <hex>` | `COMMITMENT_SECRET_HEX` | Raw ed25519 seed, hex |
| `--network <id>` | `MPP_STELLAR_NETWORK` | CAIP-2 |
| `--rpc-url <url>` | testnet default | Soroban RPC |
| `--channel <address>` | `CHANNEL_CONTRACT` | An assertion — see below |
| `--expect-token <address>` | — | `MPP-10` |
| `--expect-from <address>` | — | `MPP-10` |
| `--expect-to <address>` | — | `MPP-10` |
| `--expect-refund-period <n>` | — | `MPP-10`, in ledgers |
| `--allow-destructive` | off | Enables `MPP-13` |
| `--destructive-channel <addr>` | `CHANNEL_CONTRACT_DISPOSABLE` | Channel `MPP-13` may close |
| `--json` | off | Machine-readable output (see below) instead of formatted text |

`MPP-10`–`12` and `MPP-14` cost nothing. `MPP-13` closes a channel permanently
and is skipped unless both `--allow-destructive` and a named channel are given.

### `--channel` asserts, it does not select

The channel under test is resolved from the target's own 402 challenge, so every
check in a run reports on the same contract. `--channel` states which address
you *expect* that to be. When the two differ, `MPP-10` fails and inspects
nothing — a run that reported on both would be reporting on two contracts at
once.

### The `--expect-*` flags

`MPP-10` verifies the channel's on-chain parameters against what you say they
should be. Only the channel's operator knows these, so without all four the
check is skipped rather than guessed at.

## Reading output

```
PASS  MPP-11  Cumulative Commitment Ordering
      Both ordering rules enforced: ...

SKIP  MPP-13  Close Settlement  [destructive]
      Skipped (destructive): closing settles the channel on-chain and
      permanently ends it.
```

`PREFLIGHT` appears in place of the checks when the target URL or network
identifier is invalid. Both are wrong for every check in the suite, so they are
reported once rather than repeated identically.

See [../design/error-model.md](../design/error-model.md) for what each status
means.

### `--json`

```bash
wasit test --target https://api.example.com/paid-endpoint --read-only --json
```

```json
{
  "outcome": "conformant",
  "passed": 5,
  "failed": 0,
  "errored": 0,
  "skipped": 0,
  "results": [
    { "id": "X402-01", "name": "402 Response Status", "status": "PASS", "detail": "...", "destructive": false }
  ]
}
```

Any advisory line that would normally print above the results (missing payer
key, `--read-only` set, a payment-cost warning) is written to stderr instead of
stdout when `--json` is set, so stdout stays parseable — safe to pipe into
`jq` or capture directly in a CI step. `outcome` mirrors the exit code
(`conformant` / `non-conformant` / `no-verdict`) but is readable without
looking one up, and is the exact same shape the MCP server returns as
`structuredContent` for the same run — both front ends call the same
`toStructuredRun()` in `@wasit-dev/core`, so they can never disagree about how
one is reported.
