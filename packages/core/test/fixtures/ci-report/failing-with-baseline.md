<!-- wasit-report -->
**Wasit: ❌ non-conformant.** 3 graded (1 non-conformant) on local, stellar:testnet. Wasit 0.7.0 (core 0.7.0), x402 v2, @x402/core 2.28.0, @x402/stellar 2.28.0, @stellar/mpp 0.7.1, mppx 0.8.14, @stellar/stellar-sdk 16.1.0.

| Endpoint | Protocol | Outcome | Checks |
| --- | --- | --- | --- |
| weather | x402 | ❌ non-conformant | challenge 4/5, 1 failed |
| summarize | x402 | ✅ conformant | challenge 5/5; payment not run: read-only tier |
| fresh | x402 | ✅ conformant | challenge 5/5; payment not run: read-only tier |

### ❌ weather · x402 · non-conformant

|   | Check | Result |
| --- | --- | --- |
| ✅ | X402-01 402 Response Status | PASS |
| ✅ | X402-02 Payment Header Present | PASS |
| ✅ | X402-03 Header Payload Decodable | PASS |
| ❌ | X402-04 Required Fields Present | FAIL |
| ✅ | X402-05 Network Identifier Valid | PASS |

### ✅ summarize · x402 · conformant

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

### ✅ fresh · x402 · conformant

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

### Changed since main
Compared with the last green run on main, started 2026-11-15 10:00 UTC. Runs on main that failed after it are counted under Recent failures on main, not here.
- New FAIL: weather X402-04 (was PASS on main).
- New endpoint: fresh.

### Failures

**weather: X402-04 Required Fields Present**
- Found: Missing: payTo, asset.
- Expected: payTo, asset present
- Actual: payTo, asset missing
- Fix: Add \`payTo\`: the address that receives the payment. Add \`asset\`: the address of the token the client pays in.
- Docs: https://usewasit.dev/docs/checks/x402

### Recent failures on main
- weather X402-04: failed in 1 of the last 3 runs on main

<details><summary>Details of each check</summary>

**weather**

- ✅ X402-01 402 Response Status: ok
- ✅ X402-02 Payment Header Present: ok
- ✅ X402-03 Header Payload Decodable: ok
- ❌ X402-04 Required Fields Present: Missing: payTo, asset.
- ✅ X402-05 Network Identifier Valid: ok

**summarize**

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

**fresh**

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

</details>
