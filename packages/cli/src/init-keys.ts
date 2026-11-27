/**
 * The testnet key setup of `wasit init` (spec C4 with C7 rows 2, 3 and 5, and
 * Najmi's decision of 2026-11-27 for the channel; W3-2 slice 5), for the route
 * init has just written. It sets up, in the `.env` of the working directory
 * that `wasit run` loads, the key the route's payment checks read: the x402
 * payer (STELLAR_PRIVATE_KEY) or the MPP charge payer (MPP_PAYER_SECRET), with
 * test XLM, the USDC trustline and test USDC. The steps, in this order:
 *
 * 1. The network. A network that is not a test network returns before a file
 *    is looked at or a key is made (C3: not reachable for any class but
 *    `test`). A test network of another chain gets the variable to set and the
 *    faucet, and no key.
 * 2. `.env` protection. In a git repository `.env` must not be tracked
 *    (`git ls-files --error-unmatch`) and must be ignored (`git check-ignore`);
 *    when it is not ignored, `.env` is added to `.gitignore` only on a yes,
 *    then checked again. Outside a repository `.gitignore` gets `.env` all the
 *    same. In a repository git cannot answer for: no key. `DOTENV_CONFIG_PATH`
 *    set: no key, since wasit then reads another file.
 * 3. Reuse, never overwrite. A variable that is set is kept, and its account is
 *    only read. One that `.env` has without a value is left as it is. One set
 *    to nothing in the environment init runs in hides `.env` from `wasit run`
 *    (dotenv never replaces a variable that is set, and run reads an empty one
 *    as no key): that is said, and no key is made.
 * 4. A new key is made in memory and appended to `.env`: created readable by
 *    its owner only, never through a link, never rewritten, the file's own
 *    line ending kept. An existing `.env` keeps its permissions; one open to
 *    other users is said, with the `chmod` that closes it. It is read back,
 *    and only then funded: Friendbot, then
 *    the trustline and test USDC by a swap on the public test exchange. A step
 *    that fails is said with the command that finishes it later, and the rest
 *    goes on: the read-only checks need none of it.
 * 5. MPP channel: no key is made (Najmi, 2026-11-27). The channel's server
 *    checks each commitment against the key the channel was opened with
 *    (`@stellar/mpp` 0.7.1 `channel/server/Channel.js`), which a new key is not.
 *
 * Only public addresses are printed. A generated secret goes to `.env` and to
 * the caller's redaction list, nowhere else. Nothing here throws: the config is
 * already written, so whatever went wrong becomes a line.
 */

import { execFile } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";

import { parse as parseDotenv } from "dotenv";
import {
  TESTNET_SWAP_XLM,
  TESTNET_USDC_ISSUER,
  addTestnetUsdc,
  fundWithFriendbot,
  generateTestnetWallet,
  getTestnetWalletStatus,
  networkClass,
  paymentChainFor,
  publicKeyFromSecret,
  scrubEnv,
  type FriendbotOutcome,
  type GeneratedWallet,
  type RouteProtocol,
  type UsdcSetupOutcome,
  type WalletStatus,
} from "@wasit-dev/core";

import { MPP_COMMITMENT_KEY_ENV, MPP_PAYER_KEY_ENV } from "./run.js";
import { SERVE_NETWORKS } from "./serve.js";

/** The only network init sets up keys on. */
export const KEY_SETUP_NETWORK = "stellar:testnet";

const ENV_FILE = ".env";
const GITIGNORE_FILE = ".gitignore";
const FAUCET_URL = "https://faucet.circle.com";

/** How often, and how long apart, init looks for the account Friendbot has just made (the starter kit's 8 times, 1 s). */
const ACCOUNT_LOOKS = 8;
const ACCOUNT_LOOK_GAP_MS = 1_000;

/** The longest error text of a network service printed: it is the service's, not ours. */
const MAX_ERROR_LENGTH = 200;

/** What git answered: its exit code (null when it did not run or did not finish) and what it printed. */
export interface GitAnswer {
  readonly code: number | null;
  readonly stdout: string;
}

