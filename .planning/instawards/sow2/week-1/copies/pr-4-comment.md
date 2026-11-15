# Copy of the Wasit comment on PR #4 of dzakwannajmi/x402-example-paywall, after the Action was updated to commit 5c498cd (taken 2026-11-15 at 18:58, local time of the maintainer; the live PR is authoritative)

PR title: Serve the challenge in the body for older clients  (state: OPEN)

Comment by github-actions, created 2026-11-15T09:44:23Z, last edited never:

<!-- wasit-report -->
**Wasit: regression.** 0 graded, 1 unsupported on local, stellar:testnet. Wasit 0.7.0 (core 0.7.0), built from commit 5c498cd, x402 v2, @x402/core 2.28.0, @x402/stellar 2.28.0, @stellar/mpp 0.7.1, mppx 0.8.14, @stellar/stellar-sdk 16.4.1.

| Endpoint | Protocol | Outcome | Checks |
| --- | --- | --- | --- |
| quote-of-the-day | x402 | unsupported | challenge 1/5, 4 skipped; payment not run: read-only tier |

### Not graded
- **quote-of-the-day**: unsupported. The service sent an x402 v1 challenge in its response body. Wasit grades x402 v2, and the \`exact\` scheme on Stellar exists for v2 only, so this endpoint is unsupported, not failed. To have it graded, move to x402 v2: send the challenge base64-encoded in a PAYMENT-REQUIRED response header.

### Changed since main
- Regression: quote-of-the-day was conformant on main and is now unsupported.
- quote-of-the-day X402-02: PASS on main, now SKIP.
- quote-of-the-day X402-03: PASS on main, now SKIP.
- quote-of-the-day X402-04: PASS on main, now SKIP.
- quote-of-the-day X402-05: PASS on main, now SKIP.

### Notes
- Tier: read-only. The payment checks were not run, and nothing was signed.

