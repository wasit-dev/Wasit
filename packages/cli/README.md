# @wasit-dev/cli

Protocol-compliance testing for **x402** and **MPP** on Stellar, from your terminal.

`wasit` runs the real payment flow against a live service, not a mock of it, and it is not a schema validator: a response can have every field in the right place and still take money without settling it.

For both MPP charge payments and x402 payments it verifies the settlement independently — via Stellar RPC and the token contract's own on-chain transfer event, rather than the response the service returns.

**Testnet by default.** Several checks settle real transactions. The payment checks pay on test networks only: any other network, `stellar:pubnet` included, is refused before a key is read, but for `wasit run --mainnet` (beta, below). Do not use production keys: the mainnet opt-in takes a dedicated account only.

**This README describes 0.8.0-beta.2**, a pre-release on npm under the `beta` tag (`npm install -g @wasit-dev/cli@beta`). `latest` is still 0.7.0. New in 0.8.0-beta.2: `wasit init`, which writes the config from one unpaid request to your route and can set up a testnet payer; MPP charge and channel checks in `wasit run`; the capped mainnet opt-in, `wasit run --mainnet` (beta, x402 only); and "resource consumed", the result for a single-use route. New in 0.8.0-beta.1: `wasit run` for a whole service from a `wasit.config.json`, `wasit ci-report`, the GitHub Action, a seventeenth check (`X402-11`), and a cap on every payment Wasit signs.

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

For a whole service you operate, let Wasit write the config from one unpaid request to a route, then run the free checks:

```bash
wasit init --url http://127.0.0.1:3000/api/weather --operated-by-me   # your service is running; init reads its 402
wasit run --read-only                                                   # what init prints as the next command for x402
```

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

**Every run settles a real payment.** A settlement that never happened cannot be verified on-chain, so this command has no dry run. To see what a payment would be before anything is signed, use `wasit run --dry-run` (below): it prints the plan of an MPP charge endpoint from its unpaid challenge and signs nothing.

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

### `wasit init`: write the config for one route (new in 0.8.0-beta.2)

```bash
wasit init --url http://127.0.0.1:3000/api/weather --operated-by-me
wasit init --url http://127.0.0.1:3000/api/chat --method POST --body-file body.json --operated-by-me --start "npm start"
wasit init --url http://127.0.0.1:3000/mpp/chat --operated-by-me --protocol mpp-charge
wasit init                             # at a terminal: asks for what you leave out
```

Writes a `wasit.config.json` for one paid route of a service you operate. It sends the route one unpaid request (the method and body you give, and the `WASIT_HEADER_*` headers `wasit run` sends), follows at most one redirect inside the route's origin, and pays and signs nothing. The 402 tells x402 from MPP and gives the protocol, the network, the receiving address and asset (pinned), and for an MPP channel its contract. A route that answers 200, 500 or 503, or does not answer, writes nothing; `--no-read` writes the route from the flags alone, as x402.

Nothing is written without `--operated-by-me` (at a terminal, `init` asks): Wasit tests only services their operator runs. At a terminal `init` asks only for what the flags leave out; without one it asks nothing and names the missing flags (exit 2). An existing config is added to, never overwritten (`--force` replaces it), and a route it already has exactly as given is left as it is, so `init` can run again. It writes test networks only, never a header of the route (send a credential in a `WASIT_HEADER_<NAME>` variable) and never a secret. After writing it prints what it read from your service, what you gave, what it filled in by default and what it did not read, then the next command: `wasit run --read-only` for x402, `wasit run --dry-run` for MPP, which has no read-only checks. Exit codes: `0` the config has the route (written now, or already there as given); `2` `init` refused and nothing was written.

