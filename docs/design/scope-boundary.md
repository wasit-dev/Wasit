# Scope Boundary

The useful axis is not "compliance versus security". It is **which artifact is
under test**.

Wasit tests a **running service**: what it answers over HTTP, and what appears
on-chain as a result. Contract source and bytecode are a different artifact,
tested by different tools — Scout, OpenZeppelin's detectors, and audit firms.
Wasit is complementary to those, not overlapping.

## What a passing result means

A passing Wasit run means: at the moment of the run, against the target given,
this service implemented the checked clauses of the x402/MPP specs correctly,
and its claimed settlements were confirmed on-chain.

## What it does not mean

- **Not a security clearance.** Wasit does not look for vulnerabilities in the
  contracts a service settles through, and cannot tell you whether a token
  contract is honest beyond the specific transfer it observed.
- **Not an audit.** No source is read. No bytecode is analysed.
- **Not a guarantee about other endpoints.** Only the target URL given was
  tested.
- **Not permanent.** A service can regress after passing.
- **Not exhaustive of the spec.** Only clauses with a catalogue entry are
  checked. Every entry traces to a written clause; clauses without an entry are
  simply not covered yet.

## Testnet only

Every check assumes testnet. `MPP-01`, `X402-06`, and `MPP-13` move real value,
and `MPP-13` destroys a channel. Nothing about the tool prevents a pubnet
network identifier from parsing, but pubnet deliberately has no default RPC
endpoint, so such a run must be configured deliberately rather than by accident.
A target cannot choose the network for the run either: the payment checks sign
only for the network the run names, and `MPP-01` refuses a challenge for any
other before anything is signed.

Do not run destructive or costly checks against infrastructure you do not own.

## The catalogue is the contract

Every check MUST reference a spec clause. A check that cannot be traced to a
written clause is out of scope by construction — that rule is what stops the
catalogue drifting into opinion about how services ought to behave.

Pass criteria in [../CHECKS.md](../CHECKS.md) are stated precisely enough to be
argued with. Where a criterion was revised, the revision and its reasoning are
recorded rather than quietly overwritten.
