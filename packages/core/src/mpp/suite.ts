/**
 * Orchestration for the MPP channel-mode suite.
 *
 * This lives in core rather than in a front end so that the CLI and the MCP
 * server run the same checks, in the same order, under the same guards. A
 * second front end reimplementing this is how the two would silently drift.
 */

import { errored, skipped, type CheckResult } from "../check.js";
import { assertHttpUrl, classifyCheckError } from "../errors.js";
import {
  runMppChannelCloseCheck,
  runMppChannelCommitmentReplayCheck,
  runMppChannelDeployChecks,
  runMppChannelOrderingCheck,
  runMppChannelReplayCheck,
} from "./channel.js";
import { fetchChannelChallenge } from "./channel-credential.js";
import { assertMppNetwork, resolveRpcUrl } from "./network.js";
import { assertPaymentNetworkAllowed } from "../guard/networks.js";
import { assertRpcServesNetwork } from "../guard/rpc-identity.js";

const DEPLOY_ID = "MPP-10";
const DEPLOY_NAME = "Channel Deploy";

/** On-chain parameters MPP-10 asserts. Only the channel's operator knows these. */
export interface ChannelDeployExpectations {
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly refundWaitingPeriod: number;
}

export interface MppChannelSuiteOptions {
  readonly target: string;
  readonly commitmentSecretHex: string;
  readonly network: string;
  readonly rpcUrl?: string;
  /**
   * Asserts which channel MPP-10 should inspect. The target is authoritative:
   * when it advertises a different channel the run fails rather than reporting
   * on two contracts at once.
   */
  readonly channelOverride?: string;
  readonly expected?: Partial<ChannelDeployExpectations>;
  readonly allowDestructive?: boolean;
  readonly destructiveChannel?: string;
  /**
   * Called once per check as soon as its result is known, in addition to it
   * being included in the returned array — lets a caller render progress
   * live instead of waiting for the whole suite to finish. Optional and has
   * no effect on what is returned.
   */
  readonly onResult?: (result: CheckResult) => void;
}

function missingExpectations(
  expected: Partial<ChannelDeployExpectations> | undefined,
): string[] {
  return [
    typeof expected?.token === "string" && expected.token.length > 0 ? null : "token",
    typeof expected?.from === "string" && expected.from.length > 0 ? null : "from",
    typeof expected?.to === "string" && expected.to.length > 0 ? null : "to",
    typeof expected?.refundWaitingPeriod === "number" &&
    Number.isInteger(expected.refundWaitingPeriod)
      ? null
      : "refundWaitingPeriod",
  ].filter((entry): entry is string => entry !== null);
}

function isComplete(
  expected: Partial<ChannelDeployExpectations> | undefined,
): expected is ChannelDeployExpectations {
  return missingExpectations(expected).length === 0;
}

interface DeployParams {
  readonly network: string;
  readonly rpcUrl?: string;
  /** Channel the target says it bills through, when it could be read. */
  readonly advertised?: string;
  /** Why the advertised channel could not be read. */
  readonly advertisedFailure?: string;
  readonly channelOverride?: string;
  readonly expected?: Partial<ChannelDeployExpectations>;
}

