# `wasit wallet --network` and Two New `wasit serve` Modes — What They Do, as Run

**Date:** 2026-10-05
**Wasit:** builds of the local `release/0.7.0` branch (`4c3ca55` for `wallet --network`,
and the commit after it for the two modes), not yet published.
**Targets:** none operated by anyone else. `wasit wallet` read balances from each
chain's public RPC; `wasit serve` ran on our machine, and the official x402 SDK client
was pointed at it as the agent.
**Environment:** macOS, Node `v26.8.1`.

**Authorization.** None was needed or sought. No service operated by anyone else was
tested.

## `wasit wallet --network`

Output as printed, with the generated secrets masked here:

```
$ wasit wallet create --role x402 --network eip155:84532
Generated a new Base Sepolia key for x402:

Address: 0x44170cBa1F242367Ce56BC8Df93531c39E40a05c
Secret:  0x<64-hex masked>

Paste into .env:

EVM_PRIVATE_KEY=0x<64-hex masked>

Fund it with USDC at https://faucet.circle.com (network Base Sepolia),
pasting 0x44170cBa1F242367Ce56BC8Df93531c39E40a05c.
It needs no ETH: the facilitator pays the fee.
```

`--network solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` printed the same shape with an
`SVM_PRIVATE_KEY=` line. Against the configured payers:

```
$ wasit wallet status --network eip155:84532
x402  0xC1716C740469a8E3dc68EC420d196164666c0428  (Base Sepolia)
    USDC       19.8

$ wasit wallet status --network solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 --json
[ { "role": "x402", "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    "address": "Dya3U1bbDA7N9SSqptqgCZ4RuEeDQr1RriF9WLiYoQ9m", "usdc": "19.95" } ]
```

Refused, each with exit 2: `--role mpp-charge --network eip155:84532` ("Stellar only:
MPP runs on Stellar"), `--network eip155:8453` ("Expected a testnet"), and `--fund` on
Base Sepolia ("--fund is Stellar only (Friendbot)"). `wasit wallet status --role x402`
without `--network` printed the Stellar balances as before.

## Two `wasit serve` modes about the challenge

The agent was the official x402 SDK client (`@x402/fetch`'s `wrapFetchWithPayment`,
2.28.0, with `@x402/evm` and `@x402/svm` registered), signing with throwaway keys.

| Mode | What the paywall sends | What the SDK client did | `wasit test --read-only` |
|---|---|---|---|
| `v1-challenge`, Base Sepolia | an x402 v1 challenge in the body (`base-sepolia`, `maxAmountRequired`), no `PAYMENT-REQUIRED` header | paid it as v1, in `X-PAYMENT` | `X402-02` FAIL (v1 body challenge), `X402-04` "All required v1 fields present", `X402-05` FAIL (`base-sepolia` is not CAIP-2) |
| `v1-challenge`, Solana devnet | the same, on `solana-devnet` | paid it as v1, in `X-PAYMENT` | as above |
| `malformed-header`, Base Sepolia | a `PAYMENT-REQUIRED` header that is base64 of JSON cut short | threw `Failed to parse payment requirements: Unterminated string in JSON`, and paid nothing | `X402-02` PASS, `X402-03` FAIL, `X402-04`–`05` SKIP |

The server's own lines, quoted:

```
GET /paid: 402 x402 v1 challenge in the body, 10000 base units on base-sepolia, no PAYMENT-REQUIRED header
GET /paid: payment received in X-PAYMENT for ? base units on base-sepolia. Your agent paid the v1 challenge as v1, in X-PAYMENT. Answered 402: wasit serve never settles.
GET /paid: 402 with a PAYMENT-REQUIRED header that does not decode
```

`v1-challenge` refuses Stellar (`x402 v1 names no Stellar testnet network`): the `exact`
scheme on Stellar is defined for v2 only. Both modes answer any payment with 402, since
they are about the challenge, and neither settles anything.

## Limits

- The agent here was the official SDK client only. How other agents behave is what the
  modes are for, and was not run.
- `wasit wallet` cannot fund Base Sepolia or Solana devnet: Circle's faucet takes no
  scripted requests, so `fund --network` prints the faucet step.
- Unreleased: this ran from the branch, not from npm.
