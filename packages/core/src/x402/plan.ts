/**
 * L1, the plan (spec B3, B4): before anything is signed, read each endpoint's
 * unpaid challenge and work out what the run's payment checks would sign, and
 * refuse what the caps or the pin do not allow.
 *
 * The plan is what `--dry-run` prints, and what a paying run hands to each
 * endpoint's checks: L2 then refuses any signature the plan did not allow, so
 * a service that raises its price or changes its payee between the plan and
 * the payment gets a refusal, not a signature.
 *
 * It sends no payment, reads no key and signs nothing.
 *
 * A mainnet run (a live opt-in, spec B5) is planned by stricter rules: first
 * the token's decimals, the payer's USDC (through the RPC and on public
 * Horizon, $10 at most) and the RPC's latest ledger beside Horizon's are read,
 * before the target is asked anything; then every endpoint must plan, by the
 * mainnet rules. Any refusal stops the opt-in. A plan that passes is recorded
 * on it, and is the only plan its checks pay by.
 */

import { isLoopbackUrl } from "../config.js";
import { ConfigurationError } from "../errors.js";
import { sanitizeText } from "../sanitize.js";
import { readHorizonAccount, readHorizonLatestLedger } from "../guard/horizon.js";
import { assertMainnetPayerBalance } from "../guard/mainnet-payer.js";
import {
  MAINNET_USDC,
  MainnetPlanRefusedError,
  PUBNET_HORIZON_URL,
  assertAnchorNearHorizon,
  assertBalancesAgree,
  assertMainnetDecimals,
  assertMainnetOption,
  assertMainnetPin,
  paidUrlOf,
} from "../guard/mainnet-plan.js";
import { assertPaymentNetworkAllowed } from "../guard/networks.js";
import { MainnetRunRefusedError, anchorOfOptIn, isLiveOptIn, recordMainnetPlan, type MainnetOptIn } from "../guard/optin.js";
import {
  PER_PAYMENT_CAP_USD,
  PER_RUN_CAP_USD,
  PaymentGuardRefusedError,
  RunBudget,
  assertPinned,
  formatUsd,
  parseAmount,
  plannedSignatures,
  shown,
  usdAsset,
  usdFromBaseUnits,
  usdFromDollars,
  type PinTerms,
  type PlannedSignature,
} from "../guard/budget.js";
import { paymentChainFor } from "./chains/index.js";

const STELLAR_PUBNET = "stellar:pubnet";
import type { PaymentChain } from "./chains/types.js";
import { REJECTED_REQUEST_MAX_LIFETIME_SECONDS, REJECTED_REQUEST_MIN_LIFETIME_SECONDS, type RejectCase } from "./rejected-request.js";
import { readPaymentChallenge, type RequestShape } from "./simulator.js";

export interface PlanEndpointInput extends RequestShape {
  readonly name: string;
  readonly target: string;
  /** The request the service must refuse: X402-11 signs once more, when it can run. */
  readonly reject?: RejectCase;
}

export interface X402PlanOptions {
  readonly network: string;
  readonly pin?: PinTerms;
  /** A lower per-run cap in dollars. */
  readonly maxRunUsd?: number;
  readonly endpoints: readonly PlanEndpointInput[];
  /**
   * The run's mainnet opt-in (spec B5), made by `openMainnetOptIn`. On
   * `stellar:pubnet` the plan needs it; its pin and cap are the run's, and a
   * different pin or a `maxRunUsd` beside it is refused.
   */
  readonly mainnet?: MainnetOptIn;
}

/** What a mainnet plan read before it planned anything (spec B3, B4, B17.2, B17.5). */
export interface MainnetReadings {
  /** The payer's public address. */
  readonly payer: string;
  /** The token's decimals, read on chain. */
  readonly decimals: number;
  /** The payer's USDC in base units: the RPC's reading, equal to Horizon's. */
  readonly usdc: bigint;
  /** The payer's XLM in base units, as Horizon lists it. */
  readonly native: bigint;
  /** The RPC's latest ledger (the run's anchor) and Horizon's. */
  readonly rpcLatest: number;
  readonly horizonLatest: number;
  /** The two hosts a mainnet run contacts beside the service (B5 point 4), by origin. */
  readonly rpc: string;
  readonly horizon: string;
  /** What is left of the run's budget, in dollar units: the cap less what it already charged. */
  readonly remainingUsd: bigint;
}

