<!-- wasit-report -->
**Wasit: ✅ conformant.** 1 graded on channel, stellar:testnet. Wasit 0.8.0-beta.1 (core 0.8.0-beta.1), x402 v2, @x402/core 2.28.0, @x402/stellar 2.28.0, @stellar/mpp 0.7.1, mppx 0.8.14, @stellar/stellar-sdk 16.4.1.

| Endpoint | Protocol | Outcome | Checks |
| --- | --- | --- | --- |
| stream | mpp-channel | ✅ conformant | MPP channel 3/4, 1 skipped |

### ✅ stream · mpp-channel · conformant

|   | Check | Result |
| --- | --- | --- |
| ⚪ | MPP-10 Channel Deploy | SKIP |
| ✅ | MPP-11 Cumulative Commitment Ordering | PASS |
| ✅ | MPP-12 Challenge Replay Rejection | PASS |
| ✅ | MPP-14 Commitment Replay Rejection | PASS |

### Changed since main
No baseline on main yet, so nothing is compared. The next run on main creates it.

### Notes
- Tier: payment on stellar:testnet. No payment was planned, so nothing was charged to the cap.
- MPP channel: the commitments MPP-11, MPP-12 and MPP-14 sign are off-chain, and Wasit sends no transaction for them, so they are not charged to the cap. MPP-13 \(close\) is never run by wasit run.

<details><summary>Details of each check</summary>

**stream**

- ⚪ MPP-10 Channel Deploy: Skipped: expected on-chain parameters not supplied \(token, from, to, refundWaitingPeriod\).
- ✅ MPP-11 Cumulative Commitment Ordering: Both ordering rules enforced: a commitment equal to the cumulative \(10000\) and one that under-covers the price \(19999\) were each rejected with HTTP 402.
- ✅ MPP-12 Challenge Replay Rejection: Byte-identical credential correctly rejected on replay \(HTTP 402\).
- ✅ MPP-14 Commitment Replay Rejection: Captured commitment \(30000\) correctly rejected when re-presented against a fresh challenge \(HTTP 402\).

</details>
