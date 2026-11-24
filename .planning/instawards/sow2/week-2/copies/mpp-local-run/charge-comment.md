<!-- wasit-report -->
**Wasit: ✅ conformant.** 1 graded on charge, stellar:testnet. Wasit 0.8.0-beta.1 (core 0.8.0-beta.1), x402 v2, @x402/core 2.28.0, @x402/stellar 2.28.0, @stellar/mpp 0.7.1, mppx 0.8.14, @stellar/stellar-sdk 16.4.1.

| Endpoint | Protocol | Outcome | Checks |
| --- | --- | --- | --- |
| chat | mpp-charge | ✅ conformant | MPP charge 1/1 |

### ✅ chat · mpp-charge · conformant

|   | Check | Result |
| --- | --- | --- |
| ✅ | MPP-01 Charge Settlement On-Chain | PASS |

**Payment proof**: MPP-01 settled on stellar:testnet, [tx 4349…bf83 on Stellar Expert](https://stellar.expert/explorer/testnet/tx/43499f50af379f20467b31645815e4d31db250bef4315ce98d5ed22eb83cbf83).

### Changed since main
No baseline on main yet, so nothing is compared. The next run on main creates it.

### Notes
- Tier: payment on stellar:testnet. The run charged $0.001 of the $5.00 cap, at most $1.00 a payment; every signature is counted as if it settled.

<details><summary>Details of each check</summary>

**chat**

- ✅ MPP-01 Charge Settlement On-Chain: Settled on-chain for exactly the advertised 10000 base units of CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA to GALVZ57VAY6BE33WYPJMUJ27PFAUDRQ6ATTVMIIF4STTGQTXDBEIBXUI, verified from the transfer event \(tx 43499f50af379f20467b31645815e4d31db250bef4315ce98d5ed22eb83cbf83\).

</details>