**Key setup (Stellar testnet only)**, with `--setup-keys` or a yes at a terminal, after the config is written. First `init` checks that git will not commit `.env`: it must not be tracked and must be ignored, else `.env` is added to `.gitignore` (asked at a terminal) or no key is written. A key that is already set is kept and its account only read. Otherwise `init` makes a testnet key (`STELLAR_PRIVATE_KEY` for x402, `MPP_PAYER_SECRET` for MPP charge), appends it to `.env` without showing the secret, funds it with Friendbot, adds the USDC trustline and swaps 10 test XLM for test USDC on the public test exchange, then prints a status table; what it could not finish is in the table with the command that finishes it. An MPP channel gets no key: `COMMITMENT_SECRET_HEX` must be the key the channel was opened with. A variable set to nothing in your shell hides `.env` from `wasit run`, so `init` says so and writes no key. The key setup never changes the exit code.

### `wasit run`: a whole service from `wasit.config.json` (new in 0.8.0-beta.1)

```bash
wasit run --read-only --start           # the free checks, X402-01 to 05, with the service started from the config
wasit run --dry-run --start             # what the payment checks would sign; no key, nothing sent
wasit run --start                       # the payment tier, on a test network
```

`wasit.config.json` (version 1) holds a service's endpoints, methods, request bodies and environments. The loader is strict: an unknown key is an error, and secrets, the mainnet opt-in and per-payment caps have no place in it. `wasit run` runs every endpoint (`--env`, `--endpoint`) and writes one report (`--json`, `--out`); it can start the service itself (`--start`, `--start-if-local`) and compare with the report of the default branch (`--baseline`).

Without `--read-only` or `--dry-run` the run is the payment tier. It pays on test networks only, when the environment has `operatedByMe: true` and the chain's key variable is set: at most $1.00 a payment and $5.00 a run (`maxRunUsd` can only lower it), only to the `payTo` and asset the config pins. In GitHub Actions it pays only on a push to the default branch, a schedule and `workflow_dispatch`; a pull request runs the read-only checks. In another CI the payment tier is refused with exit 2: use `--read-only` there. On `stellar:pubnet` a paying run needs `--mainnet` (beta, x402 only, real USDC): it runs only when every rule of the mainnet opt-in holds, says `MAINNET RUN` in its first line, writes every signature to a run ledger before the key signs, and refuses a payer that holds less than the run needs to finish its checks (it says how much is missing), and ends by comparing the payer's balances with that ledger (consistent, explained by checks that FAILed, or inconsistent: exit 2); it does not read `.env`, so export `WASIT_MAINNET_PAYER_SECRET` in the shell; `wasit run --help` lists the rules. `wasit run --dry-run` on `stellar:pubnet` reads no key. A run that will pay checks its RPC before it starts the service, so an RPC that `service.start` itself starts is not up yet and the run stops with exit 2: start such an RPC before `wasit run`. `wasit run --help` lists every option.

For an endpoint with a `reject` case in the config, on Stellar, the payment tier also runs `X402-11`: a valid payment is sent with the request the service must refuse, and the chain is read until that payment's authorization has expired, up to six minutes.

**MPP in `wasit run` (new in 0.8.0-beta.2).** MPP endpoints run in the payment tier on `stellar:testnet` only, by the same rules as x402: `MPP-01` (charge) with `MPP_PAYER_SECRET`, planned from its unpaid challenge and held to the same caps, in the same budget as x402, and `MPP-10`, `11`, `12` and `14` (channel) with `COMMITMENT_SECRET_HEX`, with the channel and its expected terms from the config. The channel checks sign commitments off-chain and Wasit sends no transaction for them, so they are not charged to the cap. `MPP-13`, which closes a channel for good, is never run by `wasit run`. The network and the channel come from the config: `MPP_STELLAR_NETWORK` and `CHANNEL_CONTRACT` are not read. An MPP endpoint is sent a plain GET: one with a method, a body or headers is not sent anything. A mainnet run pays its x402 endpoints only.

