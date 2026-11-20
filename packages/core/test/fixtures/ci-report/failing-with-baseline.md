<!-- wasit-report -->
**Wasit: non-conformant.** 3 graded (1 non-conformant) on local, stellar:testnet. Wasit 0.7.0 (core 0.7.0), x402 v2, @x402/core 2.28.0, @x402/stellar 2.28.0, @stellar/mpp 0.7.1, mppx 0.8.14, @stellar/stellar-sdk 16.1.0.

| Endpoint | Protocol | Outcome | Checks |
| --- | --- | --- | --- |
| weather | x402 | non-conformant | challenge 4/5, 1 failed |
| summarize | x402 | conformant | challenge 5/5; payment not run: read-only tier |
| fresh | x402 | conformant | challenge 5/5; payment not run: read-only tier |

### Changed since main
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