/** The outside world of the key setup, passed in so the tests can stand in for it. */
export interface KeySetupDeps {
  readonly git: (args: readonly string[], cwd: string) => Promise<GitAnswer>;
  readonly generateWallet: () => GeneratedWallet;
  readonly fund: (publicKey: string) => Promise<FriendbotOutcome>;
  readonly status: (publicKey: string) => Promise<WalletStatus>;
  readonly addUsdc: (secretKey: string, source: string) => Promise<UsdcSetupOutcome>;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface KeySetupRequest {
  /** The network init wrote for the route. */
  readonly network: string;
  readonly protocol: RouteProtocol;
  /** MPP channel: the channel contract the route bills through. */
  readonly channel?: string;
  /** The asset the route asks to be paid in, when init read one. */
  readonly asset?: string;
  /** Where `.env` and `.gitignore` are: the working directory, which `wasit run` loads `.env` from. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether `.env` may be added to `.gitignore` in a repository that does not ignore it. */
  readonly allowGitignore: () => Promise<boolean>;
  /** Every line of the key setup, in order, as each step starts or ends. */
  readonly say: (line: string) => void;
  /** A value no printed line may carry: the secret of a key made here. */
  readonly redact: (value: string) => void;
}

/**
 * Runs git with the keys taken out of its environment, without the file
 * system monitor (a repository's own config can name a program for it), and
 * never longer than 10 s.
 */
export function runGit(args: readonly string[], cwd: string): Promise<GitAnswer> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", ...args],
      { cwd, timeout: 10_000, windowsHide: true, env: { ...scrubEnv(process.env), GIT_OPTIONAL_LOCKS: "0" } },
      (error, stdout) => {
        const exit = (error as { code?: unknown } | null)?.code;
        resolve({ code: error === null ? 0 : typeof exit === "number" ? exit : null, stdout: String(stdout ?? "") });
      },
    );
  });
}

/** The network side of the key setup, for real. */
export const LIVE_KEY_SETUP: KeySetupDeps = {
  git: runGit,
  generateWallet: generateTestnetWallet,
  fund: (publicKey) => fundWithFriendbot(publicKey),
  status: getTestnetWalletStatus,
  addUsdc: addTestnetUsdc,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

type Role =
  | { readonly kind: "payer"; readonly variable: string; readonly walletRole: "x402" | "mpp-charge" }
  | { readonly kind: "commitment"; readonly variable: string };

/** The key a route's payment checks read in `wasit run`. */
export function keyRoleFor(protocol: RouteProtocol): Role {
  if (protocol === "mpp-charge") return { kind: "payer", variable: MPP_PAYER_KEY_ENV, walletRole: "mpp-charge" };
  if (protocol === "mpp-channel") return { kind: "commitment", variable: MPP_COMMITMENT_KEY_ENV };
  return { kind: "payer", variable: paymentChainFor(KEY_SETUP_NETWORK)!.payerKeyEnv, walletRole: "x402" };
}

function messageOf(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 3)}...` : text;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "an error";
}

/** Where a payer set up by hand goes, and what must be true before it goes there. */
interface HandSetup {
  /** What must be done first, as the start of a sentence ("Once git ignores .env"). */
  readonly first?: string;
  /** The file the key line goes in: `.env` when not given. */
  readonly file?: string;
}

/** How to set up a payer by hand, with the commands that exist today. */
function byHand(role: Extract<Role, { kind: "payer" }>, hand: HandSetup = {}): string {
  return (
    `${hand.first === undefined ? "By hand" : `${hand.first}, by hand`}: wasit wallet create --role ${role.walletRole} ` +
    `--fund makes a testnet key and prints it (not on a shared screen); put its ${role.variable} line in ` +
    `${hand.file ?? ENV_FILE}, then run wasit wallet fund --role ${role.walletRole} --asset usdc.`
  );
}

/** The question init asks at a terminal, before it writes the config, for a route on {@link KEY_SETUP_NETWORK}. */
export function keySetupQuestion(protocol: RouteProtocol): string {
  const role = keyRoleFor(protocol);
  if (role.kind === "commitment") {
    return `Check the channel's commitment key (${role.variable} in .env)? init makes none (yes/no): `;
  }
  return (
    `Set up a test payer in .env (${role.variable})? If it is not set, init makes a Stellar testnet key (the secret ` +
    `is never shown), funds it with Friendbot and swaps ${TESTNET_SWAP_XLM} test XLM for test USDC (yes/no): `
  );
}

