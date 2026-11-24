/**
 * L1 for MPP-01 in `wasit run` (D-036): the charge an MPP charge endpoint asks
 * for, read from its unpaid challenge before anything in the run is signed,
 * held to the same caps as x402 ($1 a payment, one budget for the run), and
 * planned together with the run's x402 payment checks.
 *
 * MPP pays on test networks only (L0): a run on any other network is refused
 * here before any request. MPP-01 signs once per endpoint (mppx is built with
 * `maxPaymentRetries: 1`, `charge.ts`), so its plan is one signature of the
 * advertised amount. The channel checks sign commitments off-chain and Wasit
 * sends no transaction for them, so they are not planned.
 *
 * It sends no payment, reads no key and signs nothing. `x402/plan.ts` is not
 * changed by it: with no MPP charge endpoint the run's plan is the x402 plan
 * as it was.
 */

import { classifyCheckError } from "../errors.js";
import { sanitizeText } from "../sanitize.js";
import {
  PER_PAYMENT_CAP_USD,
  RunBudget,
  formatUsd,
  sameAddress,
  shown,
  usdAsset,
  usdFromDollars,
  type PinTerms,
} from "../guard/budget.js";
import { assertPaymentNetworkAllowed } from "../guard/networks.js";
import { RpcIdentityError, assertRpcServesNetwork } from "../guard/rpc-identity.js";
import { describePlan, planX402Run, type EndpointPlan, type PlanEndpointInput, type RunPlan } from "../x402/plan.js";
import { readChargeChallenge, type PlannedCharge } from "./charge.js";
import { assertMppNetwork, resolveRpcUrl } from "./network.js";

/** The scheme an MPP-01 entry of a plan carries, so the plan's other readers can tell it from x402. */
export const MPP_CHARGE_SCHEME = "mpp-charge";

const CHECK_ID = "MPP-01";

export interface MppChargePlanInput {
  readonly name: string;
  readonly target: string;
}

const nothing = (name: string, status: "not-paid" | "refused", reason: string): EndpointPlan => ({
  name,
  status,
  reason,
  signatures: [],
  worstCase: 0n,
  worstCaseUsd: 0n,
});

function message(error: unknown): string {
  return sanitizeText(classifyCheckError(error).message).replace(/\s+/g, " ");
}

/**
 * One MPP charge endpoint's plan: what MPP-01 would sign, or why it would not
 * pay ("not-paid": its challenge could not be read; "refused": the caps, the
 * pin or the network do not allow it).
 */
export async function planMppChargeEndpoint(
  network: string,
  endpoint: MppChargePlanInput,
  pin?: PinTerms,
): Promise<EndpointPlan> {
  // L0 before any request: MPP pays on test networks only, and on Stellar.
  assertPaymentNetworkAllowed("mpp-charge", network);
  assertMppNetwork(network);
  let challenge;
  try {
    challenge = await readChargeChallenge(endpoint.target);
  } catch (error) {
    // The same reason MPP-01 gives when it reads the challenge itself.
    return nothing(endpoint.name, "not-paid", message(error));
  }
  const { amount, currency, recipient } = challenge;
  if (challenge.network !== network) {
    return nothing(
      endpoint.name,
      "refused",
      `it asks to be paid on ${challenge.network}, and this run pays on ${network} only. Nothing was signed.`,
    );
  }
  if (pin !== undefined) {
    for (const [field, value, pinned] of [
      ["recipient", recipient, pin.payTo],
      ["currency", currency, pin.asset],
    ] as const) {
      if (!sameAddress(network, value, pinned)) {
        return nothing(
          endpoint.name,
          "refused",
          `its charge has ${field} ${shown(value)}, not the pinned ${pinned}. Nothing was signed.`,
        );
      }
    }
  }
  const asset = usdAsset(network, currency);
  const price = RunBudget.valueOf(network, currency, amount);
  if (asset === undefined || price === undefined) {
    return nothing(
      endpoint.name,
      "refused",
      `it asks to be paid in ${shown(currency)}, an asset Wasit does not value in US dollars, so it cannot be held ` +
        `to the $${PER_PAYMENT_CAP_USD}.00 cap. Nothing was signed.`,
    );
  }
  const perPayment = usdFromDollars(PER_PAYMENT_CAP_USD);
  if (price > perPayment) {
    return nothing(
      endpoint.name,
      "refused",
      `it is priced at ${amount} base units of ${asset.symbol} (${formatUsd(price)}), above the ` +
        `${formatUsd(perPayment)} per payment fixed in Wasit. Nothing was signed. Test a route priced at ` +
        `${formatUsd(perPayment)} or less.`,
    );
  }
  return {
    name: endpoint.name,
    status: "planned",
    option: { scheme: MPP_CHARGE_SCHEME, network, payTo: recipient, asset: currency, amount, maxTimeoutSeconds: 0 },
    signatures: [{ check: CHECK_ID, amount }],
    worstCase: amount,
    worstCaseUsd: price,
  };
}

