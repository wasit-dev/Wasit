# @wasit-dev/cli

Protocol-compliance testing for **x402** and **MPP** on Stellar, from your terminal.

`wasit` runs the real payment flow against a live service, not a mock of it, and it is not a schema validator: a response can have every field in the right place and still take money without settling it.

For both MPP charge payments and x402 payments it verifies the settlement independently — via Stellar RPC and the token contract's own on-chain transfer event, rather than the response the service returns.

**Testnet only.** Several checks settle real transactions. The payment checks pay on test networks only: any other network, `stellar:pubnet` included, is refused before a key is read. Do not use production keys.

**This README describes 0.8.0-beta.1**, a pre-release on npm under the `beta` tag (`npm install -g @wasit-dev/cli@beta`). `latest` is still 0.7.0. New in the beta: `wasit run` for a whole service from a `wasit.config.json`, `wasit ci-report`, the GitHub Action, a seventeenth check (`X402-11`), and a cap on every payment Wasit signs.

## Install

```bash
# run once, no install
npx @wasit-dev/cli test --target <your-service-url> --read-only

# or install globally
npm install -g @wasit-dev/cli
wasit test --target <your-service-url> --read-only
```

Requires Node.js `>=22`.

Both lines carry `--read-only` deliberately: without it the payment checks
`X402-06`–`10` run as soon as a `STELLAR_PRIVATE_KEY` is available, and the CLI
reads `.env` from the directory you run it in — so on a machine already set up
for a later suite, the first command in this README would settle a real testnet
payment.

## Quick start

The default posture costs nothing — no keys required:

```bash
wasit test --target https://your-service.example.com/paid --read-only
```

That runs the read-only x402 checks (`X402-01`–`05`): whether the service issues a well-formed 402 challenge. Drop `--read-only` and set `STELLAR_PRIVATE_KEY` to also exercise the payment flow — `X402-06` settles a real testnet payment, and `X402-07`–`10` send payments the service must refuse.

## Commands

### `wasit test` — x402

```bash
wasit test --target <url> [options]
```