/** The option an endpoint's checks would pay, as its challenge stated it. */
export interface PlannedOption {
  readonly scheme: string;
  readonly network: string;
  readonly payTo: string;
  readonly asset: string;
  /** Base units. */
  readonly amount: bigint;
  readonly maxTimeoutSeconds: number;
}

export type EndpointPlanStatus =
  /** Its payment checks would sign `signatures`. */
  | "planned"
  /** Its payment checks would not pay at all (no option to pay, an unreadable challenge): `reason`. */
  | "not-paid"
  /** The guard refuses to pay it: `reason`. */
  | "refused";

export interface EndpointPlan {
  readonly name: string;
  /**
   * Mainnet plans only: the one URL its payment checks pay, origin and path
   * (no query, no fragment), as the config names it. L2 refuses a payment
   * the service sends anywhere else.
   */
  readonly url?: string;
  readonly status: EndpointPlanStatus;
  readonly reason?: string;
  readonly option?: PlannedOption;
  readonly signatures: readonly PlannedSignature[];
  /** Base units of `option.asset`. */
  readonly worstCase: bigint;
  /** Dollar units of `guard/budget.ts`; format with `formatUsd`. */
  readonly worstCaseUsd: bigint;
}

/**
 * What a mainnet run needs the payer to hold (the payer's funds), in USDC base
 * units. Every endpoint settles once at X402-06 on a service that settles only
 * what it should; its later checks are then still signed for its price, so the
 * account must hold that much more. The minimum is the sum of the prices plus
 * the highest price again. A service that settles what it should refuse can
 * take up to the worst case.
 */
export interface MainnetFunding {
  /** The prices of the planned endpoints, added up. */
  readonly prices: bigint;
  /** The highest of them. */
  readonly highestPrice: bigint;
  /** `prices` + `highestPrice`: below it the run is refused. */
  readonly minimum: bigint;
  /** The run's own worst case (every signature counted as settled). */
  readonly worstCase: bigint;
  readonly decimals: number;
  /** The payer's USDC as the plan read it; absent in a dry run, which reads no balance. */
  readonly balance?: bigint;
  /** Set when the balance is at or above the minimum but below the worst case. */
  readonly warning?: string;
}

export interface RunPlan {
  readonly network: string;
  readonly pin?: PinTerms;
  readonly perPaymentCapUsd: bigint;
  readonly capUsd: bigint;
  /** Lowered by maxRunUsd. */
  readonly capLowered: boolean;
  readonly endpoints: readonly EndpointPlan[];
  /** The sum over the planned endpoints. */
  readonly worstCaseUsd: bigint;
  /** Set when the run must not start: its worst case is above its cap. Nothing was signed. */
  readonly refusal?: string;
  /** A mainnet plan only: what it read before planning. */
  readonly mainnet?: MainnetReadings;
  /** The dry run of a mainnet run (`planMainnetDryRun`): no key, so nothing of the payer was read. */
  readonly mainnetDryRun?: true;
  /** A mainnet plan, paying or dry run, with at least one planned endpoint: what the payer must hold. */
  readonly funding?: MainnetFunding;
}

function message(error: unknown): string {
  return sanitizeText(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ");
}

const nothing = (name: string, status: EndpointPlanStatus, reason: string, option?: PlannedOption): EndpointPlan => ({
  name,
  status,
  reason,
  ...(option === undefined ? {} : { option }),
  signatures: [],
  worstCase: 0n,
  worstCaseUsd: 0n,
});

/**
 * The URL rule of a mainnet endpoint, before it is asked anything: https, or
 * on this machine (a local service, as the validation runs one), and no user
 * name or password in it (they can hide which host it is). Returns where it
 * pays, origin and path.
 */
function mainnetEndpointUrl(target: string): string {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new MainnetPlanRefusedError("endpoint", "Its URL does not parse.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new MainnetPlanRefusedError(
      "endpoint",
      "Its URL carries a user name or password: a mainnet run pays a URL whose host is plain to read.",
    );
  }
  if (url.protocol !== "https:" && !isLoopbackUrl(target)) {
    throw new MainnetPlanRefusedError(
      "endpoint",
      `A mainnet run pays an https endpoint only, or one on this machine, and this one is ${url.protocol.replace(/:$/, "")} on ${url.host}.`,
    );
  }
  return paidUrlOf(target);
}

