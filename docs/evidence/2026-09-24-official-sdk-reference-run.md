# 2026-09-24 — MPP against the official SDK's own example servers

**Wasit:** `@wasit-dev/cli@0.4.0`, run through `npx` from the npm registry in an
empty directory. Not a checkout.
**Targets:** `examples/charge-server.ts` and `examples/channel-server.ts` from
[`stellar/stellar-mpp-sdk`](https://github.com/stellar/stellar-mpp-sdk), unmodified,
run with `tsx` on our machine against Stellar testnet, at two commits:

| Label | Commit | Date | `mppx` resolved |
|---|---|---|---|
| `main` | `afd8fb5` "chore(deps): bump mppx to 0.10.1 (#78)" | 2026-09-22 | 0.10.1 |
| before #78 | `1ee3f25` "Update stellar sdk to 16.3 ... (#74)" | 2026-09-14 | 0.8.1 |

**Environment:** macOS, Node `v26.8.1`, dependencies installed with
`pnpm install --frozen-lockfile` at each commit.

**What this is for.** It is the SOW's fallback for D2: "the remainder
self-hosted reference services built from the official SDKs". Every earlier MPP
run pointed Wasit at fixtures this project wrote, and a tester and its own
fixtures share the author's assumptions. This is the first MPP run against
server code written by the SDK's maintainers. It also covers the MPP half of the
0.4.0 registry parity gap, since every command ran from the published package.

**Authorization.** None was needed or sought. These are open-source examples
run on our machine. **This does not satisfy the SOW's "third-party service
tested with the operator's explicit authorization" row**, which remains open in
`.planning/instawards/02-third-party-validation.md`.

---

## Results

| Check | `main` (`afd8fb5`) | before #78 (`1ee3f25`) |
|---|---|---|
| `MPP-01` Charge settlement on-chain | **PASS** | not run |
| `MPP-10` Channel deploy | **PASS** | **PASS** |
| `MPP-11` Cumulative commitment ordering | **FAIL**: 500 | **PASS**: 402 |
| `MPP-12` Challenge replay rejection | **FAIL**: 500 | **PASS**: 402 |
| `MPP-14` Commitment replay rejection | **FAIL**: 500 | **PASS**: 402 |
| `MPP-13` Close settlement | skipped (destructive) | skipped (destructive) |

`MPP-01` settled exactly the advertised 100000 base units of testnet USDC,
verified from the token contract's transfer event:
[`2f7320f6…6a04`](https://stellar.expert/explorer/testnet/tx/2f7320f6d86de6c17f45c63c9dde568e5fbbb73b4567787926d17e1f35fd6a04).

The two channel columns ran against the same channel contract
(`CBWXNWG4…6ITD`), with the same commitment key, the same Wasit binary and the
same command, minutes apart. The only variable is the SDK commit.

### The finding: every rejected channel voucher is now HTTP 500

On `main`, the SDK still detects every violation correctly. The server log
names the right rule each time:

```
ChannelVerificationError: [stellar:channel] Commitment amount 1000000 must be greater than previous cumulative 1000000.
ChannelVerificationError: Challenge already used. Replay rejected.
ChannelVerificationError: [stellar:channel] Commitment amount 3000000 must be greater than previous cumulative 3000000.
```

**No voucher was honoured twice.** What changed is how the refusal reaches the
client:

```
before #78:  HTTP 402  {"type":"https://paymentauth.org/problems/verification-failed", ...}
main:        HTTP 500  {"type":"https://paymentauth.org/problems/internal-payment-error",
                        "title":"Internal Payment Error","detail":"An internal payment error occurred."}
```

**Cause.** `@stellar/mpp`'s errors (`ChannelVerificationError`,
`PaymentVerificationError`, `SettlementError`) extend a plain `Error` through
`StellarMppError`, not `mppx`'s `Errors.PaymentError`. `mppx`'s server wraps
anything that is not a `PaymentError`, and #78 changed what it wraps it in:

| `mppx` | Non-`PaymentError` thrown from `verify` becomes | Status |
|---|---|---|
| 0.8.x | `VerificationFailedError` | 402 |
| 0.10.1 | `InternalPaymentError` (and logs `mppx: internal verification error`) | 500 |

#78's description says both breaking changes between 0.8.1 and 0.10.1 are
scoped to `mppx`'s Tempo/EVM code and "no code changes were needed beyond the
version bump". The change above is outside that scope and the claim does not
hold for the channel server.

**Why it matters.**
- A 402 carries a fresh challenge and tells the client to pay correctly. A
  500 tells it the server is broken. Clients, retry policies and monitoring all
  treat the two differently.
- The `detail` field no longer says what was wrong, so an honest client that
  sent a stale amount cannot tell that from a genuine outage.
- The same path carries "Commitment exceeds channel balance" (observed in this
  session before the channel was topped up, see Setup), which a client needs
  in order to know that it should top up.
- Not yet observed on charge mode. `PaymentVerificationError` shares the base
  class, so an invalid charge credential likely takes the same path, but no
  Wasit check submits one, and this was not probed.

**Status.** Unreleased. `@stellar/mpp@latest` on npm is still `0.7.1`, which
predates #78, so no consumer installing from the registry sees this today. It
ships with the next release unless fixed first. Filed as upstream Finding 4 in
`docs/findings/upstream-sdk.md`.

---

## A defect in Wasit found by this run

Before this session, `MPP-12` and `MPP-14` reported any non-402 response with
"was accepted twice ... This is a double-spend." Against `main` that meant a
FAIL claiming a double-spend while the server had refused the replay, the same
class of error as 0.4.0's fixes: a claim the response does not support. Fixed
in source (unreleased): the double-spend wording now appears only for a 2xx;
any other status reports that the replay was refused with the wrong status.
Covered by `packages/core/test/unit/replay-outcome.test.ts`. The FAIL verdicts
themselves are unchanged and correct, since 402 is the required status. The
outputs quoted above are from the published 0.4.0 and still carry the old
wording.

---

## Setup, and what it took to get a clean run

- **Charge server:** `STELLAR_RECIPIENT` set to our recipient. `MPP_SECRET_KEY`
  unset, so the example's own default applies. No fee payer.
- **Channel server:** `CHANNEL_CONTRACT` and `COMMITMENT_PUBKEY` from our
  existing testnet channel. No fee payer, so no on-chain settlement path.
- **Channel balance.** The first channel run returned `ERROR (setup)` for
  `MPP-12` and `MPP-14`: the channel held 1000000 base units (0.1 USDC) and
  the example charges 0.1 USDC per request, so it was exhausted after one
  advancing commitment. Wasit reported that as "could not run", not as a
  defect, which is the 0.4.0 setup-failure behaviour working as designed. The
  channel was topped up by 20000000 from its funder:
  [`4181c153…a5fa`](https://stellar.expert/explorer/testnet/tx/4181c153e9c1b566f62504165263f554fa50eb9bc1d8b3e6c4e847150af2a5fa),
  bringing it to 21000000. Both servers were then restarted for fresh stores,
  and the results above are from those final runs.
- **`MPP-10` expectations.** `--expect-token` is testnet USDC's SAC,
  `--expect-from` and `--expect-to` are our funder and recipient from `.env`,
  all known independently of the contract. `--expect-refund-period 100` was
  read from the contract in this session. That part of `MPP-10` is therefore a
  self-consistency check, not an independent one.

## Limits

- `MPP-13` did not run. It closes the channel permanently.
- Self-hosted on our own machine, with our own keys, as both payer and payee.
- The run covers the example servers as published. A production server built
  on the same SDK could configure `mppx` differently.
