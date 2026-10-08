# x402 Payment Checks on Solana Devnet — A/B Against Lying Servers, and a Real Settlement

**Date:** 2026-10-05
**Wasit:** builds of the local `release/0.7.0` branch (`165e23c` for the Solana adapter
and fixture, `7ea229f` for `wasit serve` on Solana devnet), not yet published.
**Targets:** `wasit serve --network solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, the
paywall that misbehaves on purpose, in three modes; and Wasit's own Solana devnet x402
fixture (`packages/core/test/fixtures/x402-svm-server.ts`), settling through the public
`x402.org` facilitator. Both ran on our machine; the chain is Solana devnet.
**Environment:** macOS, Node `v26.8.1`.

**What this is for.** `X402-06` to `X402-10` now also pay on Solana devnet, with the
`exact` scheme: the payer signs a transaction carrying one `TransferChecked` to the
payee's token account, and the sponsor named in `extra.feePayer`, here the facilitator,
signs as fee payer and submits it (`scheme_exact_svm.md`). As on Stellar and Base
Sepolia, the checks are only worth having if they fail servers that get this wrong and
pass one that gets it right.

**Authorization.** None was needed or sought. Every target was Wasit's own code on our
machine. No service operated by anyone else was tested.

## Servers that lie

Payer and payee: throwaway keypairs generated for the run, holding nothing. That is
enough here: signing needs no balance, and `wasit serve` never settles, so nothing moved.

| `wasit serve` mode | What it does | `X402-06` | `X402-07`–`10` |
|---|---|---|---|
| `no-settle` | Serves any payment with 200, without settling and without `PAYMENT-RESPONSE` | **FAIL** | **FAIL** |
| `wrong-settlement` | Serves with a `PAYMENT-RESPONSE` naming a random signature that exists nowhere | **FAIL** | **FAIL** |
| `wrong-network` | Asks to be paid on Solana mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`) | SKIP, nothing sent | SKIP |

Output, quoted as printed:

```
FAIL  X402-06  Signature Resubmit Accepted
      Valid payment accepted (HTTP 200), but the response carried no
      PAYMENT-RESPONSE header, which the x402 v2 HTTP transport uses to report
      settlement. Whether the payment settled cannot be verified.
```

```
FAIL  X402-06  Signature Resubmit Accepted
      Target reported settlement as tx 5BjTpgSQ…bLVRq, but the chain advanced 152
      more slots without it. Either it was never broadcast, or the target
      referenced a transaction that does not exist.
```

The second was decided against Solana devnet itself, through its public RPC
(`https://api.devnet.solana.com`): the whole run took 38 seconds, most of it waiting for
150 slots to pass without the cited signature.

## An honest server