/** The question when `.env` is not ignored in a git repository. */
export const GITIGNORE_QUESTION = ".env is not ignored by git. Add .env to .gitignore? (yes/no): ";

/** What a route on {@link KEY_SETUP_NETWORK} needs when the key setup did not run, and why it did not. */
export function notSetUpLines(protocol: RouteProtocol, why: string): string[] {
  const role = keyRoleFor(protocol);
  if (role.kind === "commitment") {
    return [
      `Commitment key: not checked (${why}). The channel checks of wasit run read ${role.variable} from .env: the ` +
        "secret of the commitment key the channel was opened with.",
    ];
  }
  return [
    `Test key: not set up (${why}). The payment checks of wasit run read ${role.variable} from .env: a Stellar ` +
      `testnet key with test XLM, the USDC trustline and test USDC. ${byHand(role)}`,
  ];
}

/**
 * What a route on a test network of another chain needs, with no key made: the
 * variable `wasit run` reads, and the faucet (spec C3).
 */
export function otherNetworkLines(network: string, protocol: RouteProtocol): string[] {
  const chain = paymentChainFor(network);
  const profile = SERVE_NETWORKS[network];
  if (protocol !== "x402" || chain === undefined || profile === undefined) {
    return [`Test key: init sets up keys on ${KEY_SETUP_NETWORK} only, and this route is on ${network}.`];
  }
  return [
    `Test key: init sets up keys on ${KEY_SETUP_NETWORK} only. On ${profile.name} the payment checks of wasit run read ` +
      `${chain.payerKeyEnv} from .env (keep .env in .gitignore): wasit wallet create --role x402 --network ${network} ` +
      `makes one and prints it (not on a shared screen). Fund it with USDC at ${FAUCET_URL} (network ` +
      `${profile.faucetNetwork}); it needs no ${profile.nativeToken}, since the facilitator pays the fee.`,
  ];
}

/** Whether `.env` may get a key, and what was done to make sure; when it may not, how a key is set up by hand. */
type Protection =
  | { readonly writable: true; readonly lines: readonly string[] }
  | { readonly writable: false; readonly lines: readonly string[]; readonly why: string; readonly hand: HandSetup };

function blocked(why: string, hand: HandSetup, lines: readonly string[] = []): Protection {
  return { writable: false, lines, why, hand };
}

/** What must be true before a key goes into `.env` by hand, for each reason init wrote none. */
const ONCE_GIT_ANSWERS: HandSetup = { first: "Once git can tell that .env is ignored and not tracked" };
const ONCE_IGNORED: HandSetup = { first: "Once git ignores .env" };

/** A `.git` in this folder or a folder above it: a repository, whether or not git runs. */
function inRepositoryFolder(cwd: string): boolean {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Appends one line to `file`, never rewriting what is there: created with
 * `mode` when it is not there, never opened through a link, the file's own
 * line ending kept, and a line break put first when the file does not end
 * with one. Undefined when it worked, else why not.
 */
function appendLine(file: string, line: string, mode: number): string | undefined {
  const name = path.basename(file);
  let before = "";
  try {
    if (!lstatSync(file).isFile()) return `${name} is not a plain file (a link or a folder), and init writes only to a plain file`;
    before = readFileSync(file, "utf-8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return `cannot read ${name} (${errorCode(error)})`;
  }
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const text = `${before === "" || before.endsWith("\n") ? "" : eol}${line}${eol}`;
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), mode);
    writeSync(fd, text);
  } catch (error) {
    return `cannot write ${name} (${errorCode(error)})`;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}

/** Whether `.gitignore` has a line that is exactly `.env`. */
function gitignoreListsEnv(cwd: string): boolean {
  try {
    return readFileSync(path.join(cwd, GITIGNORE_FILE), "utf-8")
      .split(/\r?\n/)
      .some((line) => line.trim() === ENV_FILE);
  } catch {
    return false;
  }
}