async function planEndpoint(
  network: string,
  pin: PinTerms | undefined,
  endpoint: PlanEndpointInput,
  mainnet: boolean,
): Promise<EndpointPlan> {
  if (!mainnet) return planEndpointTerms(network, pin, endpoint, undefined);
  let url: string;
  try {
    url = mainnetEndpointUrl(endpoint.target);
  } catch (error) {
    if (error instanceof MainnetPlanRefusedError) return nothing(endpoint.name, "refused", message(error));
    throw error;
  }
  return { ...(await planEndpointTerms(network, pin, endpoint, url)), url };
}

async function planEndpointTerms(
  network: string,
  pin: PinTerms | undefined,
  endpoint: PlanEndpointInput,
  url: string | undefined,
): Promise<EndpointPlan> {
  const mainnet = url !== undefined;
  let read;
  try {
    read = await readPaymentChallenge({ ...endpoint, network });
  } catch (error) {
    // The same reasons the payment checks give when they would not pay.
    return nothing(endpoint.name, "not-paid", message(error));
  }
  const { paymentRequired, selected } = read;
  try {
    // A mainnet endpoint pays the URL in the config, not one a redirect leads to.
    if (url !== undefined && paidUrlOf(read.payUrl) !== url) {
      throw new MainnetPlanRefusedError(
        "endpoint",
        `It answers through a redirect to ${shown(paidUrlOf(read.payUrl))}: a mainnet run pays the URL in the config only.`,
      );
    }
    assertPinned(network, paymentRequired.accepts, pin);
    const amount = parseAmount(selected.amount);
    const option: PlannedOption = {
      scheme: selected.scheme,
      network: selected.network,
      payTo: selected.payTo,
      asset: selected.asset,
      amount,
      maxTimeoutSeconds: selected.maxTimeoutSeconds,
    };
    // Exact, on stellar:pubnet, in USDC, valid for at most 300 s (B3).
    if (mainnet) assertMainnetOption(selected);
    const asset = usdAsset(network, selected.asset);
    const price = RunBudget.valueOf(network, selected.asset, amount);
    if (asset === undefined || price === undefined) {
      return nothing(
        endpoint.name,
        "refused",
        `it asks to be paid in an asset Wasit does not value in US dollars, so it cannot be held to the ` +
          `$${PER_PAYMENT_CAP_USD}.00 cap. Nothing was signed.`,
        option,
      );
    }
    const perPayment = usdFromDollars(PER_PAYMENT_CAP_USD);
    if (price > perPayment) {
      return nothing(
        endpoint.name,
        "refused",
        `it is priced at ${amount} base units of ${asset.symbol} (${formatUsd(price)}), above the ` +
          `${formatUsd(perPayment)} per payment fixed in Wasit. Nothing was signed. Test a route ` +
          `priced at ${formatUsd(perPayment)} or less.`,
        option,
      );
    }
    // X402-11 signs only when it can reach a verdict: a reject case, a chain whose
    // authorizations can be read, a lifetime it waits out (D-032).
    const rejectedRequest =
      endpoint.reject !== undefined &&
      paymentChainFor(network)?.authorizations !== undefined &&
      selected.maxTimeoutSeconds >= REJECTED_REQUEST_MIN_LIFETIME_SECONDS &&
      selected.maxTimeoutSeconds <= REJECTED_REQUEST_MAX_LIFETIME_SECONDS;
    const signatures = plannedSignatures(amount, { rejectedRequest });
    const worstCase = signatures.reduce((sum, entry) => sum + entry.amount, 0n);
    return {
      name: endpoint.name,
      status: "planned",
      option,
      signatures,
      worstCase,
      worstCaseUsd: RunBudget.valueOf(network, selected.asset, worstCase) ?? 0n,
    };
  } catch (error) {
    if (error instanceof PaymentGuardRefusedError || error instanceof MainnetPlanRefusedError) {
      return nothing(endpoint.name, "refused", message(error));
    }
    throw error;
  }
}

