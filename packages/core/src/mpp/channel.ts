import { type ChannelState, getChannelState } from "@stellar/mpp/channel/server";
import type { CheckResult } from "../check.js";
import { errored, skippedDestructive } from "../check.js";
import { CheckSetupError } from "../errors.js";
import { readChannelWithdrawn } from "./channel-commitment.js";
import {
  buildChannelCredential,
  fetchChannelChallenge,
  serializeChannelCredential,
  submitCredential,
} from "./channel-credential.js";
import { assertMppNetwork, networkPassphrase, resolveRpcUrl } from "./network.js";

export interface MppChannelDeployCheckOptions {
  channelContract: string;
  network: string; // e.g. "stellar:testnet"
  /** Overrides the default RPC endpoint, as every other channel check does. */
  rpcUrl?: string;
  expected: {
    token: string;
    from: string;
    to: string;
    refundWaitingPeriod: number;
  };
}

/**
 * MPP-10: The channel contract deploys correctly — its address is valid
 * and its on-chain state is queryable, and matches the parameters it was
 * opened with (token, funder, recipient, refund waiting period).
 */
export async function runMppChannelDeployChecks(
  options: MppChannelDeployCheckOptions,
): Promise<CheckResult[]> {
  let state;
  try {
    state = await getChannelState({
      channel: options.channelContract,
      network: assertMppNetwork(options.network),
      ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
    });
  } catch (err) {
    return [errored("MPP-10", "Channel Deploy", err)];
  }

  const mismatches: string[] = [];
  if (state.token !== options.expected.token) {
    mismatches.push(`token: expected ${options.expected.token}, got ${state.token}`);
  }
  if (state.from !== options.expected.from) {
    mismatches.push(`from: expected ${options.expected.from}, got ${state.from}`);
  }
  if (state.to !== options.expected.to) {
    mismatches.push(`to: expected ${options.expected.to}, got ${state.to}`);
  }
  if (state.refundWaitingPeriod !== options.expected.refundWaitingPeriod) {
    mismatches.push(
      `refundWaitingPeriod: expected ${options.expected.refundWaitingPeriod}, got ${state.refundWaitingPeriod}`,
    );
  }

  const pass = mismatches.length === 0;
  return [
    {
      id: "MPP-10",
      name: "Channel Deploy",
      pass,
      detail: pass
        ? `Channel ${options.channelContract} deployed and queryable — balance=${state.balance}, currentLedger=${state.currentLedger}.`
        : `Channel state mismatch: ${mismatches.join("; ")}.`,
    },
  ];
}

export interface MppChannelCheckOptions {
  /** URL of the paid resource on the target service. */
  target: string;
  /** Raw ed25519 commitment seed, hex. Must match the channel's commitment key. */
  commitmentSecretHex: string;
  /** CAIP-2 network id, e.g. "stellar:testnet". */
  network: string;
  /** Overrides the default RPC endpoint for the network. */
  rpcUrl?: string;
}

function failure(id: string, name: string, detail: string): CheckResult[] {
  return [{ id, name, pass: false, detail }];
}

/**
 * Attempts allowed when establishing the accepted commitment a check needs.
 *
 * One attempt is what turned a busy channel into a reported defect. Many
 * attempts would hide a target that always refuses valid vouchers. Three is
 * enough that ordinary contention clears, because every attempt re-reads the
 * cumulative from a freshly issued challenge, while a real refusal reproduces
 * on all of them.
 */
const SETUP_ATTEMPTS = 3;

/** What the target accepted, in the forms the probes that follow need it. */
interface AcceptedCommitment {
  /** The absolute cumulative the target accepted. */
  readonly amount: bigint;
  /** The exact credential accepted, for replaying it byte for byte. */
  readonly credential: string;
  /** The commitment signature, for re-presenting it against a new challenge. */
  readonly signature: string;
}

