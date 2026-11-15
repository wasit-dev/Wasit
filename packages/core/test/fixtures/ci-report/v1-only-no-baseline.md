<!-- wasit-report -->
**Wasit: nothing graded.** 0 graded, 1 unsupported on local, stellar:testnet. Wasit 0.7.0 (core 0.7.0), x402 v2, @x402/core 2.28.0, @x402/stellar 2.28.0, @stellar/mpp 0.7.1, mppx 0.8.14, @stellar/stellar-sdk 16.1.0.

| Endpoint | Protocol | Outcome | Checks |
| --- | --- | --- | --- |
| old | x402 | unsupported | challenge 1/5, 4 skipped; payment not run: read-only tier |

### Not graded
- **old**: unsupported. the service sent an x402 v1 challenge in its response body. To have it graded, move to x402 v2: send the challenge base64-encoded in a PAYMENT-REQUIRED response header.

### Changed since main
No baseline on main yet, so nothing is compared. The next run on main creates it.

### Notes
- Tier: read-only. Payment checks were not run.