/** What MPP-01 may pay for an endpoint of the plan, or undefined when the plan does not let it pay. */
export function plannedChargeOf(entry: EndpointPlan | undefined): PlannedCharge | undefined {
  if (entry?.status !== "planned" || entry.option?.scheme !== MPP_CHARGE_SCHEME) return undefined;
  return { amount: entry.option.amount, currency: entry.option.asset, recipient: entry.option.payTo };
}

/**
 * The x402 plan and the MPP-01 entries as one plan, against one cap: the
 * run's worst case is the sum, and a sum above the cap refuses the run before
 * anything is signed. With no MPP-01 entry it is the x402 plan, unchanged.
 * Pure.
 */
export function combinePaymentPlan(x402: RunPlan, mppCharge: readonly EndpointPlan[]): RunPlan {
  if (mppCharge.length === 0) return x402;
  const endpoints = [...x402.endpoints, ...mppCharge];
  const planned = endpoints.filter((endpoint) => endpoint.status === "planned");
  const worstCaseUsd = planned.reduce((sum, endpoint) => sum + endpoint.worstCaseUsd, 0n);
  const { refusal: _x402Refusal, ...rest } = x402;
  const plan: RunPlan = { ...rest, endpoints, worstCaseUsd };
  if (worstCaseUsd <= x402.capUsd) return plan;
  const parts = planned.map((endpoint) => `${sanitizeText(endpoint.name)} ${formatUsd(endpoint.worstCaseUsd)}`);
  return {
    ...plan,
    refusal:
      `This run could spend up to ${formatUsd(worstCaseUsd)} (${parts.join(", ")}), above the ` +
      `${formatUsd(x402.capUsd)} per run${x402.capLowered ? " set by maxRunUsd" : ""}. Nothing was signed. ` +
      `Select fewer endpoints with --endpoint, or test a cheaper route.`,
  };
}

export interface PaymentRunPlanOptions {
  readonly network: string;
  readonly pin?: PinTerms;
  /** A lower per-run cap in dollars. */
  readonly maxRunUsd?: number;
  /** The x402 endpoints this run pays. */
  readonly x402: readonly PlanEndpointInput[];
  /** The MPP charge endpoints this run pays. */
  readonly mppCharge: readonly MppChargePlanInput[];
}

/**
 * The plan of a paying run on a test network: its x402 payment checks
 * (`planX402Run`) and its MPP-01 payments, one cap for both. Throws the
 * guard's refusal for a network that is not a test network (L0), before any
 * request. Not for a mainnet run: that one pays x402 only, by its own plan.
 */
export async function planPaymentRun(options: PaymentRunPlanOptions): Promise<RunPlan> {
  if (options.mppCharge.length > 0) assertPaymentNetworkAllowed("mpp-charge", options.network);
  const x402 = await planX402Run({
    network: options.network,
    ...(options.pin === undefined ? {} : { pin: options.pin }),
    ...(options.maxRunUsd === undefined ? {} : { maxRunUsd: options.maxRunUsd }),
    endpoints: options.x402,
  });
  const mppCharge: EndpointPlan[] = [];
  for (const endpoint of options.mppCharge) {
    mppCharge.push(await planMppChargeEndpoint(options.network, endpoint, options.pin));
  }
  return combinePaymentPlan(x402, mppCharge);
}

/**
 * The RPC of a run that pays MPP, checked before its service starts or any
 * MPP endpoint is asked anything (D-023): it must serve the run's network,
 * and for MPP-01 it must be https, because the SDK's charge client builds the
 * payment through it and accepts no other. The suites check it again.
 *
 * @throws {RpcIdentityError} The RPC is not https for MPP-01, or does not serve the network.
 */
export async function assertMppPaymentRpc(network: string, rpcUrl: string | undefined, uses: { readonly charge: boolean }): Promise<void> {
  const endpoint = resolveRpcUrl(network, rpcUrl);
  if (uses.charge) {
    let protocol = "";
    try {
      protocol = new URL(endpoint).protocol;
    } catch {
      protocol = "";
    }
    if (protocol !== "https:") {
      throw new RpcIdentityError(
        `MPP-01 pays through @stellar/mpp's charge client, which builds the payment through the run's RPC and ` +
          `accepts only an https RPC, and this run's RPC is not https. No payment was sent and nothing was signed.`,
      );
    }
  }
  await assertRpcServesNetwork(network, endpoint);
}

/**
 * The plan for a terminal or a log, as `describePlan` prints it; when the run
 * pays MPP-01 too, its first line says so. `x402` and `mppCharge`: whether the
 * run has endpoints of each.
 */
export function describePaymentPlan(plan: RunPlan, has: { readonly x402: boolean; readonly mppCharge: boolean }): string[] {
  const lines = describePlan(plan);
  if (!has.mppCharge) return lines;
  const what = has.x402 ? "x402 payment checks and MPP-01" : "MPP-01";
  return [sanitizeText(`Plan (dry run): ${what} on ${plan.network}. Nothing is signed or sent.`), ...lines.slice(1)];
}