/**
 * The plan of a run's x402 payment checks. Throws the guard's refusal for a
 * network that is not a test network (L0), before any request; the mainnet
 * plan (the payer's balance, the token's decimals read on chain, the
 * authorization lifetime) is part of the opt-in, not of this version.
 */
export async function planX402Run(options: X402PlanOptions): Promise<RunPlan> {
  if (options.mainnet !== undefined) return planMainnetRun(options, options.mainnet);
  assertPaymentNetworkAllowed("x402", options.network);
  const budget = new RunBudget(options.maxRunUsd === undefined ? {} : { maxRunUsd: options.maxRunUsd });
  const capLowered = budget.capUsd < usdFromDollars(PER_RUN_CAP_USD);

  const endpoints: EndpointPlan[] = [];
  for (const endpoint of options.endpoints) {
    endpoints.push(await planEndpoint(options.network, options.pin, endpoint, false));
  }
  const planned = endpoints.filter((endpoint) => endpoint.status === "planned");
  const worstCaseUsd = planned.reduce((sum, endpoint) => sum + endpoint.worstCaseUsd, 0n);

  const base = {
    network: options.network,
    ...(options.pin === undefined ? {} : { pin: options.pin }),
    perPaymentCapUsd: usdFromDollars(PER_PAYMENT_CAP_USD),
    capUsd: budget.capUsd,
    capLowered,
    endpoints,
    worstCaseUsd,
  };
  if (worstCaseUsd <= budget.capUsd) return base;

  const parts = planned.map((endpoint) => `${sanitizeText(endpoint.name)} ${formatUsd(endpoint.worstCaseUsd)}`);
  return {
    ...base,
    refusal:
      `This run could spend up to ${formatUsd(worstCaseUsd)} (${parts.join(", ")}), above the ` +
      `${formatUsd(budget.capUsd)} per run${capLowered ? " set by maxRunUsd" : ""}. Nothing was signed. ` +
      `Select fewer endpoints with --endpoint, or test a cheaper route.`,
  };
}

/** Public Horizon, as a mainnet plan reads it; tests point it at a stand-in. */
let pubnetHorizon = PUBNET_HORIZON_URL;

/** Tests only: where a mainnet plan reads Horizon; undefined puts back the public one. Not exported from the package. */
export function setPubnetHorizonForTesting(base: string | undefined): void {
  pubnetHorizon = base ?? PUBNET_HORIZON_URL;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "the RPC";
  }
}

/**
 * The reads of a mainnet plan, in this order, each refusing on its own: the
 * token's decimals (7); the payer's USDC through the RPC ($10 at most); the
 * payer's balances on public Horizon (USDC equal to the RPC's); the RPC's
 * latest ledger beside Horizon's (12 apart at most), which becomes the run's
 * anchor. Nothing is sent to the target, and nothing is signed.
 */
async function readMainnet(optIn: MainnetOptIn, chain: PaymentChain): Promise<Omit<MainnetReadings, "remainingUsd">> {
  const { network, rpcUrl, payer } = optIn;
  const signedTerms = chain.signedTerms;
  const assetDecimals = chain.assetDecimals;
  if (signedTerms === undefined || assetDecimals === undefined) {
    throw new MainnetRunRefusedError("run", `The ${chain.name} adapter cannot read what a mainnet plan reads before it pays.`);
  }
  let decimals: unknown;
  try {
    decimals = await assetDecimals.call(chain, network, rpcUrl, MAINNET_USDC.asset);
  } catch {
    decimals = undefined;
  }
  assertMainnetDecimals(decimals);
  const usdc = await assertMainnetPayerBalance({
    network,
    payer,
    readBalance: () => chain.payerBalance(network, rpcUrl, payer, MAINNET_USDC.asset),
  });
  const horizon = await readHorizonAccount(pubnetHorizon, payer);
  assertBalancesAgree(usdc, horizon.usdc);
  let rpcLatest: unknown;
  try {
    rpcLatest = await signedTerms.latestUnit(network, rpcUrl);
  } catch {
    rpcLatest = undefined;
  }
  const horizonLatest = await readHorizonLatestLedger(pubnetHorizon);
  assertAnchorNearHorizon(rpcLatest as number, horizonLatest);
  anchorOfOptIn(optIn).set(rpcLatest as number);
  return {
    payer,
    decimals: decimals as number,
    usdc: usdc!,
    native: horizon.native,
    rpcLatest: rpcLatest as number,
    horizonLatest,
    rpc: originOf(rpcUrl),
    horizon: originOf(pubnetHorizon),
  };
}

