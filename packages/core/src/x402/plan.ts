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
 */

import { sanitizeText } from "../sanitize.js";
import { assertPaymentNetworkAllowed } from "../guard/networks.js";
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
  usdFromDollars,
  type PinTerms,
  type PlannedSignature,
} from "../guard/budget.js";
import { paymentChainFor } from "./chains/index.js";
import { REJECTED_REQUEST_MAX_LIFETIME_SECONDS, type RejectCase } from "./rejected-request.js";
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
  readonly status: EndpointPlanStatus;
  readonly reason?: string;
  readonly option?: PlannedOption;
  readonly signatures: readonly PlannedSignature[];
  /** Base units of `option.asset`. */
  readonly worstCase: bigint;
  /** Dollar units of `guard/budget.ts`; format with `formatUsd`. */
  readonly worstCaseUsd: bigint;
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

async function planEndpoint(
  network: string,
  pin: PinTerms | undefined,
  endpoint: PlanEndpointInput,
): Promise<EndpointPlan> {
  let read;
  try {
    read = await readPaymentChallenge({ ...endpoint, network });
  } catch (error) {
    // The same reasons the payment checks give when they would not pay.
    return nothing(endpoint.name, "not-paid", message(error));
  }
  const { paymentRequired, selected } = read;
  try {
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
      selected.maxTimeoutSeconds > 0 &&
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
    if (error instanceof PaymentGuardRefusedError) return nothing(endpoint.name, "refused", message(error));
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
  assertPaymentNetworkAllowed("x402", options.network);
  const budget = new RunBudget(options.maxRunUsd === undefined ? {} : { maxRunUsd: options.maxRunUsd });
  const capLowered = budget.capUsd < usdFromDollars(PER_RUN_CAP_USD);

  const endpoints: EndpointPlan[] = [];
  for (const endpoint of options.endpoints) {
    endpoints.push(await planEndpoint(options.network, options.pin, endpoint));
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
  ];
  for (const endpoint of plan.endpoints) {
    if (endpoint.status !== "planned" || endpoint.option === undefined) {
      lines.push(`  ${endpoint.name}: ${endpoint.status === "refused" ? "refused" : "not paid"}: ${endpoint.reason ?? ""}`);
      continue;
    }
    const { option } = endpoint;
    lines.push(
      `  ${endpoint.name}: pays ${shown(option.payTo)} in ${shown(option.asset)}, up to ${formatUsd(endpoint.worstCaseUsd)}`,
      `    ${endpoint.signatures.map((entry) => `${entry.check} ${entry.amount}`).join(", ")} (base units)`,
    );
  }
  lines.push(`Worst case: ${formatUsd(plan.worstCaseUsd)} of ${formatUsd(plan.capUsd)}.`);
  if (plan.refusal !== undefined) lines.push(`Refused: ${plan.refusal}`);
  return lines.map((line) => sanitizeText(line));
}