| Option | Default | Notes |
|---|---|---|
| `--target <url>` | required | Must include the scheme |
| `--network <id>` | `stellar:testnet` | Network the payment checks pay on: `stellar:testnet`, `eip155:84532` (Base Sepolia), `eip155:11155111` (Ethereum Sepolia) or `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (Solana devnet). Any other network is refused before a key is read. `X402-01`–`05` apply on any chain |
| `--payer-key <key>` | `STELLAR_PRIVATE_KEY`, `EVM_PRIVATE_KEY` on Base or Ethereum Sepolia, or `SVM_PRIVATE_KEY` on Solana devnet | A Stellar secret (`S...`), an EVM private key (`0x` + 64 hex), or a Solana keypair (base58 of its 64 bytes) |
| `--rpc-url <url>` | testnet default | Soroban RPC used to verify `X402-06`'s settlement |
| `--method <verb>` | `GET` | HTTP method the paid endpoint uses |
| `--body <json>` | — | Request body; implies `Content-Type: application/json` |
| `--header <name:value>` | — | Extra request header, repeatable |
| `--read-only` | off | Restricts the run to `X402-01`–`05` (no payment) |

Without a payer key, the payment checks are skipped automatically. When they run: **`X402-06` settles a real payment, `X402-07` attempts one with a corrupted signature**, so testnet funds move on every call. A price above $1.00 is not paid: `X402-06` gets no verdict (`ERROR (setup)`) and nothing is signed. `X402-11` needs a request the service must refuse, which only `wasit run` reads from the config, so `wasit test` skips it.

### `wasit mpp-charge` — MPP, charge mode

```bash
wasit mpp-charge --target <url> [options]
```

| Option | Default | Notes |
|---|---|---|
| `--target <url>` | required | The paid resource |
| `--payer-key <key>` | `MPP_PAYER_SECRET` | Secret key, `S...` |
| `--network <id>` | `MPP_STELLAR_NETWORK` | CAIP-2. Only a challenge on this network is paid; `stellar:testnet` only, any other network is refused |
| `--rpc-url <url>` | testnet default | Used for the payment and the settlement read; https only |

**Every run settles a real payment.** Charge mode has no dry run — a settlement that never happened cannot be verified on-chain.

### `wasit mpp-channel` — MPP, channel mode

```bash
wasit mpp-channel --target <url> [options]
```

| Option | Default | Notes |
|---|---|---|
| `--target <url>` | required | The paid resource |
| `--commitment-key <hex>` | `COMMITMENT_SECRET_HEX` | Raw ed25519 seed, hex — not an `S...` key |
| `--network <id>` | `MPP_STELLAR_NETWORK` | CAIP-2 |
| `--rpc-url <url>` | testnet default | Soroban RPC |
| `--channel <address>` | `CHANNEL_CONTRACT` | Asserts the expected channel; a mismatch fails `MPP-10` |
| `--expect-token <address>` | — | `MPP-10` parameter check |
| `--expect-from <address>` | — | `MPP-10` parameter check |
| `--expect-to <address>` | — | `MPP-10` parameter check |
| `--expect-refund-period <ledgers>` | — | `MPP-10` parameter check |
| `--allow-destructive` | off | Enables `MPP-13` (closes the channel — permanent) |
| `--destructive-channel <address>` | `CHANNEL_CONTRACT_DISPOSABLE` | Channel `MPP-13` is permitted to close |

`MPP-10`–`12` and `MPP-14` cost nothing. `MPP-13` is skipped unless `--allow-destructive` and a named disposable channel are both given — it permanently ends a channel and cannot be undone.

`--channel` **asserts**, it does not select: the channel under test is resolved from the target's own 402 challenge, so every check in a run reports on the same contract. When `--channel` differs from what the target advertises, `MPP-10` fails and inspects nothing.

### `wasit run`: a whole service from `wasit.config.json` (new in 0.8.0-beta.1)

```bash
wasit run --read-only --start           # the free checks, X402-01 to 05, with the service started from the config
wasit run --dry-run --start             # what the payment checks would sign; no key, nothing sent
wasit run --start                       # the payment tier, on a test network
```

`wasit.config.json` (version 1) holds a service's endpoints, methods, request bodies and environments. The loader is strict: an unknown key is an error, and secrets, the mainnet opt-in and per-payment caps have no place in it. `wasit run` runs every endpoint (`--env`, `--endpoint`) and writes one report (`--json`, `--out`); it can start the service itself (`--start`, `--start-if-local`) and compare with the report of the default branch (`--baseline`).

Without `--read-only` or `--dry-run` the run is the payment tier. It pays on test networks only, when the environment has `operatedByMe: true` and the chain's key variable is set: at most $1.00 a payment and $5.00 a run (`maxRunUsd` can only lower it), only to the `payTo` and asset the config pins. In GitHub Actions it pays only on a push to the default branch, a schedule and `workflow_dispatch`; a pull request runs the read-only checks. In another CI the payment tier is refused with exit 2: use `--read-only` there. On `stellar:pubnet` a paying run needs `--mainnet` (beta, x402 only, real USDC): it runs only when every rule of the mainnet opt-in holds, says `MAINNET RUN` in its first line, writes every signature to a run ledger before the key signs, and ends by comparing the payer's balances with that ledger; `wasit run --help` lists the rules. `wasit run --dry-run` on `stellar:pubnet` reads no key. A run that will pay checks its RPC before it starts the service, so an RPC that `service.start` itself starts is not up yet and the run stops with exit 2: start such an RPC before `wasit run`. `wasit run --help` lists every option.

For an endpoint with a `reject` case in the config, on Stellar, the payment tier also runs `X402-11`: a valid payment is sent with the request the service must refuse, and the chain is read until that payment's authorization has expired, up to six minutes.

### `wasit ci-report`: the pull request comment and the job summary (new in 0.8.0-beta.1)

```bash
wasit ci-report --report wasit-report.json --comment comment.md
```

Turns the report of `wasit run --json --out` into the pull request comment and the job summary, compared with the default branch's report (`--baseline`). `--check-run <file>` also writes the title, summary and conclusion of a GitHub check run. The GitHub Action in the repository's `action/` directory runs `wasit run` and `wasit ci-report` in a workflow and comments on the pull request; pin it by full commit SHA.

### `wasit checks` — the catalogue

```bash
wasit checks [--protocol x402|mpp-charge|mpp-channel] [--json]
```

Lists every check by ID with the subcommand that runs it, and flags the ones that are negative, destructive, or spend funds. No network, no keys.

### `wasit wallet` — testnet keys

```bash
wasit wallet status [--role x402|mpp-charge] [--network <testnet>] [--json]
wasit wallet create --role x402|mpp-charge|mpp-channel [--network <testnet>] [--fund]
wasit wallet fund   --role x402|mpp-charge [--network <testnet>] [--asset xlm|usdc] [--amount <n>]
```

Testnet-only helpers for the keys the subcommands above read from `.env`. `--network` takes testnets only: `stellar:testnet` (default), `eip155:84532`, `eip155:11155111` or `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, where `create --role x402` prints an `EVM_PRIVATE_KEY` or `SVM_PRIVATE_KEY` line and the address to fund at [faucet.circle.com](https://faucet.circle.com); that payer needs USDC and no ETH or SOL. `create` prints the exact `.env` lines to paste and never writes the file itself; `fund --asset xlm` uses Stellar's public Friendbot and is fully automatic.

`fund --asset usdc` opens the Circle testnet USDC trustline automatically, but **receiving a balance always needs one human step**: there is no scriptable USDC faucet for Stellar. Visit [faucet.circle.com](https://faucet.circle.com) once, or set `WASIT_USDC_DISTRIBUTOR_SECRET` to an account you funded that way and every later run sends from it automatically.

`create` prints a secret key to stdout — don't run it on a screen you're recording.

### `wasit serve` — a paywall that misbehaves, for testing an agent that pays

```bash
wasit serve --mode no-settle            # also: wrong-settlement, wrong-network, overprice,
                                        #       v1-challenge, malformed-header
```

Runs a local x402 paywall that lies in one chosen way: serves without settling,
cites someone else's settlement, asks for mainnet, asks for one million USDC, issues
only an x402 v1 challenge, or sends a challenge header that does not decode.
Point your agent at `http://127.0.0.1:4020/` and the server reports what the
agent did. Nothing is settled or forwarded, so no funds move; the agent still
needs a funded testnet wallet, and `--pay-to` (default `STELLAR_PAYEE_ADDRESS`)
must be a testnet account with a USDC trustline. See `wasit serve --help`.

### The interactive dashboard

Running `wasit` with no arguments in a terminal opens a menu: the same three check runners, a catalogue browser, and a wallet screen, driven by arrow keys. A run shows a live elapsed timer and per-check progress, and `s` saves the finished run to `wasit-<protocol>-<timestamp>.json` — the same shape `--json` prints. Piped or in CI it prints help instead, so nothing that scripts Wasit today changes behaviour. See [`docs/guides/cli.md`](https://github.com/wasit-dev/wasit/blob/main/docs/guides/cli.md).

## Reading output

```
PASS  X402-01  402 Response Status
      Server responded with 402 as required.

FAIL  X402-01  402 Response Status
      Expected status 402, got 404.

SKIP  X402-02  Payment Header Present
      Skipped: the target answered 404 rather than 402, so it issued no
      payment challenge to inspect.

7 passed.
```

At a terminal, `wasit test` shows the checks live and in colour, in two blocks (challenge and payment). A pipe, CI, `--json` and `NO_COLOR` get the plain text above.

`PREFLIGHT` appears in place of the checks when the target URL or network identifier itself is invalid — both are wrong for every check in the suite, so it's reported once rather than repeated identically.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every check that ran conformed |
| `1` | At least one conformance failure |
| `2` | At least one check produced no verdict (unreachable target, bad config) |

A run with both a failure and an error exits `1` — a real finding outranks a missing one. Skipped checks never affect the exit code.

## Configuration

| Env var | Used by |
|---|---|
| `STELLAR_PRIVATE_KEY` | `test` (x402 payment checks on Stellar) |
| `EVM_PRIVATE_KEY` | `test --network eip155:84532` or `eip155:11155111` (x402 payment checks on Base or Ethereum Sepolia) |
| `SVM_PRIVATE_KEY` | `test --network solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (x402 payment checks on Solana devnet) |
| `MPP_PAYER_SECRET` | `mpp-charge` |
| `MPP_STELLAR_NETWORK` | `mpp-charge`, `mpp-channel` |
| `COMMITMENT_SECRET_HEX` | `mpp-channel` |
| `CHANNEL_CONTRACT` | `mpp-channel` (optional assertion) |
| `CHANNEL_CONTRACT_DISPOSABLE` | `mpp-channel --allow-destructive` |
| `WASIT_USDC_DISTRIBUTOR_SECRET` | `wallet fund --asset usdc` (optional) |

All keys are **testnet only**. `wasit` also reads a `.env` file in the current working directory — pass `--payer-key` / `--commitment-key` directly to override it for a single run.

## What's checked

Seventeen checks across x402 and MPP (`X402-11` is new in 0.8.0-beta.1), each traced to a written spec clause — the full catalogue, with pass criteria and spec references, is in [`docs/CHECKS.md`](https://github.com/wasit-dev/wasit/blob/main/docs/CHECKS.md).

## Related

- [Website](https://usewasit.dev)
- [`@wasit-dev/core`](https://www.npmjs.com/package/@wasit-dev/core) — the check suite this CLI runs, if you're building your own tooling on top
- [`@wasit-dev/server`](https://www.npmjs.com/package/@wasit-dev/server) — the same checks as MCP tools, for Claude Code and other agents
- [Full documentation](https://github.com/wasit-dev/wasit) — CLI guide, MCP guide, configuration, design notes

## License

Apache-2.0 — see [LICENSE](https://github.com/wasit-dev/wasit/blob/main/LICENSE).
