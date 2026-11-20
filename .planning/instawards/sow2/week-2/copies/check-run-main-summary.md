<!-- Copy of the summary of the check run "Wasit conformance" of dzakwannajmi/x402-example-paywall run 44641632605 on main (commit 9383462), taken 2026-11-20 from the GitHub API. The live check run is authoritative: https://github.com/dzakwannajmi/x402-example-paywall/runs/135973988866 -->

**Title:** ✅ conformant · 11 passed · **Conclusion:** success

**Wasit: ✅ conformant.** 1 graded on local, stellar:testnet. Wasit 0.7.0 (core 0.7.0), built from commit f62a09c, x402 v2, @x402/core 2.28.0, @x402/stellar 2.28.0, @stellar/mpp 0.7.1, mppx 0.8.14, @stellar/stellar-sdk 16.4.1.

| Endpoint | Protocol | Outcome | Checks |
| --- | --- | --- | --- |
| quote-of-the-day | x402 | ✅ conformant | challenge 5/5; payment 6/6 |

### ✅ quote-of-the-day · x402 · conformant

|   | Check | Result |
| --- | --- | --- |
| ✅ | X402-01 402 Response Status | PASS |
| ✅ | X402-02 Payment Header Present | PASS |
| ✅ | X402-03 Header Payload Decodable | PASS |
| ✅ | X402-04 Required Fields Present | PASS |
| ✅ | X402-05 Network Identifier Valid | PASS |
| ✅ | X402-06 Signature Resubmit Accepted | PASS |
| ✅ | X402-07 Invalid Signature Rejected | PASS |
| ✅ | X402-08 Payment Replay Rejected | PASS |
| ✅ | X402-09 Underpayment Rejected | PASS |
| ✅ | X402-10 Expired Authorization Rejected | PASS |
| ✅ | X402-11 Rejected Request Not Settled | PASS |

**Payment proof**: X402-06 settled on stellar:testnet, [tx ec61…2c0d on Stellar Expert](https://stellar.expert/explorer/testnet/tx/ec61f2df41306528d08388887556a104d5e18be061d964ea7d9e76f13de02c0d).

### Changed since main
Compared with the last green run on main: run 44270967444, started 2026-11-18 08:55 UTC. Runs on main that failed after it are counted under Recent failures on main, not here.
No change since main.

### Notes
- Tier: payment on stellar:testnet. The run charged $0.0225 of the $5.00 cap, at most $1.00 a payment; every signature is counted as if it settled.

<details><summary>Details of each check</summary>

**quote-of-the-day**

- ✅ X402-01 402 Response Status: Server responded with 402 as required.
- ✅ X402-02 Payment Header Present: Payment header found.
- ✅ X402-03 Header Payload Decodable: Header decoded to valid JSON.
- ✅ X402-04 Required Fields Present: All required v2 fields present.
- ✅ X402-05 Network Identifier Valid: Network identifier "stellar:testnet" is valid.
- ✅ X402-06 Signature Resubmit Accepted: Valid payment accepted \(HTTP 200\) and settled on-chain for exactly the advertised 50000 base units of CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA to GDPAPDZWAKBXUPCNMI4YHAZ7DS7UOUTPGXAFDSWZG4URRMWHFSQTDQBM, verified from the transfer event \(tx ec61f2df41306528d08388887556a104d5e18be061…
- ✅ X402-07 Invalid Signature Rejected: Payment with a corrupted authorization signature correctly rejected \(HTTP 402: invalid\_exact\_stellar\_payload\_simulation\_failed\).
- ✅ X402-08 Payment Replay Rejected: The same payment, sent again, was refused \(HTTP 402: invalid\_exact\_stellar\_payload\_simulation\_failed\).
- ✅ X402-09 Underpayment Rejected: A validly signed payment for 25000 of the advertised 50000 base units was refused \(HTTP 402: invalid\_exact\_stellar\_payload\_wrong\_amount\).
- ✅ X402-10 Expired Authorization Rejected: A payment whose authorization had expired was refused \(HTTP 402: invalid\_exact\_stellar\_payload\_simulation\_failed\).
- ✅ X402-11 Rejected Request Not Settled: The request the config declares invalid was refused \(HTTP 400: unsupported language\), and the payment was not taken: its authorization expired at ledger 5821853 unused \(read at ledger 5821854, in the same read that found X402-06's used authorization\); no transfer of it to payTo was recorded, and th…

</details>