/**
 * Why a mainnet run may not start on these endpoints, or undefined: one
 * endpoint that could not be planned keeps the whole run from starting (B4),
 * and so does a worst case above what is left of the budget.
 */
function mainnetRefusal(
  endpoints: readonly EndpointPlan[],
  worstCaseUsd: bigint,
  budget: { readonly capUsd: bigint; readonly spentUsd: bigint },
  capLowered: boolean,
): string | undefined {
  const unplanned = endpoints.filter((endpoint) => endpoint.status !== "planned");
  if (unplanned.length > 0) {
    const reasons = unplanned.map(
      (endpoint) =>
        `Endpoint ${sanitizeText(endpoint.name)} could not be planned: ` +
        `${(endpoint.reason ?? endpoint.status).replace(/\s*Nothing was signed\.?/g, "").trim().replace(/\.?$/, ".")}`,
    );
    return `This mainnet run does not start: it pays only endpoints it could plan. ${reasons.join(" ")} Nothing was signed.`;
  }
  const remainingUsd = budget.capUsd - budget.spentUsd;
  if (worstCaseUsd <= remainingUsd) return undefined;
  const parts = endpoints.map((endpoint) => `${sanitizeText(endpoint.name)} ${formatUsd(endpoint.worstCaseUsd)}`);
  const left =
    budget.spentUsd === 0n
      ? `the ${formatUsd(budget.capUsd)} per run`
      : `the ${formatUsd(remainingUsd)} left of the ${formatUsd(budget.capUsd)} per run`;
  return (
    `This run could spend up to ${formatUsd(worstCaseUsd)} (${parts.join(", ")}), above ${left}` +
    `${capLowered ? " set by maxRunUsd" : ""}. Nothing was signed. Select fewer endpoints, or test a cheaper route.`
  );
}

/** USDC base units as dollars, exactly ("$1.2733706"). */
function usdc(units: bigint, decimals: number): string {
  return formatUsd(usdFromBaseUnits(units, decimals));
}

/**
 * What the planned endpoints need the payer to hold; undefined when no
 * endpoint is planned. With `balance` (a paying run) it also says whether to
 * warn: at or above the minimum but below the worst case.
 */
function mainnetFunding(endpoints: readonly EndpointPlan[], decimals: number, balance?: bigint): MainnetFunding | undefined {
  const prices = endpoints.flatMap((endpoint) => (endpoint.status === "planned" && endpoint.option !== undefined ? [endpoint.option.amount] : []));
  if (prices.length === 0) return undefined;
  const sum = prices.reduce((total, price) => total + price, 0n);
  const highestPrice = prices.reduce((highest, price) => (price > highest ? price : highest), 0n);
  const minimum = sum + highestPrice;
  const worstCase = endpoints.reduce((total, endpoint) => total + (endpoint.status === "planned" ? endpoint.worstCase : 0n), 0n);
  const funding: MainnetFunding = { prices: sum, highestPrice, minimum, worstCase, decimals, ...(balance === undefined ? {} : { balance }) };
  if (balance === undefined || balance < minimum || balance >= worstCase) return funding;
  return {
    ...funding,
    warning:
      `Warning: the payer holds ${usdc(balance, decimals)}, less than this run's worst case of ${usdc(worstCase, decimals)}. ` +
      `A service that settles payments it should refuse can take more than the ${usdc(minimum, decimals)} this run needs: ` +
      `funds can be lost that way, and the later checks may then have too little left to run.`,
  };
}

/** The prices clause shared by the refusal, the funds line and the dry run's line. */
function fundingTerms(funding: MainnetFunding): string {
  const { decimals } = funding;
  return (
    `at least ${usdc(funding.minimum, decimals)} to finish its checks (the prices, ${usdc(funding.prices, decimals)}, ` +
    `plus the highest price again, ${usdc(funding.highestPrice, decimals)})`
  );
}

