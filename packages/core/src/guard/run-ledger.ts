/**
 * The run ledger (spec B5, safety rule 6): a file a paying run keeps beside
 * it, so that a person can compare what Wasit signed with what the chain
 * shows, also after a crash (B10 T13).
 *
 * One file per run, `wasit-ledger-<UTC time>.json`, created new and never
 * overwritten. Every change rewrites it whole: to a temporary file, flushed to
 * disk, then renamed over the ledger, so the file is valid JSON at every
 * moment a process can be killed.
 *
 * One entry per signature (B-A03). Its intent (check, endpoint, amount,
 * payee, asset) is written and flushed after the run is charged and BEFORE
 * the key is asked to sign: a ledger that cannot take it stops the payment,
 * with nothing signed. Then what became of it: signed, with the ledger its
 * authorization expires at (decoded from what the key signed); not signed;
 * or unknown (the client failed after it may have signed). Then discarded
 * unsent, or sent with the answer's status, and the settlement if any. An
 * entry with no outcome reads as "assume signed and sent".
 *
 * Each entry also takes the verdict of the check it belongs to, once that
 * check has one. Balances before and after the run (USDC and XLM) close it,
 * with whether they are consistent with what the ledger says settled:
 * consistent, explained (the payer paid more than the settlements the run
 * verified, but no more than the payments of checks that FAILed, which a
 * service that takes what it should refuse may have settled), or
 * inconsistent.
 *
 * No secret: the payer is named by its public address, the RPC by its origin,
 * and free text is cut, with anything shaped like a Stellar secret or a 64-hex
 * value in it masked. Works on every network; on mainnet it is not optional
 * (B5).
 */

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { CheckSetupError } from "../errors.js";
import { sanitizeText } from "../sanitize.js";
import type { PinTerms } from "./budget.js";

/** The `format` field of every run ledger. */
export const RUN_LEDGER_FORMAT = "wasit-run-ledger";

const LEDGER_VERSION = 1;

/** The longest free text an entry keeps. */
const MAX_NOTE = 300;

/** `wasit-ledger-<UTC time>.json`, colons replaced: some file systems refuse them. */
export function runLedgerFileName(at: Date): string {
  return `wasit-ledger-${at.toISOString().replace(/:/g, "-")}.json`;
}

/** The run ledger cannot be written, or was asked something out of order. A setup error: no verdict. */
export class RunLedgerError extends CheckSetupError {
  public constructor(message: string) {
    super(message);
    this.name = "RunLedgerError";
  }
}

/** What a run states about itself when it opens its ledger. */
export interface RunLedgerHeader {
  readonly versions: Readonly<Record<string, string>>;
  readonly environment: string;
  readonly network: string;
  /** The payer's public address. */
  readonly payer: string;
  readonly pin?: PinTerms;
  readonly caps: { readonly perPaymentUsd: string; readonly runUsd: string };
  /** The run's plan; bigints are written as strings. */
  readonly plan: unknown;
  /** The RPC's origin, never its path or query (they may hold a key). */
  readonly rpc: string;
}

/** A reading of the payer's balances, in base units. */
export interface LedgerBalances {
  readonly usdc: bigint;
  readonly native: bigint;
}

export type LedgerEntryState =
  /** Written before the signature; no outcome yet. Read as signed. */
  | "intent"
  | "signed"
  /** The key was not asked, or refused: nothing was signed. */
  | "not-signed"
  /** The client failed when it may already have signed. Read as signed. */
  | "unknown";

/** What the check a signature belongs to found, as the ledger records it. */
export type LedgerVerdict = "pass" | "fail" | "no-verdict" | "skipped";

/** One signature of the run, as the file holds it. */
export interface LedgerEntry {
  readonly id: number;
  readonly endpoint: string;
  readonly check: string;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  /** Base units. */
  readonly amount: string;
  readonly intentAt: string;
  readonly state: LedgerEntryState;
  readonly signedAt?: string;
  /** The ledger (the chain's unit) the authorization expires at; null when it could not be read. */
  readonly expiresAtLedger?: number | null;
  /** Why it was not signed, or is unknown. */
  readonly note?: string;
  /** Why a signed payment was discarded, unsent. */
  readonly discarded?: string;
  readonly sent?: { readonly at: string; readonly status?: number; readonly error?: string };
  readonly settlement?: { readonly reference: string; readonly verified: boolean };
  /** The verdict of the check this signature belongs to; absent until that check has one. */
  readonly verdict?: LedgerVerdict;
}

