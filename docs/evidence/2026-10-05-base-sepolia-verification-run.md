# x402 Payment Checks on Base Sepolia — A/B Against Lying Servers, and a Real Settlement

**Date:** 2026-10-05
**Wasit:** builds of the local `release/0.7.0` branch (`282004c` for the EVM adapter,
`fb21760` for `wasit serve` on Base Sepolia, `7d27551` for the fixture), not yet
published.
**Targets:** `wasit serve --network eip155:84532`, the paywall that misbehaves on
purpose, in three modes; and Wasit's own Base Sepolia x402 fixture
(`packages/core/test/fixtures/x402-evm-server.ts`), settling through the public
`x402.org` facilitator. Both ran on our machine; the chain is Base Sepolia.
**Environment:** macOS, Node `v26.8.1`.

**What this is for.** Until 0.7.0, `X402-06` and `X402-07` paid on Stellar only. They
now also pay on Base Sepolia (`eip155:84532`), with the `exact` scheme's EIP-3009
method: the payer signs a `transferWithAuthorization` off-chain and the facilitator
submits it and pays the gas. The same two things have to hold as when the checks were
made stricter in 0.6.0: they fail servers that lie, and they pass an honest one.

**Authorization.** None was needed or sought. Every target was Wasit's own code on our
machine. No service operated by anyone else was tested.

## Servers that lie

Payer: a throwaway key generated for the run, holding nothing. That is enough here:
EIP-3009 signing needs no balance, and `wasit serve` never settles, so nothing moved.

| `wasit serve` mode | What it does | `X402-06` | `X402-07` |
|---|---|---|---|
| `no-settle` | Serves any payment with 200, without settling and without `PAYMENT-RESPONSE` | **FAIL** | **FAIL** |
| `wrong-settlement` | Serves with a `PAYMENT-RESPONSE` naming a transaction that does not exist | **FAIL** | **FAIL** |
| `wrong-network` | Asks to be paid on Base mainnet (`eip155:8453`) | SKIP, nothing sent | SKIP |

Output, quoted as printed:

```
FAIL  X402-06  Signature Resubmit Accepted
      Valid payment accepted (HTTP 200), but the response carried no
      PAYMENT-RESPONSE header, which the x402 v2 HTTP transport uses to report
      settlement. Whether the payment settled cannot be verified.
FAIL  X402-07  Invalid Signature Rejected
      A payment with a corrupted authorization signature was accepted with
      HTTP 200 — security-relevant failure.
```

```
FAIL  X402-06  Signature Resubmit Accepted
      Target reported settlement as tx 0x18bb3379…2393, but the chain produced
      32 more blocks without it. Either it was never broadcast, or the target
      referenced a transaction that does not exist.
```

The second was decided against Base Sepolia itself, through its public RPC
(`https://sepolia.base.org`): the run took 65 seconds, nearly all of it waiting until
the chain had produced 32 blocks without the cited transaction.

```
SKIP  X402-06  Signature Resubmit Accepted
      Skipped: the target offers no payment option on eip155:84532 (it offers
      eip155:8453), so no payment was attempted (see X402-05).
```

## An honest server

Payer: a Base Sepolia account holding 20 USDC, from Circle's faucet, and **no ETH**.

`wasit test --target http://localhost:3005/protected --network eip155:84532`: **7/7.**

```
PASS  X402-06  Signature Resubmit Accepted
      Valid payment accepted (HTTP 200) and settled on-chain for exactly the
      advertised 10000 base units of 0x036CbD53842c5426634e7929541eC2318f3dCF7e
      to 0xb57bFdA962aAa607D5260747A175cda8f4bDDad7, verified from the Transfer
      log (tx 0xb182df33…7e91).
PASS  X402-07  Invalid Signature Rejected
      Payment with a corrupted authorization signature correctly rejected (HTTP 402).
```

[`0xb182df33…7e91`](https://base-sepolia.blockscout.com/tx/0xb182df33ee676ac15ec9137717027a61432fc24af4761d9fa89fddb23cbf7e91)

Read back independently afterwards, outside Wasit, with `viem` against the same RPC:

| | |
|---|---|
| Receipt | `success`, block 47709831 |
| Sent by (gas paid by) | `0xd407…f1bf`, the facilitator's account, calling the USDC contract |
| Transfers logged | exactly one: payer `0xC171…0428` to payee `0xb57b…Dad7`, 10000 units |
| Payer after | 19.99 USDC, **still 0 ETH** |
| Payee after | 20.01 USDC |

So the settlement Wasit verified is the one that happened, and a Base Sepolia payer
needs the token and nothing else. `X402-07`'s forged signature was refused, and nothing
settled for it.

## What did not change

The same day, on the same build, Wasit's Stellar fixtures were unchanged: x402 7/7 with
`X402-06` settled on-chain, `MPP-01` PASS, channel 3 passed and 2 skipped. 199 core and
54 CLI offline tests pass.

## Limits

- One EVM network: Base Sepolia. Ethereum Sepolia and BNB Smart Chain testnet get the
  read-only checks only; no public facilitator settles them and the official SDK ships
  no default token for either.
- The honest target is Wasit's own fixture on the official SDK. No third-party Base
  Sepolia service was tested.
- Unreleased: this ran from the branch, not from npm. Registry parity follows the 0.7.0
  release.
