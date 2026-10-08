export {
  checkStatus,
  errored,
  fixFor,
  skipped,
  skippedDestructive,
  summarize,
  toStructuredRun,
} from "./check.js";
export type {
  CheckResult,
  CheckStatus,
  FailureGuidance,
  RunSummary,
  StructuredCheckResult,
  StructuredRun,
} from "./check.js";

export { CHECK_CATALOGUE, PROTOCOL_IDS, catalogueEntry, docsUrlFor } from "./catalogue.js";
export type { CheckCatalogueEntry, ProtocolId } from "./catalogue.js";

export * from "./errors.js";

export * from "./x402/simulator.js";
export * from "./mpp/channel.js";
export * from "./mpp/charge.js";
export * from "./mpp/charge-suite.js";
export * from "./mpp/suite.js";
// Wallet tooling is exported by name rather than with `export *`: it is a
// convenience layer for setting up testnet keys, not part of the check
// surface, and naming each entry keeps the rest of wallet.ts free to change
// without that being a breaking change to @wasit-dev/core.
export {
  createUsdcTrustline,
  describeTransactionError,
  fundWithFriendbot,
  generateCommitmentKey,
  generateTestnetWallet,
  getTestnetWalletStatus,
  publicKeyFromSecret,
  sendUsdcFromDistributor,
  testnetUsdcAsset,
  TESTNET_USDC_ISSUER,
} from "./wallet.js";
export type {
  AssetBalance,
  FriendbotOutcome,
  GeneratedCommitmentKey,
  GeneratedWallet,
  WalletStatus,
} from "./wallet.js";

// Which networks the x402 payment checks pay on, and which payer key each
// reads: front ends pick the key by the run's network.
export { paymentChainFor, paymentNetworks } from "./x402/chains/index.js";
export type { PaymentChain } from "./x402/chains/index.js";
