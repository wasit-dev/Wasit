<!-- wasit-report -->
**Wasit: ❌ regression.** 1 graded, 1 unsupported on local, stellar:testnet. Wasit 0.7.0 (core 0.7.0), x402 v2, @x402/core 2.28.0, @x402/stellar 2.28.0, @stellar/mpp 0.7.1, mppx 0.8.14, @stellar/stellar-sdk 16.1.0.

| Endpoint | Protocol | Outcome | Checks |
| --- | --- | --- | --- |
| weather | x402 | ✅ conformant | challenge 5/5; payment not run: read-only tier |
| summarize | x402 | ⚪ unsupported | challenge 1/5, 4 skipped; payment not run: read-only tier |

### ✅ weather · x402 · conformant

|   | Check | Result |
| --- | --- | --- |
| ✅ | X402-01 402 Response Status | PASS |
| ✅ | X402-02 Payment Header Present | PASS |
| ✅ | X402-03 Header Payload Decodable | PASS |
| ✅ | X402-04 Required Fields Present | PASS |
| ✅ | X402-05 Network Identifier Valid | PASS |
| ⚪ | X402-06 Signature Resubmit Accepted | SKIP |
| ⚪ | X402-07 Invalid Signature Rejected | SKIP |
| ⚪ | X402-08 Payment Replay Rejected | SKIP |
| ⚪ | X402-09 Underpayment Rejected | SKIP |
| ⚪ | X402-10 Expired Authorization Rejected | SKIP |
| ⚪ | X402-11 Rejected Request Not Settled | SKIP |

### ⚪ summarize · x402 · unsupported

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
- **summarize**: unsupported. The service sent an x402 v1 challenge in its response body. To have it graded, move to x402 v2: send the challenge base64-encoded in a PAYMENT-REQUIRED response header.

### Changed since main
Compared with the last green run on main, started 2026-11-15 10:00 UTC. Runs on main that failed after it are counted under Recent failures on main, not here.
- Regression: summarize was conformant on main and is now unsupported.
- summarize X402-02: PASS on main, now SKIP.
- summarize X402-03: PASS on main, now SKIP.
- summarize X402-04: PASS on main, now SKIP.
- summarize X402-05: PASS on main, now SKIP.

<details><summary>Details of each check</summary>

**weather**

- ✅ X402-01 402 Response Status: ok
- ✅ X402-02 Payment Header Present: ok
- ✅ X402-03 Header Payload Decodable: ok
- ✅ X402-04 Required Fields Present: ok
- ✅ X402-05 Network Identifier Valid: ok
- ⚪ X402-06 Signature Resubmit Accepted: Skipped: the read-only tier makes no payment and signs nothing; this check needs a payer key and the payment tier
- ⚪ X402-07 Invalid Signature Rejected: the same reason as above.
- ⚪ X402-08 Payment Replay Rejected: the same reason as above.
- ⚪ X402-09 Underpayment Rejected: the same reason as above.
- ⚪ X402-10 Expired Authorization Rejected: the same reason as above.
- ⚪ X402-11 Rejected Request Not Settled: the same reason as above.

**summarize**

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