/**
 * Advances the channel's cumulative by exactly one request price.
 *
 * Every ordering and replay check needs this first: a commitment the target has
 * just accepted, so the probe that follows differs from it in exactly the one
 * respect the check is about. Reading the cumulative from a freshly issued
 * challenge on every attempt is what makes these checks re-runnable against a
 * channel with any prior history, and what lets a retry recover when another
 * payer advanced the cumulative mid-run.
 *
 * @throws {CheckSetupError} No attempt was accepted, so the check has no verdict.
 */
async function advanceCumulative(
  options: MppChannelCheckOptions,
): Promise<AcceptedCommitment> {
  const { target, commitmentSecretHex, network, rpcUrl } = options;
  const refusals: string[] = [];

  for (let attempt = 1; attempt <= SETUP_ATTEMPTS; attempt += 1) {
    const challenge = await fetchChannelChallenge(target);
    const amount = challenge.cumulativeAmount + challenge.requestedAmount;
    const { credential, signature } = await buildChannelCredential({
      challenge,
      amount,
      commitmentSecretHex,
      network,
      rpcUrl,
    });

    const submission = await submitCredential(target, credential);
    if (submission.status === 200) return { amount, credential, signature };

    refusals.push(
      `attempt ${attempt}: ${amount} refused with HTTP ${submission.status}: ` +
        `${submission.body}`,
    );
  }

  throw new CheckSetupError(
    `A correctly advancing commitment was refused ${SETUP_ATTEMPTS} times, each ` +
      `one signed against a freshly issued challenge, so this check never ` +
      `reached the rule it tests (${refusals.join("; ")}). Either the target ` +
      `refuses valid vouchers, which is a defect in its own right, or the ` +
      `channel's cumulative is being advanced by something else while this run ` +
      `is in progress. Re-run against a channel nothing else is paying through ` +
      `to tell the two apart.`,
  );
}

/**
 * MPP-11: A commitment that does not advance the cumulative must be rejected.
 *
 * The server applies two distinct rules (cumulativeMonotonicityError):
 *   (a) commitmentAmount >  previousCumulative
 *   (b) commitmentAmount >= previousCumulative + requestedAmount
 * Both are probed. Each probe fetches a FRESH challenge, so the challenge
 * replay guard — which runs earlier and returns the same HTTP 402 — cannot
 * fire and be mistaken for monotonicity enforcement.
 *
 * The check first advances the cumulative by exactly one request, which makes
 * it re-runnable against a channel with any prior history.
 */
export async function runMppChannelOrderingCheck(
  options: MppChannelCheckOptions,
): Promise<CheckResult[]> {
  const id = "MPP-11";
  const name = "Cumulative Commitment Ordering";
  const { target, commitmentSecretHex, network, rpcUrl } = options;

  try {
    const { amount: baseline } = await advanceCumulative(options);

    // (a) Exactly equal to the cumulative the server now holds.
    const equalChallenge = await fetchChannelChallenge(target);
    const equal = await submitCredential(
      target,
      (
        await buildChannelCredential({
          challenge: equalChallenge,
          amount: baseline,
          commitmentSecretHex,
          network,
          rpcUrl,
        })
      ).credential,
    );
    if (equal.status !== 402) {
      return failure(
        id,
        name,
        `A commitment equal to the current cumulative (${baseline}) was not rejected — ` +
          `expected HTTP 402, got ${equal.status}: ${equal.body}`,
      );
    }

    // (b) Advances, but does not cover this request's price. Only meaningful
    // when the price exceeds one base unit; otherwise it collapses into (a).
    const shortChallenge = await fetchChannelChallenge(target);
    if (shortChallenge.requestedAmount <= 1n) {
      return [
        {
          id,
          name,
          pass: true,
          detail:
            `Non-advancing commitment correctly rejected (HTTP 402). ` +
            `Under-covering sub-case not probed: the request price is ` +
            `${shortChallenge.requestedAmount} base unit, too small to distinguish it.`,
        },
      ];
    }

    const shortAmount = baseline + shortChallenge.requestedAmount - 1n;
    const short = await submitCredential(
      target,
      (
        await buildChannelCredential({
          challenge: shortChallenge,
          amount: shortAmount,
          commitmentSecretHex,
          network,
          rpcUrl,
        })
      ).credential,
    );
    if (short.status !== 402) {
      return failure(
        id,
        name,
        `A commitment that advances but under-covers the request price ` +
          `(${shortAmount} vs required ${baseline + shortChallenge.requestedAmount}) ` +
          `was not rejected — expected HTTP 402, got ${short.status}: ${short.body}`,
      );
    }

    return [
      {
        id,
        name,
        pass: true,
        detail:
          `Both ordering rules enforced: a commitment equal to the cumulative ` +
          `(${baseline}) and one that under-covers the price (${shortAmount}) ` +
          `were each rejected with HTTP 402.`,
      },
    ];
  } catch (error) {
    return [errored(id, name, error)];
  }
}