/** Why a paying mainnet run may not start for lack of funds, or undefined. */
function fundingRefusal(funding: MainnetFunding | undefined): string | undefined {
  if (funding?.balance === undefined || funding.balance >= funding.minimum) return undefined;
  const { decimals, balance } = funding;
  return (
    `This mainnet run does not start: the payer holds ${usdc(balance, decimals)} in USDC, and this run needs ` +
    `${fundingTerms(funding)}: ${usdc(funding.minimum - balance, decimals)} short. Nothing was signed. Add USDC to the ` +
    `payer (it may hold at most $10.00), or select fewer or cheaper endpoints.`
  );
}

export interface MainnetDryRunOptions {
  /** The config environment's pin: required, mainnet USDC to a valid payee. */
  readonly pin?: PinTerms;
  /** A lower per-run cap in dollars. */
  readonly maxRunUsd?: number;
  readonly endpoints: readonly PlanEndpointInput[];
}

/**
 * The dry run of a mainnet run on `stellar:pubnet` (spec B5): each endpoint's
 * unpaid challenge, by the mainnet rules (the URL, exact on pubnet, USDC, a
 * lifetime of at most 300 s, $1 a payment), against the caps. It needs no
 * opt-in because it signs nothing, and it reads no key, so nothing of the
 * payer is read: no balance, and no read of the chain, the RPC or Horizon. A
 * paying run makes those reads first, and refuses on any of them.
 */
export async function planMainnetDryRun(options: MainnetDryRunOptions): Promise<RunPlan> {
  const budget = new RunBudget(options.maxRunUsd === undefined ? {} : { maxRunUsd: options.maxRunUsd });
  const capLowered = budget.capUsd < usdFromDollars(PER_RUN_CAP_USD);
  const base = {
    network: STELLAR_PUBNET,
    ...(options.pin === undefined ? {} : { pin: options.pin }),
    perPaymentCapUsd: usdFromDollars(PER_PAYMENT_CAP_USD),
    capUsd: budget.capUsd,
    capLowered,
    mainnetDryRun: true as const,
  };
  try {
    // No key is read, so the payee is held to the payer's address only by the paying run.
    assertMainnetPin(options.pin, undefined);
  } catch (error) {
    if (error instanceof MainnetPlanRefusedError) {
      return { ...base, endpoints: [], worstCaseUsd: 0n, refusal: `This mainnet run does not start: ${message(error)}` };
    }
    throw error;
  }
  const endpoints: EndpointPlan[] = [];
  for (const endpoint of options.endpoints) {
    endpoints.push(await planEndpoint(STELLAR_PUBNET, options.pin, endpoint, true));
  }
  const worstCaseUsd = endpoints
    .filter((endpoint) => endpoint.status === "planned")
    .reduce((sum, endpoint) => sum + endpoint.worstCaseUsd, 0n);
  // No key, so no balance: the plan says what a paying run will hold the payer to.
  const funding = mainnetFunding(endpoints, MAINNET_USDC.decimals);
  const plan: RunPlan = { ...base, endpoints, worstCaseUsd, ...(funding === undefined ? {} : { funding }) };
  const refusal = mainnetRefusal(endpoints, worstCaseUsd, budget, capLowered);
  return refusal === undefined ? plan : { ...plan, refusal };
}

/**
 * L1 of a mainnet run: the reads, then each endpoint by the mainnet rules.
 * Every endpoint must plan, and the worst case must fit what is left of the
 * run's budget; otherwise the run is refused and the opt-in stopped. A plan
 * that passes is recorded on the opt-in, once.
 */
async function planMainnetRun(options: X402PlanOptions, optIn: MainnetOptIn): Promise<RunPlan> {
  if (options.network !== optIn.network) {
    throw new MainnetRunRefusedError("run", `A mainnet opt-in was handed to the plan of a run on another network than ${optIn.network}.`);
  }
  assertPaymentNetworkAllowed("x402", options.network, optIn);
  try {
    return await planLiveMainnetRun(options, optIn);
  } catch (error) {
    // Fail closed: whatever stops the plan stops the run, so it is never planned twice.
    optIn.stop((error as Error).message);
    throw error;
  }
}

