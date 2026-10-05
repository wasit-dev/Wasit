# @wasit-dev/core

The check suite behind [`@wasit-dev/cli`](https://www.npmjs.com/package/@wasit-dev/cli) and [`@wasit-dev/server`](https://www.npmjs.com/package/@wasit-dev/server) — protocol-compliance checks for **x402** and **MPP** on Stellar.

This package holds the actual check logic. The CLI and the MCP server are thin adapters over these same functions, so a CLI run and an agent's run can never disagree about the same target — there is only one implementation of each check.

**Testnet only.** Several checks settle real transactions on-chain.

Most people should reach for [`@wasit-dev/cli`](https://www.npmjs.com/package/@wasit-dev/cli) (terminal) or [`@wasit-dev/server`](https://www.npmjs.com/package/@wasit-dev/server) (MCP / agents) instead of this package directly. Install `@wasit-dev/core` yourself only if you're building your own tooling on top of the check suite.

## Install

```bash
npm install @wasit-dev/core
```

Requires Node.js `>=22`. Ships ESM only (`"type": "module"`), with TypeScript types included (`dist/index.d.ts`).

## Usage

```ts
import {
  runX402ReadChecks,
  runX402PaymentChecks,
  summarize,
  checkStatus,
} from "@wasit-dev/core";

const readResults = await runX402ReadChecks({
  target: "https://your-service.example.com/paid",
});

// With a testnet payer key, also exercise the payment flow.
// X402-06 settles a real payment; X402-07 attempts one with a corrupted signature.
const paidResults = await runX402PaymentChecks({
  target: "https://your-service.example.com/paid",
  network: "stellar:testnet",
  payerSecretKey: process.env.STELLAR_PRIVATE_KEY!,
});

const summary = summarize([...readResults, ...paidResults]);
console.log(summary.exitCode); // 0 conformant, 1 non-conformant, 2 no verdict
```

Every check function returns `Promise<CheckResult[]>` and never rejects for a target-side problem — a check that couldn't run (unreachable target, bad config) comes back as an `ERROR` or `SKIP` result, not a thrown error.

## API

### x402

| Function | Checks | Cost |
|---|---|---|
| `runX402ReadChecks({ target, method?, body?, headers? })` | `X402-01`–`05` | Free |
| `runX402PaymentChecks({ target, network, payerSecretKey, rpcUrl?, method?, body?, headers? })` | `X402-06`–`10` | **Settles a real payment every call** |

### MPP — charge mode

| Function | Checks | Cost |
|---|---|---|
| `runMppChargeSuite({ target, network, payerSecretKey, rpcUrl? })` | `MPP-01` | **Settles a real payment every call** |

### MPP — channel mode

| Function | Checks | Cost |
|---|---|---|
| `runMppChannelSuite({ target, commitmentSecretHex, network, rpcUrl?, channelOverride?, expected?, allowDestructive?, destructiveChannel? })` | `MPP-10`–`12`, `14` free; `MPP-13` when `allowDestructive` is set | `MPP-13` **permanently closes the channel** |

`expected` is `Partial<{ token, from, to, refundWaitingPeriod }>` — `MPP-10`'s on-chain parameter assertions. `channelOverride` asserts which channel to inspect; the target's own 402 challenge is authoritative, so a mismatch fails `MPP-10` rather than silently inspecting two contracts.

### Reporting

| Export | Signature |
|---|---|
| `CheckResult` | `{ id, name, pass, detail, skipped?, skipReason?, destructive?, error? }` |
| `checkStatus(result)` | → `"PASS" \| "FAIL" \| "ERROR" \| "SKIP"` |
| `summarize(results)` | → `{ passed, failed, errored, skipped, exitCode }` — `exitCode` is `0 \| 1 \| 2`, shared by both front ends so they can never disagree about the same run |
| `errored(id, name, error)` | Builds an `ERROR` result — mostly useful writing your own check |
| `skipped(id, name, reason)` | Builds a non-destructive `SKIP` result |
| `skippedDestructive(id, name, reason)` | Builds a `SKIP` result for a destructive check not opted into |

The full check catalogue — every check's exact pass criteria and spec reference — is in [`docs/CHECKS.md`](https://github.com/wasit-dev/wasit/blob/main/docs/CHECKS.md).

### Catalogue and structured output

| Export | What it is |
|---|---|
| `CHECK_CATALOGUE` | `readonly CheckCatalogueEntry[]` — every check the suite can run: `id`, `name`, `protocol`, `specRef`, a one-line `summary`, a `fix` saying what to change when it fails, and the optional flags `negative`, `destructive`, `costsFunds`. This is what `wasit checks` prints. |
| `fixFor(result)` | → `FailureGuidance \| undefined` — for a FAIL, `{ fix, docs }`: the result's own `hint` when it has one, else the catalogue `fix`, and the check's docs page. Undefined for anything that is not a FAIL. |
| `catalogueEntry(id)`, `docsUrlFor(id)` | Look up a check's catalogue entry, or its docs page on usewasit.dev |
| `PROTOCOL_IDS` | `readonly ProtocolId[]` — `"x402"`, `"mpp-charge"`, `"mpp-channel"` |
| `toStructuredRun(results)` | → `StructuredRun` — the machine-readable reshape of a run: `outcome`, per-status counts, and a `results` array of `StructuredCheckResult` (a FAIL also carries `fix` and `docs`). The CLI's `--json` and the MCP server's `structuredContent` are both this function's output verbatim, so the three surfaces cannot describe the same run differently. |

`outcome` is a name — `"conformant"`, `"non-conformant"`, `"no-verdict"` — not an exit code. `no-verdict` must never be read as `conformant`.

The catalogue is a short-form companion to [`docs/CHECKS.md`](https://github.com/wasit-dev/wasit/blob/main/docs/CHECKS.md), which stays the source of truth for pass criteria and spec citations.

### Errors

| Export | What it is |
|---|---|
| `ConfigurationError` | Something was wrong before any request went out — a malformed key, an invalid URL, an out-of-range argument |
| `TargetUnreachableError` | The request itself failed or timed out; no verdict about the target can be drawn from it |
| `MalformedResponseError` | The target answered, but not in a shape the check could read |
| `classifyCheckError(error)` | → `ClassifiedError` — maps an unknown throw to the `errorKind` (`"unreachable"`, `"configuration"`, `"harness"`) that appears in structured output |
| `assertHttpUrl(target)`, `fetchTarget(...)` | The URL guard and bounded fetch the checks themselves use |

### Testnet wallet helpers

A convenience layer for setting up the keys the check functions read. It is not part of the check surface, and it is exported by name rather than with `export *` so `wallet.ts` stays free to change without that being a breaking change to this package.

| Export | Signature |
|---|---|
| `publicKeyFromSecret(secretKey, source?)` | → `string`. `source` names the offending variable in the error message |
| `getTestnetWalletStatus(publicKey)` | → `Promise<WalletStatus>` — `{ publicKey, exists, balances }`; `exists` is false for an account never created on-chain |
| `generateTestnetWallet()` | → `GeneratedWallet` — a fresh keypair, unfunded |
| `generateCommitmentKey()` | → `GeneratedCommitmentKey` — a raw ed25519 seed for `COMMITMENT_SECRET_HEX`, which has no on-chain account and is not an `S...` key |
| `fundWithFriendbot(publicKey, attempts?)` | → `Promise<FriendbotOutcome>` — `"funded"` or `"already-funded"`. Two different claims: an account that already exists is a success, but no transfer happened |
| `createUsdcTrustline(secretKey, source?)` | → `Promise<void>` — opens the Circle testnet USDC trustline. A trustline is not a balance |
| `sendUsdcFromDistributor(distributorSecretKey, destinationPublicKey, amount)` | → `Promise<void>` — `amount` is a positive decimal string, at most 7 places |
| `testnetUsdcAsset()` / `TESTNET_USDC_ISSUER` | The Circle testnet USDC `Asset` and its issuer address |
| `describeTransactionError(error)` | → `string` — Horizon result codes formatted for a human |

**These throw; the check functions do not.** Every function above raises `ConfigurationError` or `TargetUnreachableError` rather than leaking a Stellar SDK error, with Horizon's result codes (`op_underfunded`, `op_no_trust`) folded into the message — so a caller renders `error.message` and never inspects an SDK error type. Horizon and Friendbot requests are bounded by a 15s timeout. A rejected secret key is never echoed back in the message.

There is deliberately no network parameter anywhere in this layer. Friendbot, the printed USDC issuer, and the whole idea of a disposable generated key only make sense on testnet.


## Design

- **`FAIL`, `ERROR`, and `SKIP` are different claims.** `FAIL` means the target answered and didn't conform. `ERROR` means no verdict was produced at all (unreachable, misconfigured, harness failure). `SKIP` is neither. Conflating "your service is broken" with "we never reached your service" would make a tool worse than no tool.
- **Destructive checks require an explicit opt-in** (`allowDestructive: true`), and even then only run against a channel the caller explicitly names as disposable — they never touch the channel under active test.
- Every dependency this package calls into (`@stellar/mpp`, `mppx`, `@stellar/stellar-sdk`, `@x402/*`) was verified against its **compiled** output, not just its published types, before any check was written against it.

## Related

- [Website](https://usewasit.dev)
- [`@wasit-dev/cli`](https://www.npmjs.com/package/@wasit-dev/cli) — terminal front end
- [`@wasit-dev/server`](https://www.npmjs.com/package/@wasit-dev/server) — MCP front end, for Claude Code and other agents
- [Full documentation](https://github.com/wasit-dev/wasit)

## License

Apache-2.0 — see [LICENSE](https://github.com/wasit-dev/wasit/blob/main/LICENSE).
