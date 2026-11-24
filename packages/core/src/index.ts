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
  paymentChecksSkipped,
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
export {
  COMMENT_MARKER,
  renderCheckRun,
  renderComment,
  renderNoReportCheckRun,
  renderNoReportComment,
  renderNoReportSummary,
  renderRunningComment,
  renderSummary,
} from "./ci-report.js";
export type { CheckRunOutput, RunningCommentInput } from "./ci-report.js";
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

export { MainnetJobRefusedError, assertMainnetJob, isLocalHost, mainnetJobRefusals, type MainnetJob } from "./guard/ci-mainnet.js";
// The mainnet payer's $10 and the lock of a mainnet run (spec B17.5): rules that only refuse; the opt-in and its plan call them.
export {
  MAINNET_PAYER_MAX_BASE_UNITS,
  MAINNET_PAYER_MAX_USD,
  MainnetPayerRefusedError,
  assertMainnetPayerBalance,
  type MainnetPayerAccount,
  type MainnetPayerRefusal,
} from "./guard/mainnet-payer.js";
export {
  MAINNET_RUN_LOCK_FILE,
  MainnetRunLockedError,
  acquireMainnetRunLock,
  type LockHolder,
  type MainnetRunLock,
} from "./guard/run-lock.js";
// L1's mainnet rules and the two reads on public Horizon (spec B3, B4, B17.2): rules that only refuse; the plan and the close call them.
export {
  MAINNET_ANCHOR_MAX_GAP_LEDGERS,
  MAINNET_MAX_TIMEOUT_SECONDS,
  MAINNET_USDC,
  MainnetPlanRefusedError,
  PUBNET_HORIZON_URL,
  assertAnchorNearHorizon,
  assertBalancesAgree,
  assertMainnetDecimals,
  assertMainnetOption,
  assertMainnetPin,
  horizonBalances,
  parseHorizonAmount,
  type ClassicAsset,
  type HorizonBalances,
  type MainnetOption,
  type MainnetPlanRefusal,
} from "./guard/mainnet-plan.js";
export { readHorizonAccount, readHorizonLatestLedger } from "./guard/horizon.js";
// The run ledger (spec B5): every signature's intent written before the key signs, then its outcome.
export {
  RUN_LEDGER_FORMAT,
  RunLedger,
  RunLedgerError,
  ledgerConsistency,
  openAuthorizationsUntil,
  runLedgerFileName,
  type LedgerBalances,
  type LedgerConsistency,
  type LedgerEntry,
  type LedgerEntryHandle,
  type LedgerEntryState,
  type LedgerResult,
  type LedgerVerdict,
  type PaymentLedger,
  type RunLedgerHeader,
} from "./guard/run-ledger.js";

// Which RPC a result read the chain through, and the MCP server's start-up RPC lock (D-023c).
export { RPC_LOCK_VARIABLE, describeRpcInUse, readRpcLock, rpcInUse } from "./guard/rpc-in-use.js";
export { RpcIdentityError, assertRpcServesNetwork } from "./guard/rpc-identity.js";
export type { RpcInUse, RpcSource } from "./guard/rpc-in-use.js";

// Which GitHub events may run the payment tier (D-022a), and which key variables are set.
export { githubDefaultBranch, inGithubActions, payerKeyVariables, paymentEventGate, readGithubEvent } from "./guard/ci-event.js";
export type { PaymentEventGate } from "./guard/ci-event.js";

// L1 and L2: the plan, and the caps every signature is charged against.
export {
  PER_PAYMENT_CAP_USD,
  PER_RUN_CAP_USD,
  PaymentGuardRefusedError,
  RunBudget,
  formatUsd,
} from "./guard/budget.js";
export type { GuardRefusal, PinTerms, PlannedSignature } from "./guard/budget.js";
export { describePlan, mainnetFirstLine, mainnetOpeningLine, planMainnetDryRun, planX402Run } from "./x402/plan.js";
export type {
  EndpointPlan,
  EndpointPlanStatus,
  MainnetDryRunOptions,
  MainnetFunding,
  MainnetReadings,
  PlannedOption,
  RunPlan,
  X402PlanOptions,
} from "./x402/plan.js";
// The mainnet opt-in (spec B5): made by openMainnetOptIn only, for one run. The type is exported, the class is not.
export {
  MAINNET_PAYER_KEY_ENV,
  MainnetRunRefusedError,
  closeMainnetRun,
  openMainnetOptIn,
  type MainnetCloseOptions,
  type MainnetCloseResult,
  type MainnetOptInInput,
  type MainnetRunRefusal,
} from "./guard/mainnet-run.js";
export type { MainnetFrontEnd, MainnetOptIn } from "./guard/optin.js";

export * from "./x402/simulator.js";
export * from "./mpp/channel.js";
export * from "./mpp/charge.js";
export * from "./mpp/charge-suite.js";
export * from "./mpp/suite.js";
export {
  MPP_CHARGE_SCHEME,
  assertMppPaymentRpc,
  combinePaymentPlan,
  describePaymentPlan,
  planMppChargeEndpoint,
  planPaymentRun,
  plannedChargeOf,
  type MppChargePlanInput,
  type PaymentRunPlanOptions,
} from "./mpp/plan.js";
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
