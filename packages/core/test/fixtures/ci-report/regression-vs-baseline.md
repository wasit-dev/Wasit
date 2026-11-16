<!-- wasit-report -->
**Wasit: regression.** 1 graded, 1 unsupported on local, stellar:testnet. Wasit 0.7.0 (core 0.7.0), x402 v2, @x402/core 2.28.0, @x402/stellar 2.28.0, @stellar/mpp 0.7.1, mppx 0.8.14, @stellar/stellar-sdk 16.1.0.

| Endpoint | Protocol | Outcome | Checks |
| --- | --- | --- | --- |
| weather | x402 | conformant | challenge 5/5; payment not run: read-only tier |
| summarize | x402 | unsupported | challenge 1/5, 4 skipped; payment not run: read-only tier |

### Not graded
- **summarize**: unsupported. The service sent an x402 v1 challenge in its response body. To have it graded, move to x402 v2: send the challenge base64-encoded in a PAYMENT-REQUIRED response header.

### Changed since main
Compared with the last green run on main, started 2026-11-15 10:00 UTC. Runs on main that failed after it are counted under Recent failures on main, not here.
- Regression: summarize was conformant on main and is now unsupported.
- summarize X402-02: PASS on main, now SKIP.
- summarize X402-03: PASS on main, now SKIP.
- summarize X402-04: PASS on main, now SKIP.
- summarize X402-05: PASS on main, now SKIP.
