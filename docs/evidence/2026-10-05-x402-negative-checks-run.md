# Replay, Underpayment and Expired Authorization — Three New x402 Checks, on Stellar and Base Sepolia

**Date:** 2026-10-05
**Wasit:** a build of the local `release/0.7.0` branch with `X402-08`, `X402-09` and
`X402-10`, not yet published.
**Targets:** Wasit's own x402 fixtures, on Stellar testnet (port 3001) and Base Sepolia
(port 3005), both settling through the public `x402.org` facilitator; and `wasit serve
--mode no-settle` on each chain, a paywall that takes any payment. All on our machine.
**Environment:** macOS, Node `v26.8.1`.

**What this is for.** `X402-07` already checked that a corrupted signature is refused.
Three more ways a payment can be wrong while its signature is fine are now checked, each
grounded in the spec: the same payment sent twice (each authorization is single-use,
x402 v2 §10.1), a payment for less than the price (Stellar: the amount must equal the
requirement exactly; EVM: verification step 3), and a payment whose authorization has
expired (§10.1 time constraints; verification of the validity window). As in 0.6.0, a
check is only worth having if it fails the servers that get this wrong and passes one
that gets it right.

**Authorization.** None was needed or sought. Every target was Wasit's own code on our
machine. No service operated by anyone else was tested.

## An honest server: 10/10 on both chains

Each refusal below is quoted as printed, with the reason the target gave.

**Stellar testnet** (`wasit test --target http://localhost:3001/protected`), 42 seconds,
most of it `X402-10` waiting out the authorization:

```
PASS  X402-07  Invalid Signature Rejected
      Payment with a corrupted authorization signature correctly rejected
      (HTTP 402: invalid_exact_stellar_payload_simulation_failed).
PASS  X402-08  Payment Replay Rejected
      The same payment, sent again, was refused
      (HTTP 402: invalid_exact_stellar_payload_simulation_failed).
PASS  X402-09  Underpayment Rejected
      A validly signed payment for 50000 of the advertised 100000 base units was
      refused (HTTP 402: invalid_exact_stellar_payload_wrong_amount).
PASS  X402-10  Expired Authorization Rejected
      A payment whose authorization had expired was refused
      (HTTP 402: invalid_exact_stellar_payload_simulation_failed).
```

On Stellar the facilitator re-simulates every payment against the current ledger; a
spent nonce, an expired auth entry and a bad signature all fail that simulation, which is
the reason it names for three of the four. The underpayment is caught earlier, by the
amount rule.

**Base Sepolia** (`--network eip155:84532`, target port 3005), 9.5 seconds:

```
PASS  X402-07  Invalid Signature Rejected
      Payment with a corrupted authorization signature correctly rejected
      (HTTP 402: invalid_exact_evm_signature).
PASS  X402-08  Payment Replay Rejected
      The same payment, sent again, was refused (HTTP 402).
PASS  X402-09  Underpayment Rejected
      A validly signed payment for 5000 of the advertised 10000 base units was
      refused (HTTP 402: invalid_exact_evm_payload_authorization_value_mismatch).
PASS  X402-10  Expired Authorization Rejected
      A payment whose authorization had expired was refused
      (HTTP 402: invalid_exact_evm_payload_authorization_valid_before).
```

The Base Sepolia replay was refused without a stated reason. A separate probe paid the
fixture once and replayed the same header: the replay drew 402 with no
`PAYMENT-REQUIRED` header and an empty `{}` body, a different response path from the
verify refusals above. What matters to the check holds either way: the resource was not
served a second time.

## A server that takes anything

`wasit serve --mode no-settle` answers every payment with 200 and settles nothing.

| | Stellar | Base Sepolia |
|---|---|---|
| `X402-06` | FAIL | FAIL |
| `X402-07` | FAIL | FAIL |
| `X402-08` | FAIL | FAIL |
| `X402-09` | FAIL | FAIL |
| `X402-10` | FAIL | FAIL |

## How each payment was built

- **Replay:** the headers `X402-06`'s accepted payment was sent with, byte for byte.
  Nothing can settle twice, so this costs nothing.
- **Underpayment:** signed by the official SDK client for half the advertised amount,
  then sent with `accepted` set back to the advertised terms, so the target's own
  matching passes and only the signed amount is wrong.
- **Expired:** signed with `maxTimeoutSeconds: 1`, from which both SDK clients derive
  the lifetime (EVM `validBefore = now + 1`; Stellar one ledger), held 5 seconds on Base
  Sepolia and 20 on Stellar, and sent claiming the advertised terms.

An offline test confirms each payload says what its check claims: the replay equals the
honest header, the underpayment signs 5000 while `accepted` says 10000, and the expired
authorization's `validBefore` is already past when it arrives.

## Not a check: settling before serving

The default x402 v2 flow is verify, run the resource, settle, respond (§6.1), so a
server that runs the resource before settling is conformant. Only `upfront` and `escrow`
flows settle first, and they must say so in `extra.paymentFlow`. What a client can
observe, a response that arrives with a real settlement, `X402-06` already requires.

## Limits

- Wasit's own fixtures only, on the official SDK and the public facilitator. No
  third-party service was tested.
- `X402-08` cannot tell a server that refuses a replay at verify from one that refuses
  at settlement; both keep the resource from being served twice.
- Unreleased: this ran from the branch. Registry parity follows the 0.7.0 release.
