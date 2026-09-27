# Reference-Implementation Run — x402 against `stellar/x402-stellar`

**Date:** 2026-09-06
**Wasit:** `@wasit-dev/cli@0.3.0`, installed from the npm registry into an empty
project. Not a checkout.
**Target:** the `simple-paywall` example and its facilitator from
[`stellar/x402-stellar`](https://github.com/stellar/x402-stellar) at commit
`45d735ab3f30a50286d11286b7d7e584fa69bc77`, running locally against Stellar
testnet — facilitator on `:4022`, server on `:3001`. Their server declares
`@x402/core@^2.23.0` and `@x402/stellar@^2.23.0`; their facilitator declares
`@stellar/stellar-sdk@^17.0.1` and resolved `16.2.0` in this tree.
**Environment:** macOS, Node `v26.8.1`.

**Why this run matters.** Every previous Wasit run — including the settlement
run of 2026-09-05 and the package-parity run earlier today — pointed Wasit at
fixtures this project wrote. A tester and its fixtures share the author's
assumptions, so agreement between them proves less than it appears. This is the
first run against an x402 implementation Wasit did not write, and the first time
its checks were judged by somebody else's code.

**Authorization.** None was needed or sought. `simple-paywall` is an
open-source example, run on our own machine from a public repository. No
service operated by anyone else was contacted. This therefore does **not**
satisfy the SOW's "at least one third-party service tested with the operator's
explicit authorization" requirement, which remains open in
the evidence package (`docs/evidence/README.md`).

## Results

| Target | Checks | Result |
|---|---|---|
| `http://localhost:3001/protected/testnet` | `X402-01`–`07`, full flow | **7/7 PASS** |
| `http://localhost:3001/weather/testnet` | `X402-01`–`05`, read-only | **5/5 PASS** |

```
PASS  X402-01  Server responded with 402 as required.
PASS  X402-02  Payment header found.
PASS  X402-03  Header decoded to valid JSON.
PASS  X402-04  All required v2 fields present.
PASS  X402-05  Network identifier "stellar:testnet" is valid.
PASS  X402-06  Valid payment accepted (HTTP 200).
PASS  X402-07  Corrupted payment correctly rejected (HTTP 402).
```

Their challenge arrives in a header named `PAYMENT-REQUIRED`, not `X-Payment`.
Wasit accepts either, so this is not a finding — but it is the naming
inconsistency this project was partly built to catch, observed in the reference
implementation itself.

The decoded challenge:

```json
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact",
    "network": "stellar:testnet",
    "amount": "100000",
    "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "payTo": "GDFWROEZOZ7REZYU3P3IJXCFNSA3TZL2XB5APZJTK5FLVRTMAQVQS4FM",
    "maxTimeoutSeconds": 300,
    "extra": { "areFeesSponsored": true }
  }]
}
```

## What this validates

**`X402-04` reads the version and demands the right field name.** The challenge
advertises `x402Version: 2` and carries `amount`, not `maxAmountRequired`.
Wasit reported "All required v2 fields present." An earlier version of this
check demanded the v1 field name unconditionally; that was corrected during
development and recorded under *Explicitly not findings* in
`docs/findings/upstream-sdk.md`. The correction is now validated against the
implementation with the most standing to judge it.

## What this found — two weaknesses in Wasit

Both were visible only because someone else's code was on the other end.

### `X402-07` rejects at XDR decoding, not signature verification

The facilitator's log shows where the rejection came from:

```
XdrReaderError: XDR Read Error: invalid XDR contract typecast
  - source buffer not entirely consumed
  at new Transaction (@stellar/stellar-sdk/base/transaction.ts:51)
  at ExactStellarScheme._verify (@x402/stellar/exact/facilitator/scheme.ts:412)
```

The envelope never parsed, so signature verification never ran. The cause is
the corruption itself: `transaction.slice(0, -8) + "AAAAAAAA"` also removes the
base64 padding. The payload Wasit sent decodes to 1014 bytes, and `1014 % 4 = 2`
— an XDR envelope is always a multiple of four. The original was 1012 bytes with
`==` padding; the substitution added two bytes.

`docs/CHECKS.md` claimed the payload was "well-formed in every respect except
the signature it carries, and only signature verification can explain a
rejection." That was false. A target that parsed the envelope and skipped
signature verification entirely would pass `X402-07` today.

The verdict is not wrong — the check still catches a target answering 200 to a
payment it cannot validate — but it is narrower than it was advertised to be.
Documentation and the code comment were corrected the same day. Corrupting only
the signature bytes while preserving a decodable envelope is a 0.4.0 item.

### `X402-06` does not verify the settlement on-chain

`X402-06` passes on `status >= 200 && status < 300`. There is no RPC call
anywhere in `packages/core/src/x402/simulator.ts`. Of the thirteen checks, only
`MPP-01` reads the token contract's transfer event.

The settlement did happen — the facilitator logged `/verify → isValid: true`
followed by `/settle → 200` — but Wasit did not check it. It trusted the
response.

`docs/CHECKS.md` was accurate about the pass criterion. Three other surfaces
were not: the root README, the CLI README's opening paragraph (the npm listing
page), and the homepage tagline all claimed on-chain verification without
qualification, the CLI README most explicitly — "the token contract's own
on-chain transfer event, not by trusting the response the service returns."
That is what `MPP-01` does; it is not what the x402 checks do.

All three were scoped the same day. The npm page keeps the old wording until the
next release, since a package's README is frozen at publish time. Giving
`X402-06` the same on-chain verification `MPP-01` already performs is a 0.4.0
item, and will change results: a service that answers 200 without settling
passes today and will fail then.

## Limits of this run

- **Their example, our machine.** Not their hosted service, and not a
  third-party operator's deployment. It does not satisfy D2's authorization
  requirement.
- **One account served two roles.** `TESTNET_SERVER_STELLAR_ADDRESS` and
  `FACILITATOR_STELLAR_PRIVATE_KEY` were the same keypair, generated for this
  run. The payer was separate. A cleaner run would separate all three.
- **No transaction hash was captured for `X402-06`** — because Wasit does not
  surface one for x402 payments, which is the second finding above. Settlement
  is attested only by the facilitator's own log here.
- **`/weather/testnet` was exercised read-only**, so its payment path is
  untested.
- **Run once**, against one commit of their repository. Not repeated, and not
  re-run against later commits.

## Reproducing

Their repository, two terminals, with `.env` copied into each package directory
— both call `dotenv.config()` with no path, so each reads the `.env` in its own
working directory, not the one at the repo root:

```bash
cd examples/facilitator && pnpm dev
cd examples/simple-paywall/server && pnpm dev
```

The facilitator's own `.env.example` sets `PORT=4022`; the root one sets `3001`.
Copying the root file over the facilitator's puts both services on the same
port.

Then, from an empty directory holding a `.env` with a funded testnet payer key:

```bash
npm install @wasit-dev/cli@0.3.0
wasit test --target http://localhost:3001/protected/testnet --read-only
wasit test --target http://localhost:3001/protected/testnet
```

The receiving account needs a USDC trustline before the full run; Friendbot
funds XLM only.
