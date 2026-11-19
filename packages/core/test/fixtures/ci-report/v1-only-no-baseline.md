<!-- wasit-report -->
**Wasit: ⚪ nothing graded.** 0 graded, 1 unsupported on local, stellar:testnet. Wasit 0.7.0 (core 0.7.0), x402 v2, @x402/core 2.28.0, @x402/stellar 2.28.0, @stellar/mpp 0.7.1, mppx 0.8.14, @stellar/stellar-sdk 16.1.0.

| Endpoint | Protocol | Outcome | Checks |
| --- | --- | --- | --- |
| old | x402 | ⚪ unsupported | challenge 1/5, 4 skipped; payment not run: read-only tier |

### ⚪ old · x402 · unsupported

|   | Check | Result |
| --- | --- | --- |
| ✅ | X402-01 402 Response Status | PASS |
| ⚪ | X402-02 X402-02 | SKIP |
| ⚪ | X402-03 X402-03 | SKIP |
| ⚪ | X402-04 X402-04 | SKIP |
| ⚪ | X402-05 X402-05 | SKIP |
| ⚪ | X402-06 Signature Resubmit Accepted | SKIP |
| ⚪ | X402-07 Invalid Signature Rejected | SKIP |
| ⚪ | X402-08 Payment Replay Rejected | SKIP |
| ⚪ | X402-09 Underpayment Rejected | SKIP |
| ⚪ | X402-10 Expired Authorization Rejected | SKIP |
| ⚪ | X402-11 Rejected Request Not Settled | SKIP |

### Not graded
- **old**: unsupported. The service sent an x402 v1 challenge in its response body. To have it graded, move to x402 v2: send the challenge base64-encoded in a PAYMENT-REQUIRED response header.

### Changed since main
No baseline on main yet, so nothing is compared. The next run on main creates it.

### Notes
- Tier: read-only. Payment checks were not run.

<details><summary>Details of each check</summary>

**old**

- ✅ X402-01 402 Response Status: ok
- ⚪ X402-02 X402-02: Skipped: the service sent an x402 v1 challenge in its response body. To have it graded, move to x402 v2: send the challenge base64-encoded in a PAYMENT-REQUIRED response header.
- ⚪ X402-03 X402-03: the same reason as above.
- ⚪ X402-04 X402-04: the same reason as above.
- ⚪ X402-05 X402-05: the same reason as above.
- ⚪ X402-06 Signature Resubmit Accepted: Skipped: the read-only tier makes no payment and signs nothing; this check needs a payer key and the payment tier
- ⚪ X402-07 Invalid Signature Rejected: the same reason as above.
- ⚪ X402-08 Payment Replay Rejected: the same reason as above.
- ⚪ X402-09 Underpayment Rejected: the same reason as above.
- ⚪ X402-10 Expired Authorization Rejected: the same reason as above.
- ⚪ X402-11 Rejected Request Not Settled: the same reason as above.

</details>
