export {
  SKIP_KINDS,
  checkStatus,
  errored,
  fixFor,
  quoteValue,
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
  SkipKind,
  StructuredCheckResult,
  StructuredRun,
} from "./check.js";

// The one sanitiser: everything printed or written into a report passes through it.
export { MARKDOWN_VALUE_MAX, sanitizeForMarkdown, sanitizeText } from "./sanitize.js";
export type { MarkdownOptions, SanitizeOptions } from "./sanitize.js";

// wasit.config.json, version 1.
export {
  CONFIG_VERSION,
  ConfigError,
  describeRun,
  headerEnvName,
  headersFromEnv,
  isLoopbackUrl,
  joinTarget,
  parseConfig,
  readConfigFile,
  resolveRun,
  urlOrigin,
  validateConfig,
} from "./config.js";
export type {
  ChannelExpectation,
  ConfigIssue,
  EndpointConfig,
  EnvironmentConfig,
  JsonValue,
  PinConfig,
  ReadyConfig,
  RejectConfig,
  ResolvedEndpoint,
  ResolvedReject,
  ResolvedRun,
  RunSelection,
  ServiceConfig,
  WasitConfig,
} from "./config.js";

// The run report, the endpoint outcome and the versions a result names.
export {
  buildEndpointReport,
  buildRunReport,
  checkGroup,
  describeTotals,
  endpointOutcome,
  paymentGroupUnsupported,
  exitCodeForEndpoint,
  groupCounts,
  redactReport,
  redactValue,
  reportTotals,
  skippedPaymentChecks,
  toGradedRun,
} from "./report.js";
export type {
  CheckGroup,
  EndpointInput,
  EndpointOutcome,
  EndpointReport,
  GroupCounts,
  RunReport,
  RunReportInput,
  RunTotals,
} from "./report.js";
export { readBuildCommit, readPackageVersion, readToolVersions } from "./versions.js";
export type { ToolVersions } from "./versions.js";

// The baseline of the default branch, the diff against it, and the exit rule of a run.
export {
  HISTORY_LIMIT,
  MAX_BASELINE_BYTES,
  ReportFormatError,
  baselineProblem,
  diffReports,
  findRegressions,
  parseRunReport,
  readBaseline,
  recentFailures,
  selectBaseline,
  serializeBaseline,
  updateHistory,
} from "./baseline.js";
export type {
  Baseline,
  BaselineResult,
  Change,
  ChangeKind,
  History,
  RecentFailure,
  Regression,
} from "./baseline.js";
export { runExitCode } from "./verdict.js";
export type { RunVerdict } from "./verdict.js";

// The pull request comment and the job summary.
export { COMMENT_MARKER, renderComment, renderNoReportComment, renderNoReportSummary, renderSummary } from "./ci-report.js";
export type { CiReportInput } from "./ci-report.js";

// Variables kept away from a service Wasit starts, and values kept out of output.
export { DENIED_ENV_NAMES, deniedEnvValues, isDeniedEnvName, scrubEnv } from "./denied-env.js";

export { CHECK_CATALOGUE, PROTOCOL_IDS, catalogueEntry, docsUrlFor } from "./catalogue.js";
export type { CheckCatalogueEntry, ProtocolId } from "./catalogue.js";

export * from "./errors.js";

// L0, the network guard every signing entry point runs.
export {
  NETWORK_CLASSES,
  PaymentNetworkRefusedError,
  assertPaymentNetworkAllowed,
  networkClass,
} from "./guard/networks.js";
export type { NetworkClass, PaymentProtocol } from "./guard/networks.js";

// L1 and L2: the plan, and the caps every signature is charged against.
export {
  PER_PAYMENT_CAP_USD,
  PER_RUN_CAP_USD,
  PaymentGuardRefusedError,
  RunBudget,
  formatUsd,
} from "./guard/budget.js";
export type { GuardRefusal, PinTerms, PlannedSignature } from "./guard/budget.js";
export { describePlan, planX402Run } from "./x402/plan.js";
export type { EndpointPlan, EndpointPlanStatus, PlannedOption, RunPlan, X402PlanOptions } from "./x402/plan.js";

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
