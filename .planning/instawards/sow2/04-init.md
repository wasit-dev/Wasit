# Job 04 — `wasit init` and the test-network key setup

Status: ⬜ **NOT STARTED** · Deliverable: **D3** · Week: **3** · Depends on: #2

## Goal

A setup command for a builder's own x402 or MPP service. It asks for the service
URL and asks the builder to confirm they operate it; reads the service's 402
answer to tell x402 from MPP and to fill in the network, price, asset and
receiving address (for an MPP channel, the channel the service bills through);
asks for the method and the request body; says plainly when the paywall is not
switched on (an answer of 200, 500 or 503 instead of 402); and writes
`wasit.config.json`, the same file the Action reads.

On Stellar testnet it can also set up the keys the checks need: a funded testnet
payer for x402 and for MPP charge (test XLM, a USDC trustline and test USDC), and
the commitment key for MPP channel. Keys stay in `.env`, are never printed, and
`init` checks that git ignores `.env`. On the other test networks it fills in the
config and points to the faucet. For a service on mainnet it fills in the config
but never creates, funds or reads a mainnet key, and never switches the opt-in on.
It never enables MPP-13.

## Design rules decided for it

- The config writer takes only data that is certain: a network must be a known test network, "I operate this service" must be explicitly true, and the result is checked by the same loader `wasit run` uses before anything is written.
- When something is not given, the command applies an explicit fallback and prints it: for the network, `network: stellar:testnet (default; init does not read the network from your service)`.
- An existing `wasit.config.json` is never overwritten silently.

## Acceptance criteria

- [ ] `wasit init` on a fresh x402 project and on a fresh MPP project writes a config that the Action and a local run both accept.
- [ ] Reading the 402 answer, including the paywall-off messages for 200, 500 and 503.
- [ ] The test-network key setup, with an independent review of it.
- [ ] A short recording of `init` on both projects, from the first question to the written config and a first read-only run.

## Result

Not started.
