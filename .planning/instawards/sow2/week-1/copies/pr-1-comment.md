# Copy of the Wasit comment on PR #1 of dzakwannajmi/x402-example-paywall (taken 2026-11-15; the live PR is authoritative)

PR title: Show friendlier network names in the challenge  (state: OPEN)

Comment by github-actions, created 2026-11-15T09:12:38Z, last edited never:

<!-- wasit-report -->
**Wasit: non-conformant.** 1 graded (1 non-conformant) on local, stellar:testnet. Wasit 0.7.0 (core 0.7.0), x402 v2, @x402/core 2.28.0, @x402/stellar 2.28.0, @stellar/mpp 0.7.1, mppx 0.8.14, @stellar/stellar-sdk 16.4.1.

| Endpoint | Protocol | Outcome | Checks |
| --- | --- | --- | --- |
| quote-of-the-day | x402 | non-conformant | challenge 4/5, 1 failed; payment not run: read-only tier |

### Changed since main
- New FAIL: quote-of-the-day X402-05 (was PASS on main).

### Failures

**quote-of-the-day: X402-05 Network Identifier Valid**
- Found: "stellar-testnet" is not a CAIP-2 identifier \(namespace:reference, e.g. stellar:testnet or eip155:84532\), which x402 v2 requires.
- Expected: a CAIP-2 id, namespace:reference, such as stellar:testnet
- Actual: "stellar-testnet"
- Fix: Use the network's CAIP-2 id, namespace:reference, such as stellar:testnet, eip155:84532 \(Base Sepolia\) or solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 \(Solana devnet\).
- Docs: https://usewasit.dev/docs/checks/x402

### Notes
- Tier: read-only. The payment checks were not run, and nothing was signed.