/**
 * MPP-12: Resubmitting an identical credential must be rejected.
 *
 * Targets the challenge replay guard specifically: the credential replayed is
 * byte-identical to one the server accepted moments earlier, so its signature
 * and amount are already proven valid and only the challenge-ID claim can
 * account for the rejection.
 */
export async function runMppChannelReplayCheck(
  options: MppChannelCheckOptions,
): Promise<CheckResult[]> {
  const id = "MPP-12";
  const name = "Challenge Replay Rejection";
  const { target } = options;

  try {
    const { credential } = await advanceCumulative(options);

    const replay = await submitCredential(target, credential);
    if (replay.status !== 402) {
      return failure(
        id,
        name,
        `An identical credential was accepted twice — expected HTTP 402 on replay, ` +
          `got ${replay.status}: ${replay.body}. This is a double-spend.`,
      );
    }

    return [
      {
        id,
        name,
        pass: true,
        detail: `Byte-identical credential correctly rejected on replay (HTTP 402).`,
      },
    ];
  } catch (error) {
    return [errored(id, name, error)];
  }
}

/**
 * MPP-14: A captured commitment must not be redeemable against a new challenge.
 *
 * The realistic double-spend: an observer lifts a valid (amount, signature)
 * pair off the wire, requests a fresh challenge of their own, and re-presents
 * the captured commitment. The challenge replay guard cannot help — the
 * challenge ID is new — so only the cumulative rule stands between the attacker
 * and a second delivery. The official client cannot express this, because it
 * re-signs on every call.
 */
export async function runMppChannelCommitmentReplayCheck(
  options: MppChannelCheckOptions,
): Promise<CheckResult[]> {
  const id = "MPP-14";
  const name = "Commitment Replay Rejection";
  const { target } = options;

  try {
    const { amount, signature } = await advanceCumulative(options);

    // Fresh challenge, same commitment. The signature is still cryptographically
    // valid; only the cumulative rule can reject it.
    const fresh = await fetchChannelChallenge(target);
    const replay = await submitCredential(
      target,
      serializeChannelCredential({ challenge: fresh, amount, signature }),
    );
    if (replay.status !== 402) {
      return failure(
        id,
        name,
        `A captured commitment (${amount}) was redeemed a second time against a ` +
          `fresh challenge — expected HTTP 402, got ${replay.status}: ${replay.body}. ` +
          `This is a double-spend.`,
      );
    }

    return [
      {
        id,
        name,
        pass: true,
        detail:
          `Captured commitment (${amount}) correctly rejected when re-presented ` +
          `against a fresh challenge (HTTP 402).`,
      },
    ];
  } catch (error) {
    return [errored(id, name, error)];
  }
}