Payer: a devnet account holding 20 USDC of the SDK's default devnet mint
(`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`), from Circle's faucet
(https://faucet.circle.com, Solana Devnet), and **no SOL**. Payee: a second account
whose USDC token account already existed (the payment's transaction does not create
one).

`wasit test --target http://localhost:3007/protected --network
solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`: **10/10**, in 4 seconds.

```
PASS  X402-06  Signature Resubmit Accepted
      Valid payment accepted (HTTP 200) and settled on-chain for exactly the
      advertised 10000 base units of 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
      to HzrAfDD9vQ7jjywai5dgiZbEzFumwNhWw3LLbXViHdBS, verified from the
      transaction's token balances (tx 3QJCb8Z8…M7B1w).
PASS  X402-07  Invalid Signature Rejected
      Payment with a corrupted authorization signature correctly rejected
      (HTTP 402: invalid_exact_svm_payload_signature_invalid).
PASS  X402-08  Payment Replay Rejected
      The same payment, sent again, was refused
      (HTTP 402: invalid_exact_svm_transaction_simulation_failed).
PASS  X402-09  Underpayment Rejected
      A validly signed payment for 5000 of the advertised 10000 base units was
      refused (HTTP 402: invalid_exact_svm_payload_amount_mismatch).
PASS  X402-10  Expired Authorization Rejected
      A payment whose authorization had expired was refused
      (HTTP 402: invalid_exact_svm_transaction_simulation_failed).
```

[`3QJCb8Z8…M7B1w`](https://explorer.solana.com/tx/3QJCb8Z88QFRByCjCqb7JXvyTFZEGsSDBYqsrBmaqtZg1N3semLEm6R6McCwSNaNph33UUDttFvs3H8Ye5fM7B1w?cluster=devnet)

Read back independently afterwards, outside Wasit, with raw JSON-RPC against the same
endpoint:

| | |
|---|---|
| Status | succeeded (`err` null), slot 507717163 |
| Fee payer (account 0) | `CKPKJWNd…WYp5`, the facilitator's account, which paid the 10001-lamport fee |
| Signers | the facilitator and the payer `Dya3U1bb…oQ9m`, nobody else |
| Instructions | two ComputeBudget, one `spl-token` `transferChecked` of 10000 (6 decimals) from the payer's token account to the payee's, authority the payer; one memo carrying a random nonce; no inner instructions |
| Token balances | payer 20000000 → 19990000, payee 20000000 → 20010000 |
| Payer afterwards | 19.99 USDC, **still 0 SOL** |

The payer's history holds two transactions: the deposit that funded it, and this
settlement. So the settlement Wasit verified is the one that happened, the four
payments the target had to refuse moved nothing, and a Solana devnet payer needs the
token and nothing else.

A second run on the same build, after the dependency checks below, passed 10/10 again
([`3FomjFsz…WG8B`](https://explorer.solana.com/tx/3FomjFszTTivLg876SJopURcZTGJPaSnAsdKu2sJVULe53Qt4K6J9vYc3S29fyXmcMDSmDMBe8E9MC9Tka6XWG8B?cluster=devnet)).

## How each payment was built

- **Corrupted signature (`X402-07`):** before the sponsor signs, the transaction carries
  one signature, the payer's; its first byte is flipped, and the message, transfer and
  blockhash are untouched.
- **Replay (`X402-08`):** the headers `X402-06`'s accepted payment was sent with, byte for
  byte. Solana executes a transaction once, so this costs nothing.
- **Underpayment (`X402-09`):** signed by the official SDK client for half the advertised
  amount, then sent with `accepted` set back to the advertised terms.
- **Expired (`X402-10`):** on Solana a payment's lifetime is its recent blockhash, which
  the SDK client does not derive from `maxTimeoutSeconds`. The payment is built on a
  blockhash from 300 slots back, through the client's `extra.recentBlockhash` hint, after
  the RPC confirms that blockhash is no longer valid. So it had expired before it was
  sent, without holding a fresh payment for the minute or more it takes to expire.

## What did not change

On the same build, Wasit's other x402 fixtures each passed 10/10: Stellar testnet
(port 3001), Base Sepolia with EIP-3009 (3005) and with Permit2 (3006). `X402-10`'s
expiry moved into each chain's adapter in this change, and was refused there for the
same reasons as before (`invalid_exact_stellar_payload_simulation_failed`,
`invalid_exact_evm_payload_authorization_valid_before`, `permit2_deadline_expired`). 221
core and 63 CLI offline tests pass.

## Installing alongside TypeScript

`@x402/svm` 2.28 requires `@solana/kit` 5, whose packages declare an optional peer
`typescript ^5`. The packed `@wasit-dev/core` was installed into fresh projects with
TypeScript 5.8.3, 6.0.3, 7.0.2 and none: every install succeeded. Under TypeScript 7, npm
printed 110 `ERESOLVE overriding peer dependency` warnings, and core then ran in that
project: Solana's settlement check verified `3QJCb8Z8…M7B1w` against devnet and the read
checks passed against the fixture. The CLI and MCP server installed globally or through
npx carry no TypeScript, so the warnings do not arise there.

## Limits

- One Solana network: devnet. The payee's token account must exist before the payment.
- The honest target is Wasit's own fixture on the official SDK. No third-party Solana
  service was tested.
- `X402-08`'s and `X402-10`'s refusals both read `transaction_simulation_failed`: the
  facilitator's simulation fails for a transaction already executed and for an expired
  blockhash alike. Both keep the resource from being served.
- Unreleased: this ran from the branch, not from npm. Registry parity follows the 0.7.0
  release.