**Single-use routes (new in 0.8.0-beta.2).** A route that can be bought once answers 409 where a new 402 was expected, after `X402-06`'s payment was served. `X402-07`, `09`, `10` and `11` need a new challenge to pay, so they are skipped as "resource consumed" (nothing is signed for them, and the route is not asked again); `X402-08`, the replay, needs none and still runs. A 409 before any payment of the run skips `X402-06` with that reason.

### `wasit ci-report`: the pull request comment and the job summary (new in 0.8.0-beta.1)

```bash
wasit ci-report --report wasit-report.json --comment comment.md
```

Turns the report of `wasit run --json --out` into the pull request comment and the job summary, compared with the default branch's report (`--baseline`). `--check-run <file>` also writes the title, summary and conclusion of a GitHub check run. The Action also uses `--summary <file>` (the job summary; default `$GITHUB_STEP_SUMMARY`), `--baseline-out <file>` (the next baseline, for a run on the default branch), `--history <file>` (the newest completed run's baseline, for the recent-failures line) and `--baseline-run <id>`; `wasit ci-report --help` lists them. The GitHub Action in the repository's `action/` directory runs `wasit run` and `wasit ci-report` in a workflow and comments on the pull request; pin it by full commit SHA.

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

`create` prints a secret key to stdout — don't run it on a screen you're recording. `wasit init --setup-keys` needs none of this for a Stellar testnet route: it makes the key, writes it to `.env` without showing it and gets test USDC by a swap on the public test exchange (see `wasit init`).

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
| `STELLAR_PRIVATE_KEY` | `test`, `run` (x402 payment checks on Stellar), `init --setup-keys` |
| `EVM_PRIVATE_KEY` | `test --network eip155:84532` or `eip155:11155111` (x402 payment checks on Base or Ethereum Sepolia) |
| `SVM_PRIVATE_KEY` | `test --network solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (x402 payment checks on Solana devnet) |
| `MPP_PAYER_SECRET` | `mpp-charge`, `run` (MPP charge), `init --setup-keys` |
| `MPP_STELLAR_NETWORK` | `mpp-charge`, `mpp-channel` |
| `COMMITMENT_SECRET_HEX` | `mpp-channel`, `run` (MPP channel) |
| `CHANNEL_CONTRACT` | `mpp-channel` (optional assertion) |
| `CHANNEL_CONTRACT_DISPOSABLE` | `mpp-channel --allow-destructive` |
| `WASIT_USDC_DISTRIBUTOR_SECRET` | `wallet fund --asset usdc` (optional) |
| `WASIT_MAINNET_PAYER_SECRET` | `run --mainnet` only (beta): a dedicated account's secret, exported in the shell, never in `.env` |

All keys are **testnet only**, except `WASIT_MAINNET_PAYER_SECRET`, which `wasit run --mainnet` reads from the shell alone (a dedicated account; see `wasit run`). `wasit` also reads a `.env` file in the current working directory — pass `--payer-key` / `--commitment-key` directly to override it for a single run. `wasit run` does not read `.env` in CI, nor with `--mainnet`.

## What's checked

Seventeen checks across x402 and MPP (`X402-11` is new in 0.8.0-beta.1), each traced to a written spec clause — the full catalogue, with pass criteria and spec references, is in [`docs/CHECKS.md`](https://github.com/wasit-dev/wasit/blob/main/docs/CHECKS.md).

## Related

- [Website](https://usewasit.dev)
- [`@wasit-dev/core`](https://www.npmjs.com/package/@wasit-dev/core) — the check suite this CLI runs, if you're building your own tooling on top
- [`@wasit-dev/server`](https://www.npmjs.com/package/@wasit-dev/server) — the same checks as MCP tools, for Claude Code and other agents
- [Full documentation](https://github.com/wasit-dev/wasit) — CLI guide, MCP guide, configuration, design notes

## License

Apache-2.0 — see [LICENSE](https://github.com/wasit-dev/wasit/blob/main/LICENSE).
