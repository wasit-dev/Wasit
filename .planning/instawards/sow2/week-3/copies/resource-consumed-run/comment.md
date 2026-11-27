<!-- wasit-report -->
**Wasit: ✅ conformant.** 1 graded on local, stellar:testnet. Wasit 0.8.0-beta.1 (core 0.8.0-beta.1), x402 v2, @x402/core 2.28.0, @x402/stellar 2.28.0, @stellar/mpp 0.7.1, mppx 0.8.14, @stellar/stellar-sdk 16.4.1.

| Endpoint | Protocol | Outcome | Checks |
| --- | --- | --- | --- |
| single-use | x402 | ✅ conformant | challenge 5/5; payment 2/6, 4 skipped |

### ✅ single-use · x402 · conformant

|   | Check | Result |
| --- | --- | --- |
| ✅ | X402-01 402 Response Status | PASS |
| ✅ | X402-02 Payment Header Present | PASS |
| ✅ | X402-03 Header Payload Decodable | PASS |
| ✅ | X402-04 Required Fields Present | PASS |
| ✅ | X402-05 Network Identifier Valid | PASS |
| ✅ | X402-06 Signature Resubmit Accepted | PASS |
| ⚪ | X402-07 Invalid Signature Rejected | SKIP |
| ✅ | X402-08 Payment Replay Rejected | PASS |
| ⚪ | X402-09 Underpayment Rejected | SKIP |
| ⚪ | X402-10 Expired Authorization Rejected | SKIP |
| ⚪ | X402-11 Rejected Request Not Settled | SKIP |

**Payment proof**: X402-06 settled on stellar:testnet, [tx f946…647b on Stellar Expert](https://stellar.expert/explorer/testnet/tx/f94672c60f6b9a730a210011aef09bd4c7edc5de472384d18e5a70044a2d647b).

### Changed since main
No baseline on main yet, so nothing is compared. The next run on main creates it.

### Notes
- Tier: payment on stellar:testnet. The run charged $0.01 of the $5.00 cap, at most $1.00 a payment; every signature is counted as if it settled.

<details><summary>Details of each check</summary>

**single-use**

- ✅ X402-01 402 Response Status: Server responded with 402 as required.
- ✅ X402-02 Payment Header Present: Payment header found.
- ✅ X402-03 Header Payload Decodable: Header decoded to valid JSON.
- ✅ X402-04 Required Fields Present: All required v2 fields present.
- ✅ X402-05 Network Identifier Valid: Network identifier "stellar:testnet" is valid.
- ✅ X402-06 Signature Resubmit Accepted: Valid payment accepted \(HTTP 200\) and settled on-chain for exactly the advertised 100000 base units of CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA to GDPAPDZWAKBXUPCNMI4YHAZ7DS7UOUTPGXAFDSWZG4URRMWHFSQTDQBM, verified from the transfer event \(tx f94672c60f6b9a730a210011aef09bd4c7edc5de4…
- ⚪ X402-07 Invalid Signature Rejected: Skipped: resource consumed: the route answered 409 to a new request after X402-06's payment was accepted, a single-use resource that the payment used up, so this check has no new challenge to pay, and nothing was signed for it. X402-08, the replay, needs no new challenge and still runs.
- ✅ X402-08 Payment Replay Rejected: The same payment, sent again, was refused \(HTTP 409: resource\_consumed\).
- ⚪ X402-09 Underpayment Rejected: Skipped: resource consumed: the route answered 409 to a new request after X402-06's payment was accepted, a single-use resource that the payment used up, so this check has no new challenge to pay, and nothing was signed for it. X402-08, the replay, needs no new challenge and still runs.
- ⚪ X402-10 Expired Authorization Rejected: the same reason as above.
- ⚪ X402-11 Rejected Request Not Settled: the same reason as above.

</details>