/** Step 2: may `.env` get a key? */
async function protectEnv(request: KeySetupRequest, deps: KeySetupDeps): Promise<Protection> {
  const { cwd } = request;
  if ((request.env["DOTENV_CONFIG_PATH"] ?? "").trim() !== "") {
    return blocked("DOTENV_CONFIG_PATH is set, so wasit reads its keys from that file and not from .env here", {
      file: "the file DOTENV_CONFIG_PATH names (keep that file out of git)",
    });
  }
  const gitFailed =
    "this folder is in a git repository, and git could not say whether .env is tracked or ignored (is git installed?)";

  const inside = await deps.git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    if (inRepositoryFolder(cwd)) return blocked(gitFailed, ONCE_GIT_ANSWERS);
    if (gitignoreListsEnv(cwd)) return { writable: true, lines: ["this folder is not a git repository; .gitignore lists .env"] };
    const problem = appendLine(path.join(cwd, GITIGNORE_FILE), ENV_FILE, 0o666);
    if (problem !== undefined) {
      return blocked(`this folder is not a git repository, and init could not add .env to .gitignore: ${problem}`, {
        first: "Once .gitignore lists .env",
      });
    }
    return { writable: true, lines: ["this folder is not a git repository: init added .env to .gitignore all the same, for when it is one"] };
  }

  const tracked = await deps.git(["ls-files", "--error-unmatch", "--", ENV_FILE], cwd);
  if (tracked.code === 0) {
    return blocked(
      ".env is tracked by git, so a key in it would be committed. Untrack it (git rm --cached .env, then commit) and add " +
        ".env to .gitignore. A key it ever held is in the history: treat it as public",
      { first: "Once .env is untracked and ignored" },
    );
  }
  if (tracked.code !== 1) return blocked(gitFailed, ONCE_GIT_ANSWERS);

  const ignored = await deps.git(["check-ignore", "-q", "--", ENV_FILE], cwd);
  if (ignored.code === 0) return { writable: true, lines: [".env is ignored by git and not tracked"] };
  if (ignored.code !== 1) return blocked(gitFailed, ONCE_GIT_ANSWERS);

  if (!(await request.allowGitignore())) {
    return blocked(".env is not ignored by git, and .gitignore was left as it is: add .env to .gitignore first", ONCE_IGNORED);
  }
  const problem = appendLine(path.join(cwd, GITIGNORE_FILE), ENV_FILE, 0o666);
  if (problem !== undefined) return blocked(`.env is not ignored by git, and init could not add it to .gitignore: ${problem}`, ONCE_IGNORED);
  const again = await deps.git(["check-ignore", "-q", "--", ENV_FILE], cwd);
  if (again.code !== 0) {
    return blocked("init added .env to .gitignore, and git still does not ignore it (a rule such as !.env after it?)", ONCE_IGNORED, [
      "init added .env to .gitignore",
    ]);
  }
  return { writable: true, lines: ["init added .env to .gitignore, and git now ignores it (commit that change)"] };
}

/** The names `.env` defines, and those of them it gives no value (values unread by the caller). */
interface EnvFileNames {
  readonly names: ReadonlySet<string>;
  readonly empty: ReadonlySet<string>;
}

/** The names `.env` defines; or why it cannot be read. */
function envFileNames(cwd: string): EnvFileNames | { readonly problem: string } {
  const file = path.join(cwd, ENV_FILE);
  try {
    if (!lstatSync(file).isFile()) return { problem: ".env is not a plain file (a link or a folder)" };
    const parsed = parseDotenv(readFileSync(file, "utf-8"));
    const names = new Set(Object.keys(parsed));
    return { names, empty: new Set([...names].filter((name) => (parsed[name] ?? "").trim() === "")) };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { names: new Set(), empty: new Set() };
    return { problem: `cannot read .env (${errorCode(error)})` };
  }
}

/**
 * Whether a variable set to nothing in the environment init runs in hides
 * `.env` from `wasit run`: dotenv never replaces a variable that is set, and
 * run reads an empty one as no key. "no line": `.env` does not name it, so a
 * key added there would be hidden; "line": `.env` gives it a value that is
 * hidden. Undefined when nothing is hidden, when `.env` names it with no value
 * too (said as that), or when DOTENV_CONFIG_PATH points wasit at another file.
 */