async function planLiveMainnetRun(options: X402PlanOptions, optIn: MainnetOptIn): Promise<RunPlan> {
  if (optIn.plan !== undefined) throw new MainnetRunRefusedError("run", "The mainnet run already has a plan: it is planned once.");
  if (options.pin !== undefined && (options.pin.payTo !== optIn.pin.payTo || options.pin.asset !== optIn.pin.asset)) {
    throw new MainnetRunRefusedError("run", "The plan was handed another pin than the mainnet run's.");
  }
  if (options.maxRunUsd !== undefined) {
    throw new MainnetRunRefusedError("run", "A mainnet run's cap is set when it is opened; the plan takes no maxRunUsd.");
  }
  const chain = paymentChainFor(options.network);
  if (chain === undefined) throw new ConfigurationError(`No payment adapter pays on ${options.network}.`);

  const readings = await readMainnet(optIn, chain);

  const endpoints: EndpointPlan[] = [];
  for (const endpoint of options.endpoints) {
    endpoints.push(await planEndpoint(options.network, optIn.pin, endpoint, true));
  }
  const planned = endpoints.filter((endpoint) => endpoint.status === "planned");
  const worstCaseUsd = planned.reduce((sum, endpoint) => sum + endpoint.worstCaseUsd, 0n);
  const budget = optIn.budget;
  const remainingUsd = budget.capUsd - budget.spentUsd;
  const capLowered = budget.capUsd < usdFromDollars(PER_RUN_CAP_USD);
  // The payer's funds: the balance the plan read, held to what the run needs to finish its checks.
  const funding = mainnetFunding(endpoints, readings.decimals, readings.usdc);
  const plan: RunPlan = {
    network: options.network,
    pin: optIn.pin,
    perPaymentCapUsd: usdFromDollars(PER_PAYMENT_CAP_USD),
    capUsd: budget.capUsd,
    capLowered,
    endpoints,
    worstCaseUsd,
    mainnet: { ...readings, remainingUsd },
    ...(funding === undefined ? {} : { funding }),
  };

  // B4: on mainnet one endpoint that cannot be planned keeps the whole run from starting; then the cap; then the
  // payer's funds: a run that could not finish its checks does not start.
  const refusal = mainnetRefusal(endpoints, worstCaseUsd, budget, capLowered) ?? fundingRefusal(funding);
  if (refusal !== undefined) {
    optIn.stop(refusal);
    return { ...plan, refusal };
  }
  recordMainnetPlan(optIn, plan);
  return plan;
}

/**
 * The opening line of a mainnet run (spec B5: a mainnet run says so in its
 * first line): printed when the opt-in opens, before a service is started or
 * the target is asked anything. The network, real funds, the payer, the one
 * payee and the caps; the worst case comes with the plan
 * ({@link mainnetFirstLine}).
 */
export function mainnetOpeningLine(optIn: MainnetOptIn): string {
  if (!isLiveOptIn(optIn, STELLAR_PUBNET)) throw new ConfigurationError("Not a mainnet opt-in that is still open.");
  const { budget } = optIn;
  const remaining = budget.capUsd - budget.spentUsd;
  const cap =
    budget.spentUsd === 0n
      ? `at most ${formatUsd(budget.capUsd)} this run`
      : `at most ${formatUsd(remaining)} this run, what is left of the ${formatUsd(budget.capUsd)} cap`;
  return sanitizeText(
    `MAINNET RUN on ${optIn.network}: real funds. Payer ${optIn.payer}; pays only ${optIn.pin.payTo} in USDC; ` +
      `at most ${formatUsd(usdFromDollars(PER_PAYMENT_CAP_USD))} per payment; ${cap}. ` +
      `The plan is read next; nothing is signed before it passes.`,
  );
}

/**
 * The first line of every mainnet run (spec B5): the network, real funds, the
 * payer, the one payee, the caps and the run's worst case.
 */
export function mainnetFirstLine(plan: RunPlan): string {
  const mainnet = plan.mainnet;
  if (mainnet === undefined || plan.pin === undefined) throw new ConfigurationError("Not the plan of a mainnet run.");
  const left = mainnet.remainingUsd === plan.capUsd ? `the ${formatUsd(plan.capUsd)} cap` : `the ${formatUsd(mainnet.remainingUsd)} left of the ${formatUsd(plan.capUsd)} cap`;
  return sanitizeText(
    `MAINNET RUN on ${plan.network}: real funds. Payer ${mainnet.payer}; pays only ${plan.pin.payTo} in USDC; ` +
      `at most ${formatUsd(plan.perPaymentCapUsd)} per payment; this run could spend up to ${formatUsd(plan.worstCaseUsd)} of ${left}.`,
  );
}