export interface MppChannelCloseCheckOptions extends MppChannelCheckOptions {
  /**
   * Contract address the operator intends to destroy. The check refuses to run
   * unless the target's challenge advertises exactly this channel, so pointing
   * a destructive run at the wrong service closes nothing.
   */
  expectedChannel?: string;
  allowDestructive?: boolean;
  closePollAttempts?: number;
  closePollDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runMppChannelCloseCheck(
  options: MppChannelCloseCheckOptions,
): Promise<CheckResult[]> {
  const id = "MPP-13";
  const name = "Close Settlement";
  const {
    target,
    commitmentSecretHex,
    network,
    rpcUrl,
    expectedChannel,
    allowDestructive = false,
    closePollAttempts = 6,
    closePollDelayMs = 2_000,
  } = options;

  if (!allowDestructive) {
    return [
      skippedDestructive(
        id,
        name,
        "closing settles the channel on-chain and permanently ends it. " +
          "Re-run with destructive checks enabled, against a channel you own.",
      ),
    ];
  }

  if (!expectedChannel) {
    return failure(
      id,
      name,
      "Destructive checks are enabled but no expected channel was named. " +
        "Name the channel you intend to close, so a misconfigured target " +
        "cannot close a different one.",
    );
  }

  try {
    const challenge = await fetchChannelChallenge(target);
    const channel = challenge.channelContract;

    // The target decides which channel it bills through, so the address in the
    // challenge is the one that would actually be closed. Refusing on mismatch
    // is what makes naming the channel a safeguard rather than a formality.
    if (channel !== expectedChannel) {
      return failure(
        id,
        name,
        `Refusing to close: ${target} bills through channel ${channel}, but the ` +
          `run named ${expectedChannel} as the channel to destroy. Point the ` +
          `target at the intended channel, or correct the expected address.`,
      );
    }

    const readState = (): Promise<ChannelState> =>
      getChannelState({
        channel,
        network: assertMppNetwork(network),
        ...(rpcUrl ? { rpcUrl } : {}),
      });

    const before = await readState();
    if (before.closeEffectiveAtLedger !== null) {
      return failure(
        id,
        name,
        `Channel ${channel} is already closing or closed ` +
          `(closeEffectiveAtLedger=${before.closeEffectiveAtLedger}). ` +
          `This check needs a channel that is still open.`,
      );
    }

    const amount = challenge.cumulativeAmount + challenge.requestedAmount;
    const { credential } = await buildChannelCredential({
      challenge,
      amount,
      commitmentSecretHex,
      network,
      rpcUrl,
      action: "close",
    });

    const closed = await submitCredential(target, credential);
    if (closed.status !== 200) {
      return failure(
        id,
        name,
        `Close credential (${amount}) was not accepted — expected HTTP 200, ` +
          `got ${closed.status}: ${closed.body}`,
      );
    }

    let after: ChannelState | undefined;
    for (let attempt = 0; attempt < closePollAttempts; attempt += 1) {
      after = await readState();
      if (after.closeEffectiveAtLedger !== null) break;
      await sleep(closePollDelayMs);
    }

    if (!after || after.closeEffectiveAtLedger === null) {
      return failure(
        id,
        name,
        `Server reported the close succeeded, but on-chain state still shows ` +
          `the channel open after ${closePollAttempts} polls. The settlement ` +
          `was not observable on-chain.`,
      );
    }

    // The channel always ends at zero: close pays the commitment to the
    // recipient and auto-refunds whatever is left to the funder. So the balance
    // delta proves nothing. `withdrawn` is the real evidence — the contract
    // records it in the same call that transfers the payout, and that transfer
    // is non-fallible, so a mismatch there would have reverted the whole close.
    const withdrawn = await readChannelWithdrawn({
      channelContract: channel,
      networkPassphrase: networkPassphrase(network),
      rpcUrl: resolveRpcUrl(network, rpcUrl),
    });

    if (withdrawn !== amount) {
      return failure(
        id,
        name,
        `Channel closed (closeEffectiveAtLedger=${after.closeEffectiveAtLedger}), ` +
          `but the contract recorded ${withdrawn} withdrawn instead of the ` +
          `committed ${amount}. The payout did not match the commitment.`,
      );
    }

    return [
      {
        id,
        name,
        pass: true,
        destructive: true,
        detail:
          `Close settled on-chain: the contract recorded exactly the committed ` +
          `${amount} as withdrawn, and closeEffectiveAtLedger is set to ` +
          `${after.closeEffectiveAtLedger}. Channel balance went from ` +
          `${before.balance} to ${after.balance}; the remainder was auto-refunded ` +
          `to the funder, which is the contract's designed close behaviour. ` +
          `Channel ${channel} is now permanently closed.`,
      },
    ];
  } catch (error) {
    return [errored(id, name, error)];
  }
}