function hiddenByEnvironment(request: KeySetupRequest, variable: string, file: EnvFileNames): "no line" | "line" | undefined {
  const value = request.env[variable];
  if (value === undefined || value.trim() !== "") return undefined;
  if ((request.env["DOTENV_CONFIG_PATH"] ?? "").trim() !== "") return undefined;
  if (!file.names.has(variable)) return "no line";
  return file.empty.has(variable) ? undefined : "line";
}

/** How to clear a variable set to nothing, in the shells most builders use. */
function unsetHint(variable: string): string {
  return `bash or zsh: unset ${variable}; PowerShell: Remove-Item Env:${variable}`;
}

/** Why an empty variable in the environment makes init write no key. */
function emptyInEnvironment(variable: string): string {
  return (
    `${variable}: set to nothing in the environment init runs in (your shell, most likely), and init wrote none: .env ` +
    "never replaces a variable that is set, and wasit run reads an empty one as no key."
  );
}

/** A value `.env` has that an empty variable in the environment hides from `wasit run`. */
function hiddenLine(variable: string): string {
  return (
    `  ${variable}: in .env, and set to nothing in the environment init runs in (your shell, most likely), which ` +
    `wins: wasit run reads that as no key. Unset it there (${unsetHint(variable)}); init does not change .env.`
  );
}

/**
 * The permission bits of `file` when users other than its owner have any
 * access to it, else undefined (and on Windows, whose files have no such bits).
 */
function openToOthers(file: string): string | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const mode = lstatSync(file).mode & 0o777;
    return (mode & 0o077) === 0 ? undefined : mode.toString(8);
  } catch {
    return undefined;
  }
}

/** What is missing of a payer, from the steps that ran. */
interface Problems {
  xlm?: string;
  trustline?: string;
  usdc?: string;
}

/** A positive Stellar amount: any digit but 0. */
function positive(balance: string): boolean {
  return /[1-9]/.test(balance);
}

/** The status table's rows of one payer: XLM, the trustline, USDC, each ready or what is missing and how to finish it. */
function payerRows(
  role: Extract<Role, { kind: "payer" }>,
  status: WalletStatus | undefined,
  problems: Problems,
  readError: string | undefined,
): string[] {
  if (status === undefined && readError !== undefined) {
    return [`    could not read the account (${readError}): wasit wallet status --role ${role.walletRole} checks it`];
  }
  const exists = status?.exists === true;
  const xlm = status?.balances.find((balance) => balance.code === "XLM");
  const usdc = status?.balances.find((balance) => balance.code === "USDC" && balance.issuer === TESTNET_USDC_ISSUER);
  const fund = `wasit wallet fund --role ${role.walletRole}`;
  const xlmRow = exists
    ? `ready, ${xlm?.balance ?? "0"} XLM`
    : `missing: ${problems.xlm ?? "the account does not exist on testnet yet"}. Later: ${fund}`;
  const trustRow =
    usdc !== undefined
      ? "ready"
      : `missing${problems.trustline !== undefined ? `: ${problems.trustline}` : exists ? "" : ": it needs the account first"}. ` +
        `Later: ${fund} --asset usdc`;
  const usdcRow =
    usdc !== undefined && positive(usdc.balance)
      ? `ready, ${usdc.balance} USDC`
      : `missing${problems.usdc !== undefined ? `: ${problems.usdc}` : ""}. Get test USDC at ${FAUCET_URL} ` +
        `(Stellar Testnet), pasting the address${usdc === undefined ? ", once the trustline is there" : ""}`;
  return [`    XLM:       ${xlmRow}`, `    trustline: ${trustRow}`, `    USDC:      ${usdcRow}`];
}