/** What a payment check records about one signature. */
export interface LedgerEntryHandle {
  /** The key signed; `expiresAtLedger` undefined when it could not be read. */
  signed(expiresAtLedger: number | undefined): void;
  notSigned(reason: string): void;
  unknown(reason: string): void;
  /** A signed payment was discarded, unsent. */
  discarded(reason: string): void;
  sent(outcome: { readonly status: number } | { readonly error: string }): void;
  settled(reference: string, verified: boolean): void;
}

/** The ledger as the payment checks of one endpoint see it. */
export interface PaymentLedger {
  /**
   * Writes, and flushes, the intent of a signature about to be made. Throws
   * when it cannot: the caller then signs nothing.
   */
  intent(entry: {
    readonly check: string;
    readonly network: string;
    readonly asset: string;
    readonly payTo: string;
    readonly amount: string;
  }): LedgerEntryHandle;
  /**
   * Records `check`'s verdict on every entry of it that has none yet. Only a
   * FAIL recorded here can explain USDC the run did not verify settled; a
   * ledger without this method, or one that cannot write it, explains none.
   */
  verdict?(check: string, verdict: LedgerVerdict): void;
}

/**
 * How the payer's balances compare with the ledger. `consistent`: its USDC
 * went down by exactly the settlements the run verified, and its XLM did not
 * move. `explained`: its XLM did not move, and its USDC went down by more
 * than the verified settlements, but by no more than the payments, signed and
 * sent, of checks that FAILed (each counted once): a service that settles
 * what it should refuse. Anything else is `inconsistent`.
 */
export type LedgerResult = "consistent" | "explained" | "inconsistent";

/** Whether the payer's balances moved as the ledger says they should have. */
export interface LedgerConsistency {
  readonly result: LedgerResult;
  /** True only when `result` is "consistent". */
  readonly consistent: boolean;
  readonly reasons: readonly string[];
  /** USDC that left the payer, in base units, when both readings exist. */
  readonly spentUsdc?: bigint;
  /** USDC of the settlements the run verified on chain, in base units. */
  readonly settledUsdc: bigint;
}

/**
 * Free text for the file: one line, no control characters, nothing shaped like
 * a key (the sanitiser masks a Stellar secret's shape; a 64-hex value is masked
 * here), at most 300 characters.
 */
