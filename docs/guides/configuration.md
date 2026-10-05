# Configuration

Copy `.env.example` to `.env` and fill in what the checks you intend to run
require. Nothing is needed for a read-only x402 run.

**Testnet only.** Several checks settle real transactions. Do not put pubnet
keys in this file.

## What each check needs

| Checks | Required |
|---|---|
| `X402-01`–`05` | nothing |
| `X402-06`–`10` on Stellar | `STELLAR_PRIVATE_KEY` |
| `X402-06`–`10` on Base Sepolia (`--network eip155:84532`) | `EVM_PRIVATE_KEY` |
| `X402-06`–`10` on Solana devnet (`--network solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`) | `SVM_PRIVATE_KEY` |
| `MPP-01` | `MPP_PAYER_SECRET`, `MPP_STELLAR_NETWORK` |
| `MPP-10`–`12`, `14` | `COMMITMENT_SECRET_HEX`, `MPP_STELLAR_NETWORK` |
| `MPP-13` | the above, plus `CHANNEL_CONTRACT_DISPOSABLE` and an explicit opt-in |
| `MPP-10` parameters | `--expect-token`, `--expect-from`, `--expect-to`, `--expect-refund-period` |

The fixture servers need their own values — see `.env.example`. Those are only
required to run the bundled fixtures, not to test a third-party service.

## Networks

`MPP_STELLAR_NETWORK` accepts `stellar:testnet` or `stellar:pubnet` and nothing
else; anything else is a configuration error reported once via `PREFLIGHT`.

Only testnet has a default RPC endpoint. Pubnet deliberately has none, so a
pubnet run must pass `--rpc-url` explicitly rather than silently reaching a
third-party node.

The x402 payment checks also pay on Base Sepolia (`eip155:84532`), through
`--network` (MCP: `network`), with the payer key in `EVM_PRIVATE_KEY`. Its
default RPC endpoint is Base's public `https://sepolia.base.org`, overridable
with `--rpc-url`. They pay on Solana devnet too
(`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`), with the payer key in `SVM_PRIVATE_KEY`
and the public `https://api.devnet.solana.com` as the default RPC endpoint. Any other
network gets the read-only checks only.

## Getting testnet keys

```bash
stellar keys generate --network testnet <name>
stellar keys address <name>
stellar keys show <name>
```

Fund an account through friendbot:

```bash
curl "https://friendbot.stellar.org/?addr=<G...>"
```

`COMMITMENT_SECRET_HEX` is a raw ed25519 seed in hex, not a Stellar `S...`
string — it signs channel commitments directly rather than transactions.

For Base Sepolia, `EVM_PRIVATE_KEY` is a raw private key, `0x` followed by 64
hex characters, from any EVM wallet or `viem`'s `generatePrivateKey()`. The
payer needs Base Sepolia USDC, from https://faucet.circle.com, and **no ETH**:
the facilitator pays the gas (the `exact` scheme's EIP-3009 method). A target
that uses Permit2 instead needs no ETH either when it offers the
`eip2612GasSponsoring` extension; without it, the payer must approve Permit2
once on-chain, which needs gas, and a run without that approval reports
`ERROR (setup)`. A wrong or malformed key is reported at `PREFLIGHT` before
anything is sent, without echoing it.

For Solana devnet, `SVM_PRIVATE_KEY` is the base58 encoding of the keypair's 64
bytes (seed, then public key), the form wallets export. The payer needs devnet USDC
of the SDK's default mint, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, from
https://faucet.circle.com (network Solana Devnet), and **no SOL**: the facilitator signs as fee payer and pays the fee. The payee's USDC token
account must exist before the first payment, since the payment's transaction does
not create it. A keypair whose public half does not belong to its seed, or any
malformed key, is reported at `PREFLIGHT` without echoing it.

## The disposable channel

`MPP-13` closes a channel permanently. `CHANNEL_CONTRACT_DISPOSABLE` should name
a channel opened for the purpose of being destroyed, never the one under active
test. After a successful `MPP-13` run that channel is spent and a new one must
be opened before the check can run again.