async function readStatus(
  deps: KeySetupDeps,
  publicKey: string,
): Promise<{ readonly status?: WalletStatus; readonly error?: string }> {
  try {
    return { status: await deps.status(publicKey) };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

/** A payer whose variable is set: kept, and its account only read (C4 step 2). */
async function existingPayer(
  role: Extract<Role, { kind: "payer" }>,
  value: string,
  deps: KeySetupDeps,
  emit: (line: string) => void,
): Promise<void> {
  let publicKey: string;
  try {
    publicKey = publicKeyFromSecret(value, role.variable);
  } catch {
    emit(`  ${role.variable}: set, and not a Stellar secret key (S...): init does not change it.`);
    return;
  }
  emit(`  ${role.variable}: set, kept (init never overwrites a key), address ${publicKey}`);
  emit("  Reading its account on Stellar testnet ...");
  const read = await readStatus(deps, publicKey);
  for (const row of payerRows(role, read.status, {}, read.error)) emit(row);
}

/** A payer made here (C4 steps 3 and 4). */
async function newPayer(
  role: Extract<Role, { kind: "payer" }>,
  request: KeySetupRequest,
  deps: KeySetupDeps,
  emit: (line: string) => void,
): Promise<void> {
  const file = path.join(request.cwd, ENV_FILE);
  const wallet = deps.generateWallet();
  request.redact(wallet.secretKey);

  const problem = appendLine(file, `${role.variable}=${wallet.secretKey}`, 0o600);
  if (problem !== undefined) {
    emit(`  ${role.variable}: not set: ${problem}. No key was kept and nothing was funded. ${byHand(role)}`);
    return;
  }
  let readBack: string | undefined;
  try {
    readBack = parseDotenv(readFileSync(file, "utf-8"))[role.variable];
  } catch {
    readBack = undefined;
  }
  if (readBack !== wallet.secretKey) {
    emit(
      `  ${role.variable}: init added it at the end of .env, and .env does not read it back as written (an unclosed ` +
        "quote on a line before it?). Fix .env; nothing was funded.",
    );
    return;
  }
  emit(`  ${role.variable}: new, written to .env (the secret is not shown), address ${wallet.publicKey}`);
  const mode = openToOthers(file);
  if (mode !== undefined) {
    emit(
      `  .env is open to other users of this computer (mode ${mode}), and it now holds the key: chmod 600 .env makes ` +
        "it yours only. init leaves the file's permissions as they are.",
    );
  }

  const problems: Problems = {};
  emit("  Funding it with test XLM from Friendbot (the public testnet faucet) ...");
  let funded = true;
  try {
    await deps.fund(wallet.publicKey);
  } catch (error) {
    funded = false;
    problems.xlm = `Friendbot did not fund it (${messageOf(error)})`;
  }

  let account: WalletStatus | undefined;
  if (funded) {
    for (let look = 1; look <= ACCOUNT_LOOKS; look += 1) {
      const read = await readStatus(deps, wallet.publicKey);
      if (read.status?.exists === true) {
        account = read.status;
        break;
      }
      if (look === 1) emit("  Waiting for the new account to appear on testnet ...");
      if (look < ACCOUNT_LOOKS) await deps.sleep(ACCOUNT_LOOK_GAP_MS);
    }
    if (account === undefined) problems.xlm = "Friendbot answered, and the account did not appear on testnet in time";
  }

  if (account !== undefined) {
    emit(
      `  Adding the USDC trustline and swapping ${TESTNET_SWAP_XLM} test XLM for test USDC on the public test ` +
        "exchange (up to a minute) ...",
    );
    try {
      const outcome = await deps.addUsdc(wallet.secretKey, role.variable);
      if (!outcome.swapped) problems.usdc = `no swap: ${outcome.why}`;
    } catch (error) {
      problems.trustline = messageOf(error);
    }
  }

  const final: { readonly status?: WalletStatus; readonly error?: string } =
    account === undefined ? {} : await readStatus(deps, wallet.publicKey);
  for (const row of payerRows(role, final.status, problems, final.error)) emit(row);
}

/** The channel's commitment key: checked when it is set, never made (Najmi, 2026-11-27). */
function commitmentLines(role: Extract<Role, { kind: "commitment" }>, request: KeySetupRequest, file: EnvFileNames | undefined): string[] {
  const channel = request.channel === undefined ? "the route's channel" : `channel ${request.channel}`;
  const value = (request.env[role.variable] ?? "").trim();
  if (value !== "") {
    if (!/^[0-9a-fA-F]{64}$/.test(value)) {
      return [`  ${role.variable}: set, and not 64 hex characters: init does not change it.`];
    }
    return [
      `  ${role.variable}: set, kept. init cannot check that it is the key ${channel} was opened with: MPP-11, ` +
        "MPP-12 and MPP-14 fail if it is not.",
    ];
  }
  const which = `the secret (64 hex characters) of the commitment key ${channel} was opened with`;
  const hidden = file === undefined ? undefined : hiddenByEnvironment(request, role.variable, file);
  if (hidden === "line") return [hiddenLine(role.variable)];
  if (hidden === "no line") {
    return [`  ${emptyInEnvironment(role.variable)} Unset it there (${unsetHint(role.variable)}), then put in .env ${which}.`];
  }
  if (file?.names.has(role.variable) === true) {
    return [`  ${role.variable}: in .env without a value: init does not change it.`];
  }
  return [
    `  ${role.variable}: not set. Put in .env ${which}. init makes none: the channel's server checks each commitment ` +
      "against that key, and a new one would not match it.",
  ];
}

/**
 * The key setup for one route. Every line goes to `request.say` as it comes
 * (what was done to keep `.env` out of git, each step, and the status table)
 * and is returned as well, in the same order.
 */
export async function setUpTestKeys(request: KeySetupRequest, deps: KeySetupDeps): Promise<string[]> {
  const lines: string[] = [];
  const emit = (line: string): void => {
    lines.push(line);
    request.say(line);
  };

  // C3: never reachable for a class but `test`, before any file is read or any key is made.
  if (networkClass(request.network) !== "test") {
    emit("Test key: not set up: init sets up keys on test networks only, never for a mainnet.");
    return lines;
  }
  if (request.network !== KEY_SETUP_NETWORK) {
    for (const line of otherNetworkLines(request.network, request.protocol)) emit(line);
    return lines;
  }

  const role = keyRoleFor(request.protocol);
  emit(
    role.kind === "payer"
      ? `Test key for the payment checks of wasit run (${KEY_SETUP_NETWORK}, in .env):`
      : "Commitment key for the channel checks of wasit run (in .env):",
  );
  try {
    const protection = await protectEnv(request, deps);
    for (const line of protection.lines) emit(`  ${line}`);
    if (!protection.writable) emit(`  .env: init writes no key into it: ${protection.why}.`);

    const file = envFileNames(request.cwd);
    if (role.kind === "commitment") {
      for (const line of commitmentLines(role, request, "names" in file ? file : undefined)) emit(line);
      return lines;
    }

    const value = (request.env[role.variable] ?? "").trim();
    const hidden = "names" in file ? hiddenByEnvironment(request, role.variable, file) : undefined;
    if (value !== "") {
      await existingPayer(role, value, deps, emit);
    } else if ("problem" in file) {
      emit(`  ${role.variable}: not set, and init wrote none: ${file.problem}. ${byHand(role)}`);
    } else if (hidden === "line") {
      emit(hiddenLine(role.variable));
    } else if (hidden === "no line") {
      // Both must be true before a key goes into .env: the variable unset, and .env kept out of git.
      const unset = `${role.variable} is unset there (${unsetHint(role.variable)})`;
      const first = protection.writable || protection.hand.first === undefined ? `Once ${unset}` : `${protection.hand.first}, and ${unset}`;
      emit(`  ${emptyInEnvironment(role.variable)} ${byHand(role, { first })}`);
    } else if (file.names.has(role.variable)) {
      emit(`  ${role.variable}: in .env without a value: init does not change it. Fill it in, or delete the line.`);
    } else if (!protection.writable) {
      emit(`  ${role.variable}: not set, and init wrote none. ${byHand(role, protection.hand)}`);
    } else {
      await newPayer(role, request, deps, emit);
    }

    const testUsdc = SERVE_NETWORKS[KEY_SETUP_NETWORK]?.asset;
    if (request.asset !== undefined && request.asset !== testUsdc) {
      emit(`  note: the route asks to be paid in ${request.asset}, not in test USDC (${testUsdc}): init sets up test USDC only.`);
    }
  } catch (error) {
    emit(
      `  init stopped the key setup on an unexpected error (${messageOf(error)}). Anything it wrote to .env stays ` +
        "there; wasit wallet status shows the account.",
    );
  }
  return lines;
}