function note(text: unknown): string {
  return sanitizeText(String(text))
    .replace(/(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, "[64-hex value masked]")
    .replace(/\s+/g, " ")
    .slice(0, MAX_NOTE);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2)}\n`;
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? ` (${code})` : "";
}

type MutableEntry = { -readonly [K in keyof LedgerEntry]: LedgerEntry[K] };

interface Readings {
  usdc: string;
  native: string;
  source: string;
  at: string;
}

/**
 * The ledger of one paying run. Create it before the first signature; hand
 * {@link RunLedger.forEndpoint} to each endpoint's payment checks; close it
 * once every authorization has expired and the balances after are read.
 */
export class RunLedger {
  public readonly path: string;
  readonly #header: RunLedgerHeader;
  readonly #now: () => Date;
  readonly #openedAt: string;
  readonly #entries: MutableEntry[] = [];
  #before: Readings | undefined;
  #after: Readings | undefined;
  #result: { result: LedgerResult; reasons: readonly string[] } | undefined;
  #closedAt: string | undefined;

  private constructor(path: string, header: RunLedgerHeader, now: () => Date) {
    this.path = path;
    this.#header = header;
    this.#now = now;
    this.#openedAt = now().toISOString();
  }

  /**
   * Creates the ledger in `dir` (made if missing), named after now, holding the
   * header. Refuses a name that exists: a ledger is never overwritten.
   */
  public static create(dir: string, header: RunLedgerHeader, options: { readonly now?: () => Date } = {}): RunLedger {
    let origin: string | undefined;
    try {
      origin = new URL(header.rpc).origin;
    } catch {
      origin = undefined;
    }
    if (origin !== header.rpc) {
      throw new RunLedgerError("The run ledger names the RPC by its origin only, and was given more than an origin. Nothing was signed.");
    }
    const now = options.now ?? (() => new Date());
    const at = now();
    const path = join(dir, runLedgerFileName(at));
    const ledger = new RunLedger(path, header, () => now());
    let fd: number | undefined;
    try {
      mkdirSync(dir, { recursive: true });
      fd = openSync(path, "wx", 0o644);
      writeSync(fd, json(ledger.#document()));
      fsyncSync(fd);
    } catch (error) {
      throw new RunLedgerError(`The run ledger ${basename(path)} could not be created${errorCode(error)}. Nothing was signed.`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    syncDirectory(dir);
    return ledger;
  }

  /** The entries so far, as the file holds them. */
  public get entries(): readonly LedgerEntry[] {
    return this.#entries.map((entry) => structuredClone(entry));
  }

  /** The payment ledger of one endpoint's checks. */
  public forEndpoint(endpoint: string): PaymentLedger {
    const name = note(endpoint);
    return {
      intent: (entry) => this.#intent(endpoint, entry),
      verdict: (check, verdict) => this.#verdict(name, check, verdict),
    };
  }

  /** The payer's balances before the first signature, and where they were read. */
  public recordBalancesBefore(balances: LedgerBalances, source: string): void {
    this.#assertOpen();
    this.#before = this.#readings(balances, source);
    this.#flush();
  }

  /**
   * Closes the ledger with the balances after the run (undefined when they
   * could not be read): writes whether they are consistent with what the
   * ledger says settled, and returns it.
   */
  public close(input: { readonly after?: LedgerBalances; readonly source?: string } = {}): LedgerConsistency {
    this.#assertOpen();
    if (input.after !== undefined) this.#after = this.#readings(input.after, input.source ?? "");
    const before = this.#before === undefined ? undefined : { usdc: BigInt(this.#before.usdc), native: BigInt(this.#before.native) };
    const result = ledgerConsistency(before, input.after, this.entries);
    this.#result = { result: result.result, reasons: result.reasons };
    this.#closedAt = this.#now().toISOString();
    this.#flush();
    return result;
  }

  #readings(balances: LedgerBalances, source: string): Readings {
    return { usdc: balances.usdc.toString(), native: balances.native.toString(), source: note(source), at: this.#now().toISOString() };
  }

  #assertOpen(): void {
    if (this.#closedAt !== undefined) throw new RunLedgerError("The run ledger is closed and takes nothing more.");
  }

  #intent(endpoint: string, input: Parameters<PaymentLedger["intent"]>[0]): LedgerEntryHandle {
    this.#assertOpen();
    if (typeof input.amount !== "string" || !/^[0-9]{1,78}$/.test(input.amount)) {
      throw new RunLedgerError("The run ledger takes a whole number of base units only. Nothing was signed.");
    }
    const entry: MutableEntry = {
      id: this.#entries.length + 1,
      endpoint: note(endpoint),
      check: note(input.check),
      network: note(input.network),
      asset: note(input.asset),
      payTo: note(input.payTo),
      amount: input.amount,
      intentAt: this.#now().toISOString(),
      state: "intent",
    };
    this.#entries.push(entry);
    try {
      this.#flush();
    } catch (error) {
      this.#entries.pop();
      throw new RunLedgerError(`${(error as Error).message} Nothing was signed.`);
    }
    return this.#handle(entry);
  }

  #verdict(endpoint: string, check: string, verdict: LedgerVerdict): void {
    this.#assertOpen();
    if (!LEDGER_VERDICTS.has(verdict)) throw new RunLedgerError("The run ledger takes a check's verdict as pass, fail, no-verdict or skipped.");
    const id = note(check);
    let changed = false;
    for (const entry of this.#entries) {
      if (entry.endpoint === endpoint && entry.check === id && entry.verdict === undefined) {
        entry.verdict = verdict;
        changed = true;
      }
    }
    if (changed) this.#flush();
  }

  #handle(entry: MutableEntry): LedgerEntryHandle {
    const outcome = (state: LedgerEntryState, fields: Partial<MutableEntry>): void => {
      if (entry.state !== "intent") {
        throw new RunLedgerError(`The run ledger already has an outcome for ${entry.check} (entry ${entry.id}).`);
      }
      Object.assign(entry, { state, ...fields });
      this.#flush();
    };
    const afterSigning = (what: string): void => {
      if (entry.state !== "signed") throw new RunLedgerError(`The run ledger has no signature to record ${what} for (entry ${entry.id}).`);
    };
    return {
      signed: (expiresAtLedger) =>
        outcome("signed", {
          signedAt: this.#now().toISOString(),
          expiresAtLedger: typeof expiresAtLedger === "number" && Number.isSafeInteger(expiresAtLedger) ? expiresAtLedger : null,
        }),
      notSigned: (reason) => outcome("not-signed", { note: note(reason) }),
      unknown: (reason) => outcome("unknown", { note: note(reason) }),
      discarded: (reason) => {
        afterSigning("a discard");
        if (entry.discarded !== undefined || entry.sent !== undefined) {
          throw new RunLedgerError(`The run ledger already has ${entry.check} (entry ${entry.id}) discarded or sent.`);
        }
        entry.discarded = note(reason);
        this.#flush();
      },
      sent: (result) => {
        afterSigning("a send");
        if (entry.discarded !== undefined || entry.sent !== undefined) {
          throw new RunLedgerError(`The run ledger already has ${entry.check} (entry ${entry.id}) discarded or sent.`);
        }
        entry.sent =
          "status" in result
            ? { at: this.#now().toISOString(), status: result.status }
            : { at: this.#now().toISOString(), error: note(result.error) };
        this.#flush();
      },
      settled: (reference, verified) => {
        if (entry.sent === undefined || entry.settlement !== undefined) {
          throw new RunLedgerError(`The run ledger has no send to record a settlement for (entry ${entry.id}), or has one already.`);
        }
        // A settlement reference is a public transaction hash (64 hex on Stellar): kept as it is, never masked,
        // so a person can look it up; still one bounded line.
        entry.settlement = { reference: sanitizeText(String(reference)).replace(/\s+/g, "").slice(0, 128), verified: verified === true };
        this.#flush();
      },
    };
  }

  #document(): Record<string, unknown> {
    const header = this.#header;
    return {
      format: RUN_LEDGER_FORMAT,
      version: LEDGER_VERSION,
      openedAt: this.#openedAt,
      versions: header.versions,
      environment: note(header.environment),
      network: note(header.network),
      payer: note(header.payer),
      ...(header.pin === undefined ? {} : { pin: { payTo: note(header.pin.payTo), asset: note(header.pin.asset) } }),
      caps: header.caps,
      rpc: header.rpc,
      plan: header.plan,
      ...(this.#before === undefined ? {} : { balancesBefore: this.#before }),
      entries: this.#entries,
      ...(this.#after === undefined ? {} : { balancesAfter: this.#after }),
      result: this.#result === undefined ? "open" : this.#result.result,
      ...(this.#result === undefined ? {} : { reasons: this.#result.reasons }),
      ...(this.#closedAt === undefined ? {} : { closedAt: this.#closedAt }),
    };
  }

  /** The whole file, rewritten: temporary file, flushed, renamed over the ledger. */
  #flush(): void {
    const tmp = `${this.path}.tmp`;
    let fd: number | undefined;
    try {
      rmSync(tmp, { force: true });
      fd = openSync(tmp, "wx", 0o644);
      writeSync(fd, json(this.#document()));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.path);
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // closed either way
        }
      }
      try {
        rmSync(tmp, { force: true });
      } catch {
        // nothing more to clean
      }
      throw new RunLedgerError(`The run ledger ${basename(this.path)} could not be written${errorCode(error)}.`);
    }
    syncDirectory(dirname(this.path));
  }
}

/** Flushes a folder's entry list, where the platform allows it (not on Windows). */
function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Best effort: the file itself was flushed.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // closed either way
      }
    }
  }
}

const LEDGER_VERDICTS: ReadonlySet<string> = new Set<LedgerVerdict>(["pass", "fail", "no-verdict", "skipped"]);

/** An entry that holds a signature, or may: everything but "not-signed". */
function maySign(entry: LedgerEntry): boolean {
  return entry.state !== "not-signed";
}

/** An entry whose payment may have reached the service: it may be signed, and was not discarded unsent. */
function maySend(entry: LedgerEntry): boolean {
  return maySign(entry) && entry.discarded === undefined;
}

/**
 * Whether the payer's balances moved as the ledger says (see
 * {@link LedgerResult}). On Stellar the facilitator pays the fees and Wasit
 * sends no transaction from the payer, so its XLM must not move. The USDC
 * the run verified settled is the sum of the entries whose settlement it read
 * back from the chain. More than that is explained only by the entries, sent
 * and not verified, of checks that FAILed: a check with no verdict, a SKIP or
 * a PASS explains nothing, and neither does a payment discarded unsent. The
 * reasons also name every entry with no recorded outcome, which is read as
 * signed and sent.
 */
export function ledgerConsistency(
  before: LedgerBalances | undefined,
  after: LedgerBalances | undefined,
  entries: readonly LedgerEntry[],
): LedgerConsistency {
  const reasons: string[] = [];
  for (const entry of entries) {
    if (entry.state === "intent" || entry.state === "unknown") {
      reasons.push(`${entry.check} of ${entry.endpoint} (entry ${entry.id}) has no recorded signature outcome: assume it was signed and sent.`);
    } else if (entry.state === "signed" && entry.sent === undefined && entry.discarded === undefined) {
      reasons.push(`${entry.check} of ${entry.endpoint} (entry ${entry.id}) was signed and has no recorded send: assume it was sent.`);
    }
  }
  const settledUsdc = entries
    .filter((entry) => entry.settlement?.verified === true)
    .reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
  const inconsistent = (lines: readonly string[], spentUsdc?: bigint): LedgerConsistency => ({
    result: "inconsistent",
    consistent: false,
    reasons: [...lines, ...reasons],
    ...(spentUsdc === undefined ? {} : { spentUsdc }),
    settledUsdc,
  });
  if (before === undefined || after === undefined) {
    return inconsistent(["The payer's balances before and after the run were not both read."]);
  }
  const spentUsdc = before.usdc - after.usdc;
  const problems: string[] = [];
  if (before.native !== after.native) {
    problems.push(`The payer's XLM changed by ${after.native - before.native} stroops; Wasit sends no transaction from the payer.`);
  }
  const gap = spentUsdc - settledUsdc;
  const failed = entries.filter((entry) => maySend(entry) && entry.settlement?.verified !== true && entry.verdict === "fail");
  const failedUsdc = failed.reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
  const explained = gap > 0n && gap <= failedUsdc;
  if (gap !== 0n && !explained) {
    problems.push(
      `The payer's USDC went down by ${spentUsdc} base units, and the settlements this run verified add up to ${settledUsdc}` +
        (gap > 0n && failedUsdc > 0n ? `; the payments of the checks that FAILed add up to only ${failedUsdc} more.` : "."),
    );
  }
  if (problems.length > 0) return inconsistent(problems, spentUsdc);
  if (!explained) return { result: "consistent", consistent: true, reasons, spentUsdc, settledUsdc };
  return {
    result: "explained",
    consistent: false,
    reasons: [
      `The payer's USDC went down by ${spentUsdc} base units: ${settledUsdc} in the settlements this run verified, and ` +
        `${gap} more, within the ${failedUsdc} of payments sent for checks that FAILed (` +
        failed.map((entry) => `${entry.check} of ${entry.endpoint}, entry ${entry.id}, ${entry.amount}`).join("; ") +
        `): the service settled payments it should have refused. Its XLM did not move.`,
      ...reasons,
    ],
    spentUsdc,
    settledUsdc,
  };
}

/**
 * Until when the run's authorizations may be open (L4): the latest expiry of
 * every entry that holds a signature or may, and how many of those have no
 * known expiry (the caller then waits the longest a signature may live).
 */
export function openAuthorizationsUntil(entries: readonly LedgerEntry[]): { latest: number | undefined; unknown: number } {
  let latest: number | undefined;
  let unknown = 0;
  for (const entry of entries) {
    if (!maySign(entry)) continue;
    if (typeof entry.expiresAtLedger === "number") latest = latest === undefined ? entry.expiresAtLedger : Math.max(latest, entry.expiresAtLedger);
    else unknown += 1;
  }
  return { latest, unknown };
}