async function runDeployCheck(params: DeployParams): Promise<CheckResult[]> {
  const { network, rpcUrl, advertised, advertisedFailure, channelOverride, expected } =
    params;

  if (advertised && channelOverride && advertised !== channelOverride) {
    return [
      {
        id: DEPLOY_ID,
        name: DEPLOY_NAME,
        pass: false,
        detail:
          `Channel mismatch: the target bills through ${advertised}, but this run ` +
          `named ${channelOverride}. Inspecting the named channel would report on a ` +
          `different contract than the rest of the suite, so nothing was inspected. ` +
          `Drop the override to use the advertised channel, or point the target at ` +
          `the intended one.`,
      },
    ];
  }

  const channel = advertised ?? channelOverride;
  if (!channel) {
    return [
      skipped(
        DEPLOY_ID,
        DEPLOY_NAME,
        `the channel the target advertises could not be read ` +
          `(${advertisedFailure ?? "unknown error"}), and no channel was named to ` +
          `inspect instead.`,
      ),
    ];
  }

  if (!isComplete(expected)) {
    return [
      skipped(
        DEPLOY_ID,
        DEPLOY_NAME,
        `expected on-chain parameters not supplied ` +
          `(${missingExpectations(expected).join(", ")}).`,
      ),
    ];
  }

  const results = await runMppChannelDeployChecks({
    channelContract: channel,
    network,
    ...(rpcUrl ? { rpcUrl } : {}),
    expected,
  });

  if (advertised) return results;

  // Inspected an operator-supplied address without being able to confirm it is
  // the one the target bills through. Say so, rather than letting the result
  // read as though the two were checked against each other.
  return results.map((result) => ({
    ...result,
    detail:
      `${result.detail} Note: the target's advertised channel could not be read ` +
      `(${advertisedFailure ?? "unknown error"}), so ${channel} came from this run's ` +
      `own configuration and is unverified against the target.`,
  }));
}

/**
 * Runs MPP-10 through MPP-14 against a target.
 *
 * The channel under test is resolved once, from the target's own challenge,
 * so every check in the run reports on the same contract. MPP-13 runs last
 * because a close is terminal.
 */
export async function runMppChannelSuite(
  options: MppChannelSuiteOptions,
): Promise<CheckResult[]> {
  const {
    target,
    commitmentSecretHex,
    network,
    rpcUrl,
    channelOverride,
    expected,
    allowDestructive = false,
    destructiveChannel,
  } = options;

  // A bad URL or an unknown network is wrong for every check in the suite, so
  // it is reported once here instead of repeated identically per check. L0
  // runs here too: the suite signs commitments and may close a channel, so a
  // network that is not a test network stops it before any request.
  try {
    assertHttpUrl(target);
    assertMppNetwork(network);
    assertPaymentNetworkAllowed("mpp-channel", network);
    // Commitments are prepared and the channel read through this endpoint: it
    // must serve the run's network before the target is asked anything (D-023).
    await assertRpcServesNetwork(network, resolveRpcUrl(network, rpcUrl));
  } catch (error) {
    const preflight = errored("PREFLIGHT", "Run Preflight", error);
    options.onResult?.(preflight);
    return [preflight];
  }

  const shared = {
    target,
    commitmentSecretHex,
    network,
    ...(rpcUrl ? { rpcUrl } : {}),
  };

  // The target decides which channel it bills through, so its challenge — not
  // the operator's environment — is the authority on what this run is about.
  let advertised: string | undefined;
  let advertisedFailure: string | undefined;
  try {
    advertised = (await fetchChannelChallenge(target)).channelContract;
  } catch (error) {
    advertisedFailure = classifyCheckError(error).message;
  }

  const results: CheckResult[] = [];

  // Pushes a batch into the run's results and reports each one to the
  // caller's live-progress hook, if any, in the same order.
  const record = (batch: CheckResult[]): void => {
    results.push(...batch);
    for (const result of batch) options.onResult?.(result);
  };

  record(
    await runDeployCheck({
      network,
      ...(rpcUrl ? { rpcUrl } : {}),
      ...(advertised ? { advertised } : {}),
      ...(advertisedFailure ? { advertisedFailure } : {}),
      ...(channelOverride ? { channelOverride } : {}),
      ...(expected ? { expected } : {}),
    }),
  );

  record(await runMppChannelOrderingCheck(shared));
  record(await runMppChannelReplayCheck(shared));
  record(await runMppChannelCommitmentReplayCheck(shared));

  // Last: a close is terminal, so nothing may run against the channel after it.
  record(
    await runMppChannelCloseCheck({
      ...shared,
      allowDestructive,
      ...(destructiveChannel ? { expectedChannel: destructiveChannel } : {}),
    }),
  );

  return results;
}