/** The funds lines of a mainnet plan: the balance against the minimum and the worst case, and the warning. */
function fundingLines(plan: RunPlan): string[] {
  const funding = plan.funding;
  if (funding === undefined) return [];
  const { decimals, balance } = funding;
  const worst = usdc(funding.worstCase, decimals);
  if (balance === undefined) {
    return [
      `Mainnet dry run: a paying run also refuses when the payer holds less than ${usdc(funding.minimum, decimals)} in USDC ` +
        `(the prices, ${usdc(funding.prices, decimals)}, plus the highest price again, ${usdc(funding.highestPrice, decimals)}: ` +
        `what it needs to finish its checks), and warns below the worst case of ${worst}.`,
    ];
  }
  const margin =
    balance >= funding.minimum ? `${usdc(balance - funding.minimum, decimals)} above it` : `${usdc(funding.minimum - balance, decimals)} short`;
  return [
    `Mainnet: funds: the payer holds ${usdc(balance, decimals)} in USDC; this run needs ${fundingTerms(funding)}: ${margin}; ` +
      `worst case ${worst}.`,
    ...(funding.warning === undefined ? [] : [funding.warning]),
  ];
}

/**
 * The plan for a terminal or a log: the network, the caps, and per endpoint
 * the destination, the asset, the amount of each signature and the worst case.
 * Sanitised; no header value and no key (the plan holds neither).
 */
export function describePlan(plan: RunPlan): string[] {
  const lines = [
    `Plan (dry run): x402 payment checks on ${plan.network}. Nothing is signed or sent.`,
    `Caps: ${formatUsd(plan.perPaymentCapUsd)} a payment, ${formatUsd(plan.capUsd)} this run` +
      `${plan.capLowered ? " (maxRunUsd)" : ""}.`,
    ...(plan.pin === undefined ? [] : [`Pinned: payTo ${plan.pin.payTo}, asset ${plan.pin.asset}.`]),
    ...(plan.mainnet === undefined
      ? []
      : [
          `Mainnet: payer ${plan.mainnet.payer} holds ${formatUsd(usdFromBaseUnits(plan.mainnet.usdc, plan.mainnet.decimals))} in USDC ` +
            `(${plan.mainnet.usdc} base units, the RPC and public Horizon agree) and ${plan.mainnet.native} stroops of XLM.`,
          `Mainnet: hosts contacted beside the service: the RPC ${plan.mainnet.rpc} and public Horizon ${plan.mainnet.horizon}; ` +
            `latest ledger ${plan.mainnet.rpcLatest} (RPC) and ${plan.mainnet.horizonLatest} (Horizon).`,
        ]),
    ...(plan.mainnetDryRun === true
      ? [
          "Mainnet dry run: no key is read, so nothing of the payer was read. A paying mainnet run first reads, and refuses " +
            "on any of them: the payer's USDC through the RPC and on public Horizon (the two equal, $10.00 at most), the " +
            "token's decimals (7), and the RPC's latest ledger beside public Horizon's (12 apart at most).",
        ]
      : []),
    ...fundingLines(plan),
  ];
  for (const endpoint of plan.endpoints) {
    const at = endpoint.url === undefined ? "" : ` at ${endpoint.url}`;
    if (endpoint.status !== "planned" || endpoint.option === undefined) {
      lines.push(`  ${endpoint.name}${at}: ${endpoint.status === "refused" ? "refused" : "not paid"}: ${endpoint.reason ?? ""}`);
      continue;
    }
    const { option } = endpoint;
    lines.push(
      `  ${endpoint.name}${at}: pays ${shown(option.payTo)} in ${shown(option.asset)}, up to ${formatUsd(endpoint.worstCaseUsd)}`,
      `    ${endpoint.signatures.map((entry) => `${entry.check} ${entry.amount}`).join(", ")} (base units)`,
    );
  }
  lines.push(`Worst case: ${formatUsd(plan.worstCaseUsd)} of ${formatUsd(plan.capUsd)}.`);
  if (plan.refusal !== undefined) lines.push(`Refused: ${plan.refusal}`);
  return lines.map((line) => sanitizeText(line));
}
