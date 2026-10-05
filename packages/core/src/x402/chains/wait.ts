/**
 * Waiting for a settled transaction to appear on chains whose RPC reports
 * progress as a block (or slot) number: EVM and Solana.
 */

const MAX_WAIT_MS = 120_000;
const POLL_DELAY_MS = 1_000;

/** What looking for a settled transaction established. */
export type ReceiptLookup<R> =
  | { readonly kind: "found"; readonly receipt: R }
  | { readonly kind: "missing"; readonly blocksWatched: bigint }
  | { readonly kind: "stalled"; readonly blocksWatched: bigint; readonly waitedMs: number };

/**
 * Polls for a settled transaction until it appears, until the chain has
 * produced enough blocks (slots, on Solana) without it to call it missing, or
 * until the RPC stops advancing.
 *
 * A fixed wall-clock wait cannot tell a transaction that does not exist from
 * an RPC that is behind, so the wait is counted in the chain's own progress,
 * and an RPC that stops advancing gives no verdict at all.
 *
 * `getReceipt` returns undefined while the transaction is unknown; any other
 * failure is the harness's and propagates. Clock and sleep are parameters so
 * the three outcomes can be exercised without a network.
 */
export async function waitForReceipt<R>(
  getReceipt: () => Promise<R | undefined>,
  getBlockNumber: () => Promise<bigint>,
  options: {
    readonly blocks: bigint;
    readonly maxWaitMs?: number;
    readonly delayMs?: number;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<ReceiptLookup<R>> {
  const blocks = options.blocks;
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const delayMs = options.delayMs ?? POLL_DELAY_MS;
  const now = options.now ?? Date.now;
  const pause = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  const startedAt = now();
  let firstBlock: bigint | undefined;

  for (;;) {
    const receipt = await getReceipt();
    if (receipt !== undefined) return { kind: "found", receipt };

    const block = await getBlockNumber();
    firstBlock ??= block;
    const blocksWatched = block - firstBlock;
    if (blocksWatched >= blocks) return { kind: "missing", blocksWatched };

    const waitedMs = now() - startedAt;
    if (waitedMs >= maxWaitMs) return { kind: "stalled", blocksWatched, waitedMs };

    await pause(delayMs);
  }
}
