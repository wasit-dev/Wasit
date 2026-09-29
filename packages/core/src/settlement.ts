/**
 * On-chain settlement verification, shared by every check that pays.
 *
 * A target's claim that it settled is only a claim. These helpers look the
 * referenced transaction up on Stellar RPC and read what the token contract
 * actually did from its `transfer` event, so MPP-01 and X402-06 hold every
 * target to the same standard, with the same reading of the event formats and
 * the same rules for when a missing transaction is the target's fault.
 */

import { Address, MuxedAccount, StrKey, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

/**
 * How long to look for the settled transaction.
 *
 * A fixed wall-clock wait cannot tell a transaction that does not exist from
 * an RPC that is behind, and reporting the second as the first blames the
 * target for our infrastructure. So the wait is measured in ledgers RPC has
 * closed: once it has closed this many more without the transaction, the
 * transaction is not coming. An RPC that stops advancing before then gives no
 * verdict at all.
 */
const LEDGERS_BEFORE_MISSING = 10;
const MAX_WAIT_MS = 120_000;
const POLL_DELAY_MS = 1_000;

/** What the token contract actually did, read from the settled transaction. */
export interface TransferEvent {
  readonly from: string;
  /** The destination's base address. CAP-67 never puts a muxed address in a topic. */
  readonly to: string;
  /**
   * The destination's multiplexing id, when the transfer went to a muxed
   * address (CAP-67). A `u64` id is kept as its decimal string; a memo-derived
   * string or bytes value is kept as given (bytes as hex).
   */
  readonly toMuxedId?: string;
  readonly amount: bigint;
  readonly contract: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads the amount, and the destination's muxed id if any, from a `transfer`
 * event's data.
 *
 * CAP-46 made the data a bare `i128` amount. CAP-67 keeps that when no muxed
 * information is emitted, and otherwise makes it a map
 * `{ amount: i128, to_muxed_id: u64 | bytes | string }`. Reading only the bare
 * form would drop every payment to a muxed address, and report a settlement
 * that happened as one that did not.
 */
function readTransferData(
  data: xdr.ScVal,
): { amount: bigint; toMuxedId?: string } | undefined {
  const native: unknown = scValToNative(data);
  if (typeof native === "bigint") return { amount: native };

  const map = asRecord(native);
  if (!map || typeof map["amount"] !== "bigint") return undefined;

  const id = map["to_muxed_id"];
  if (id === undefined) return { amount: map["amount"] };
  if (typeof id === "bigint" || typeof id === "number") {
    return { amount: map["amount"], toMuxedId: id.toString() };
  }
  if (typeof id === "string") return { amount: map["amount"], toMuxedId: id };
  if (id instanceof Uint8Array) {
    return { amount: map["amount"], toMuxedId: Buffer.from(id).toString("hex") };
  }
  return undefined;
}

/**
 * Extracts CAP-46 `transfer` events from a settled transaction.
 *
 * Adapted from @stellar/mpp's own `validateSimulationEvents`, with one
 * necessary difference: that function reads `xdr.DiagnosticEvent[]` from a
 * simulation and unwraps each via `.event()`. RPC's `getTransaction` returns
 * `contractEventsXdr` as `xdr.ContractEvent[][]` — already unwrapped, and
 * nested per operation. Calling `.event()` on these would throw at runtime.
 * Both the CAP-46 and the CAP-67 data formats are read; see
 * {@link readTransferData}.
 */
export function collectTransferEvents(
  contractEventsXdr: xdr.ContractEvent[][],
): TransferEvent[] {
  const transfers: TransferEvent[] = [];

  for (const perOperation of contractEventsXdr) {
    for (const contractEvent of perOperation) {
      if (contractEvent.type().name !== "contract") continue;

      const body = contractEvent.body().v0();
      const topics = body.topics();
      if (topics.length < 3) continue;

      // CAP-46: topic[0] = "transfer", topic[1] = from, topic[2] = to.
      if (topics[0]?.sym?.()?.toString() !== "transfer") continue;

      const data = readTransferData(body.data());
      if (!data) continue;

      const contractId = contractEvent.contractId();
      if (!contractId) continue;

      transfers.push({
        from: Address.fromScVal(topics[1]!).toString(),
        to: Address.fromScVal(topics[2]!).toString(),
        ...(data.toMuxedId !== undefined ? { toMuxedId: data.toMuxedId } : {}),
        amount: data.amount,
        contract: Address.fromScAddress(
          xdr.ScAddress.scAddressTypeContract(contractId),
        ).toString(),
      });
    }
  }

  return transfers;
}

/**
 * Whether a transfer reached the recipient the target advertised.
 *
 * A muxed recipient (`M...`) is one base account plus an id, and CAP-67
 * reports it that way: the base address in the topic, the id in the data. So
 * an advertised muxed recipient matches only when both parts do. Any other
 * recipient is compared by address, as before.
 */
export function transferReachedRecipient(
  advertised: string,
  transfer: TransferEvent,
): boolean {
  if (StrKey.isValidMed25519PublicKey(advertised)) {
    const muxed = MuxedAccount.fromAddress(advertised, "0");
    return (
      transfer.to === muxed.baseAccount().accountId() &&
      transfer.toMuxedId === muxed.id()
    );
  }
  return transfer.to === advertised;
}

/** How a transfer's destination reads in a report. */
function describeDestination(transfer: TransferEvent): string {
  return transfer.toMuxedId === undefined
    ? transfer.to
    : `${transfer.to} (muxed id ${transfer.toMuxedId})`;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

/** What looking for a settled transaction on RPC established. */
export type TransactionLookup =
  | { readonly kind: "found"; readonly response: rpc.Api.GetTransactionResponse }
  | { readonly kind: "missing"; readonly ledgersWatched: number }
  | { readonly kind: "stalled"; readonly ledgersWatched: number; readonly waitedMs: number };

/**
 * Polls RPC for a transaction until it appears, until RPC has closed enough
 * ledgers without it to say it is missing, or until RPC stops advancing.
 *
 * Takes the lookup, the clock and the sleep as parameters so the three
 * outcomes can be exercised without a network.
 */
export async function waitForTransaction(
  getTransaction: () => Promise<rpc.Api.GetTransactionResponse>,
  options: {
    readonly ledgers?: number;
    readonly maxWaitMs?: number;
    readonly delayMs?: number;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<TransactionLookup> {
  const ledgers = options.ledgers ?? LEDGERS_BEFORE_MISSING;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const delayMs = options.delayMs ?? POLL_DELAY_MS;
  const now = options.now ?? Date.now;
  const pause = options.sleep ?? sleep;

  const startedAt = now();
  let firstLedger: number | undefined;

  for (;;) {
    // An RPC failure is a harness problem: it says nothing about the target.
    const current = await getTransaction();
    if (current.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return { kind: "found", response: current };
    }

    firstLedger ??= current.latestLedger;
    const ledgersWatched = current.latestLedger - firstLedger;
    if (ledgersWatched >= ledgers) return { kind: "missing", ledgersWatched };

    const waitedMs = now() - startedAt;
    if (waitedMs >= maxWaitMs) return { kind: "stalled", ledgersWatched, waitedMs };

    await pause(delayMs);
  }
}

/** What a target advertised it would be paid, and who this run paid from. */
export interface ExpectedSettlement {
  /** In base units, directly comparable to the event's `i128`. */
  readonly amount: bigint;
  /** The token contract (`C...`). */
  readonly token: string;
  readonly recipient: string;
  /** This run's own payer, so an unrelated transaction cannot pass. */
  readonly payer: string;
}

/** A verdict about the target's settlement. */
export interface SettlementVerdict {
  readonly pass: boolean;
  readonly detail: string;
}

/**
 * Verifies that `reference` settled exactly what was expected.
 *
 * Returns a verdict about the target. Throws when RPC stops advancing, which
 * says nothing about the target; callers report that as no verdict.
 */
export async function verifySettlement(
  rpcUrl: string,
  reference: string,
  expected: ExpectedSettlement,
): Promise<SettlementVerdict> {
  const fail = (detail: string): SettlementVerdict => ({ pass: false, detail });

  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  const lookup = await waitForTransaction(() => server.getTransaction(reference));

  if (lookup.kind === "stalled") {
    // RPC not advancing says nothing about the target: no verdict.
    throw new Error(
      `RPC at ${rpcUrl} closed only ${lookup.ledgersWatched} ledgers in ` +
        `${Math.round(lookup.waitedMs / 1000)} seconds while looking for tx ` +
        `${reference}, so its absence says nothing about the target. Re-run, ` +
        `or point --rpc-url at another endpoint.`,
    );
  }

  if (lookup.kind === "missing") {
    return fail(
      `Target reported settlement as tx ${reference}, but RPC closed ` +
        `${lookup.ledgersWatched} more ledgers without it. Either it was never ` +
        `broadcast, or the target referenced a transaction that does not exist.`,
    );
  }

  const settled = lookup.response;

  if (settled.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    return fail(
      `Transaction ${reference} exists on-chain but failed (status ` +
        `${settled.status}). The target reported success for a settlement that ` +
        `did not settle.`,
    );
  }

  const transfers = collectTransferEvents(settled.events.contractEventsXdr);

  if (transfers.length === 0) {
    return fail(
      `Transaction ${reference} succeeded but emitted no CAP-46 transfer ` +
        `event, so no token movement can be verified.`,
    );
  }

  // Both specs require the events to show only the expected balance change.
  if (transfers.length !== 1) {
    return fail(
      `Transaction ${reference} emitted ${transfers.length} transfer events; ` +
        `exactly one was expected. Additional balance changes mean the ` +
        `settlement moved more than what was advertised.`,
    );
  }

  const actual = transfers[0]!;
  const mismatches: string[] = [];

  if (actual.amount !== expected.amount) {
    mismatches.push(
      `amount: advertised ${expected.amount} base units, moved ${actual.amount}`,
    );
  }
  if (!transferReachedRecipient(expected.recipient, actual)) {
    mismatches.push(
      `recipient: advertised ${expected.recipient}, paid ${describeDestination(actual)}`,
    );
  }
  if (actual.contract !== expected.token) {
    mismatches.push(`token: advertised ${expected.token}, moved ${actual.contract}`);
  }
  // Without this, a target could reference any pre-existing transaction that
  // happens to match the amount and recipient, and never take payment at all.
  if (actual.from !== expected.payer) {
    mismatches.push(
      `payer: this run paid from ${expected.payer}, but the referenced ` +
        `transfer came from ${actual.from}`,
    );
  }

  if (mismatches.length > 0) {
    return fail(
      `Settlement does not match what the target advertised — ` +
        `${mismatches.join("; ")} (tx ${reference}).`,
    );
  }

  return {
    pass: true,
    detail:
      `settled on-chain for exactly the advertised ${expected.amount} base ` +
      `units of ${expected.token} to ${expected.recipient}, verified from the ` +
      `transfer event (tx ${reference})`,
  };
}
