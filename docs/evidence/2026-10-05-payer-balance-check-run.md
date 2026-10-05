# A Payer That Cannot Pay Is the Payer's Problem — X402-06 Reads the Balance First

**Date:** 2026-10-05
**Wasit:** a build of the local `release/0.7.0` branch (`21f7bdc`), not yet published.
**Targets:** Wasit's own x402 fixtures on Stellar testnet (port 3001), Base Sepolia
(3005, EIP-3009; 3006, Permit2) and Solana devnet (3007), each settling through the
public `x402.org` facilitator. All on our machine.
**Environment:** macOS, Node `v26.8.1`.

**What this is for.** A conformance tester must not blame a target for its own setup. A payer holding none of the asset cannot fund a payment, and before this
change that showed up as a verdict about the target, or as an unreadable error:

- On Solana devnet, measured earlier the same day with a throwaway payer:
  `FAIL X402-06 Expected 2xx after a valid payment, got 402
  (invalid_exact_svm_transaction_simulation_failed)`. The facilitator gives that reason
  for real defects too, so it cannot be told apart afterwards.
- On Stellar testnet, the SDK client simulates the transfer while building the payment,
  and stopped there: `ERROR X402-06 Check could not run (harness): Stellar simulation
  failed with error message: HostError: Error(Contract, #13)`. No verdict, but nothing
  that says what to do.
- On Base Sepolia this was not measured before the change.

X402-06 now reads the payer's balance of the advertised asset before anything is
signed. When the chain reports less than the price, the result is `ERROR (setup)` and
nothing is sent. When the balance cannot be read, the run pays as before, so a failed
read never becomes a verdict.

**Authorization.** None was needed or sought. Every target was Wasit's own code on our
machine. No service operated by anyone else was tested.

## Fresh, unfunded payers

Each payer was a keypair generated for the run, holding nothing, never printed.

```
ERROR  X402-06  Signature Resubmit Accepted
      Check could not run (setup): This run's payer holds less of
      CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA than the advertised
      100000 base units, so its payment cannot settle, and a refusal would say
      nothing about the target. Fund the payer (STELLAR_PRIVATE_KEY), then re-run.
```

| Chain | `X402-06` | `X402-07`–`10` |
|---|---|---|
| Stellar testnet | `ERROR (setup)`, names `STELLAR_PRIVATE_KEY` | SKIP |
| Base Sepolia | `ERROR (setup)`, names `EVM_PRIVATE_KEY` | SKIP |
| Solana devnet | `ERROR (setup)`, names `SVM_PRIVATE_KEY` | SKIP |

How each balance is read:

- **Base Sepolia:** the token's ERC-20 `balanceOf`.
- **Solana devnet:** every token account the payer holds for the mint, summed. The client
  pays from the associated one only, so the sum is never less than what it can spend.
- **Stellar:** the token's `balance`, simulated. A Stellar Asset Contract answers an
  account without a trustline with an error rather than zero, which is the usual state of
  an unfunded payer. So when the token is that asset's SAC, recognised because the asset
  named by its `name` (`USDC:GBBD47IF…FLA5`) derives this very contract id, the trustline
  is looked up, and none means the payer holds nothing.

The same reads, made directly against each chain's public RPC: the funded payers read
196000000 (Stellar), 19910000 (Base Sepolia) and 19970000 (Solana) base units; fresh
addresses read 0 on all three.

## Funded payers

With the funded payers, on the same build, every x402 fixture passed 10/10: Stellar
(port 3001), Base Sepolia EIP-3009 (3005) and Permit2 (3006), Solana devnet (3007), with
`X402-06` settled on-chain each time.

## An observation on the way

One Permit2 run (port 3006), started a few seconds after an EIP-3009 run from the same
payer, drew `FAIL X402-06 Expected 2xx after a valid payment, got 402.`, with no reason
given. The payer's USDC transfers on Base Sepolia show no settlement at that time, so the
payment was refused, not taken. Five Permit2 runs followed, three of them right after an
EIP-3009 run, as the failing one was: all passed 10/10. The cause was not found; it was
the target's facilitator refusing once, which Wasit reported as it happened.

## Limits

- Wasit's own fixtures only. No third-party service was tested.
- A balance that cannot be read gives no protection: the run pays, as before 0.7.0.
- On Stellar, only a Stellar Asset Contract's missing trustline is read as zero; for
  other SEP-41 tokens a failed `balance` read pays as before. The asset's issuer, which
  needs no trustline, is never read as zero.
- Unreleased: this ran from the branch, not from npm.
