/**
 * The testnet key setup of `wasit init` (spec C4, C6, C7 rows 2, 3 and 5;
 * Najmi's decisions of 2026-11-27; W3-2 slice 5), in process. Friendbot,
 * Horizon and the exchange are stood in for by a small ledger in memory, and
 * git by answers given per test (and, in one block, by the real git in a new
 * repository). Nothing leaves the machine. The key a test makes is captured
 * through the generator seam, so every printed line can be searched for it
 * (the canary of B6).
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";
import { ConfigurationError, TESTNET_USDC_ISSUER, type UsdcSetupOutcome, type WalletStatus } from "@wasit-dev/core";

import { executeInit, type InitCommandOptions } from "../../src/init-command.js";
import {
  runGit,
  setUpTestKeys,
  type GitAnswer,
  type KeySetupDeps,
  type KeySetupRequest,
} from "../../src/init-keys.js";

const CHANNEL = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "wasit-init-keys-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const envPath = (): string => path.join(dir, ".env");
const gitignorePath = (): string => path.join(dir, ".gitignore");

/** Every form of a secret key a line could carry. */
function needles(secret: string): string[] {
  const raw = Keypair.fromSecret(secret).rawSecretKey();
  return [secret, raw.toString("hex"), raw.toString("base64"), raw.toString("base64url")];
}

function assertNoSecret(label: string, text: string, secret: string): void {
  for (const needle of needles(secret)) assert.ok(!text.includes(needle), `${label} carries the secret`);
}

/** git answers for a repository: `.env` tracked or not, ignored or not, and ignored once added to .gitignore. */
function repo(state: { tracked?: boolean; ignored?: boolean; ignoredOnceAdded?: boolean } = {}) {
  const { tracked = false, ignored = true, ignoredOnceAdded = true } = state;
  return (args: readonly string[]): GitAnswer => {
    if (args[0] === "rev-parse") return { code: 0, stdout: "true\n" };
    if (args[0] === "ls-files") return { code: tracked ? 0 : 1, stdout: tracked ? ".env\n" : "" };
    if (args[0] === "check-ignore") {
      const added = existsSync(gitignorePath()) && readFileSync(gitignorePath(), "utf-8").split(/\r?\n/).includes(".env");
      return { code: ignored || (added && ignoredOnceAdded) ? 0 : 1, stdout: "" };
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

const notARepository = (): GitAnswer => ({ code: 128, stdout: "" });
const gitMissing = (): GitAnswer => ({ code: null, stdout: "" });

interface World {
  readonly deps: KeySetupDeps;
  readonly calls: string[];
  /** The secret of each key made, in order. */
  readonly made: string[];
}

/**
 * A ledger in memory: Friendbot creates the account, the USDC step adds the
 * trustline and, when it swaps, test USDC. `fund`, `appearAfter` and `usdc`
 * change what the network does.
 */
function world(
  git: (args: readonly string[]) => GitAnswer,
  options: { fund?: "ok" | "limit"; appearAfter?: number; usdc?: "swap" | "no-swap" | "fail"; statusFails?: boolean } = {},
): World {
  const calls: string[] = [];
  const made: string[] = [];
  const accounts = new Map<string, { xlm: string; trust: boolean; usdc: string }>();
  let looks = 0;
  const deps: KeySetupDeps = {
    git: async (args, cwd) => {
      assert.equal(cwd, dir);
      calls.push(`git ${args.join(" ")}`);
      return git(args);
    },
    generateWallet: () => {
      calls.push("generate");
      const keypair = Keypair.random();
      made.push(keypair.secret());
      return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
    },
    fund: async (publicKey) => {
      calls.push("fund");
      if (options.fund === "limit") {
        throw new ConfigurationError(`Could not fund ${publicKey} via Friendbot after 3 attempts: Friendbot responded 429: rate limited`);
      }
      accounts.set(publicKey, { xlm: "10000.0000000", trust: false, usdc: "0.0000000" });
      return "funded";
    },
    status: async (publicKey): Promise<WalletStatus> => {
      calls.push("status");
      if (options.statusFails === true) throw new Error("Horizon is down");
      looks += 1;
      const account = accounts.get(publicKey);
      if (account === undefined || looks <= (options.appearAfter ?? 0)) return { publicKey, exists: false, balances: [] };
      return {
        publicKey,
        exists: true,
        balances: [
          { code: "XLM", balance: account.xlm },
          ...(account.trust ? [{ code: "USDC", issuer: TESTNET_USDC_ISSUER, balance: account.usdc }] : []),
        ],
      };
    },
    addUsdc: async (secretKey, source): Promise<UsdcSetupOutcome> => {
      calls.push(`addUsdc ${source}`);
      if (options.usdc === "fail") throw new ConfigurationError("Could not create the USDC trustline: op_low_reserve");
      const account = accounts.get(Keypair.fromSecret(secretKey).publicKey())!;
      account.trust = true;
      if (options.usdc === "no-swap") return { swapped: false, why: "the public test exchange gave no usable price" };
      account.xlm = "9990.0000000";
      account.usdc = "8.8123456";
      return { swapped: true };
    },
    sleep: async () => {
      calls.push("sleep");
    },
  };
  return { deps, calls, made };
}

/** Deps that fail the test when anything is touched. */
const untouchable: KeySetupDeps = {
  git: async () => assert.fail("git was run"),
  generateWallet: () => assert.fail("a key was made"),
  fund: async () => assert.fail("Friendbot was called"),
  status: async () => assert.fail("Horizon was read"),
  addUsdc: async () => assert.fail("a trustline was signed"),
  sleep: async () => assert.fail("it waited"),
};

async function setUp(
  deps: KeySetupDeps,
  overrides: Partial<KeySetupRequest> = {},
): Promise<{ readonly lines: string[]; readonly said: string[]; readonly redacted: string[]; readonly text: string }> {
  const said: string[] = [];
  const redacted: string[] = [];
  const lines = await setUpTestKeys(
    {
      network: "stellar:testnet",
      protocol: "x402",
      asset: TESTNET_USDC,
      cwd: dir,
      env: {},
      allowGitignore: async () => true,
      say: (line) => said.push(line),
      redact: (value) => redacted.push(value),
      ...overrides,
    },
    deps,
  );
  return { lines, said, redacted, text: lines.join("\n") };
}

describe("key setup: the network comes first (C3)", () => {
  for (const network of ["stellar:pubnet", "eip155:1", "not-a-network"]) {
    it(`${network}: returns before anything is read, run or made`, async () => {
      const { text, said } = await setUp(untouchable, { network, env: { STELLAR_PRIVATE_KEY: "" } });
      assert.match(text, /not set up: init sets up keys on test networks only, never for a mainnet/);
      assert.deepEqual(said, [text]);
      assert.deepEqual(readdirSync(dir), []);
    });
  }

  it("a test network of another chain: the variable and the faucet, no key", async () => {
    const { text } = await setUp(untouchable, { network: "eip155:84532" });
    assert.match(text, /On Base Sepolia the payment checks of wasit run read EVM_PRIVATE_KEY from \.env/);
    assert.match(text, /https:\/\/faucet\.circle\.com \(network Base Sepolia\)/);
    assert.deepEqual(readdirSync(dir), []);
  });
});

describe("key setup: a new x402 payer", () => {
  it("writes the key to a new .env (owner only), prints only its address, funds it, and reports it ready", async () => {
    const w = world(repo());
    const { text, redacted } = await setUp(w.deps);
    const secret = w.made[0]!;
    const address = Keypair.fromSecret(secret).publicKey();

    assert.equal(readFileSync(envPath(), "utf-8"), `STELLAR_PRIVATE_KEY=${secret}\n`);
    if (process.platform !== "win32") assert.equal(lstatSync(envPath()).mode & 0o777, 0o600);
    assert.deepEqual(redacted, [secret]);
    assertNoSecret("the output", text, secret);
    assert.match(text, new RegExp(`STELLAR_PRIVATE_KEY: new, written to \\.env \\(the secret is not shown\\), address ${address}`));
    assert.match(text, /\.env is ignored by git and not tracked/);
    assert.match(text, /XLM: {7}ready, 9990\.0000000 XLM/);
    assert.match(text, /trustline: ready/);
    assert.match(text, /USDC: {6}ready, 8\.8123456 USDC/);
    // git first, the key only after it, funded only after it was written.
    assert.deepEqual(w.calls, [
      "git rev-parse --is-inside-work-tree",
      "git ls-files --error-unmatch -- .env",
      "git check-ignore -q -- .env",
      "generate",
      "fund",
      "status",
      "addUsdc STELLAR_PRIVATE_KEY",
      "status",
    ]);
  });

  it("appends to an existing .env, never rewriting it, in its own line ending", async () => {
    const before = "# mine\r\nFOO=1\r\nBAR=two";
    writeFileSync(envPath(), before);
    const w = world(repo());
    await setUp(w.deps);
    assert.equal(readFileSync(envPath(), "utf-8"), `${before}\r\nSTELLAR_PRIVATE_KEY=${w.made[0]}\r\n`);
  });

  it("an MPP charge route: MPP_PAYER_SECRET, and its own wallet role in the hints", async () => {
    const w = world(repo(), { usdc: "no-swap" });
    const { text } = await setUp(w.deps, { protocol: "mpp-charge" });
    assert.equal(readFileSync(envPath(), "utf-8"), `MPP_PAYER_SECRET=${w.made[0]}\n`);
    assert.ok(w.calls.includes("addUsdc MPP_PAYER_SECRET"));
    assert.match(text, /USDC: {6}missing: no swap: the public test exchange gave no usable price\. Get test USDC at https:\/\/faucet\.circle\.com/);
    assert.doesNotMatch(text, /--role x402/);
  });
});

describe("key setup: reuse, never overwrite (C4 step 2)", () => {
  it("a key already set is kept: only its account is read, .env is not touched", async () => {
    const canary = Keypair.random();
    writeFileSync(envPath(), `STELLAR_PRIVATE_KEY=${canary.secret()}\n`);
    const w = world(repo());
    const { text } = await setUp(w.deps, { env: { STELLAR_PRIVATE_KEY: canary.secret() } });
    assert.equal(readFileSync(envPath(), "utf-8"), `STELLAR_PRIVATE_KEY=${canary.secret()}\n`);
    assert.ok(!w.calls.includes("generate") && !w.calls.includes("fund") && !w.calls.some((call) => call.startsWith("addUsdc")));
    assert.match(text, new RegExp(`set, kept \\(init never overwrites a key\\), address ${canary.publicKey()}`));
    assert.match(text, /XLM: {7}missing: the account does not exist on testnet yet\. Later: wasit wallet fund --role x402/);
    assertNoSecret("the output", text, canary.secret());
  });

  it("a key that is not a Stellar secret is left alone, and not looked up", async () => {
    const w = world(repo());
    const { text } = await setUp(w.deps, { env: { STELLAR_PRIVATE_KEY: "GNOTASECRET" } });
    assert.match(text, /set, and not a Stellar secret key \(S\.\.\.\): init does not change it/);
    assert.ok(!w.calls.includes("status") && !w.calls.includes("generate"));
    assert.ok(!existsSync(envPath()));
  });

  it("a variable .env has without a value is not written again", async () => {
    writeFileSync(envPath(), "STELLAR_PRIVATE_KEY=\n");
    const w = world(repo());
    const { text } = await setUp(w.deps);
    assert.equal(readFileSync(envPath(), "utf-8"), "STELLAR_PRIVATE_KEY=\n");
    assert.match(text, /in \.env without a value: init does not change it/);
    assert.ok(!w.calls.includes("generate"));
  });
});

describe("key setup: .env protection comes first (C4 step 1, C7 row 2)", () => {
  it("a tracked .env gets no key, and the line to untrack it", async () => {
    const w = world(repo({ tracked: true }));
    const { text } = await setUp(w.deps);
    assert.match(text, /\.env is tracked by git.*git rm --cached \.env/);
    assert.match(text, /STELLAR_PRIVATE_KEY: not set, and init wrote none\. By hand: wasit wallet create --role x402 --fund/);
    assert.ok(!w.calls.includes("generate"));
    assert.ok(!existsSync(envPath()));
  });

  it("not ignored, and no to .gitignore: no key, .gitignore not created", async () => {
    const w = world(repo({ ignored: false }));
    const { text } = await setUp(w.deps, { allowGitignore: async () => false });
    assert.match(text, /\.env is not ignored by git, and \.gitignore was left as it is/);
    assert.ok(!existsSync(gitignorePath()) && !existsSync(envPath()));
    assert.ok(!w.calls.includes("generate"));
  });

  it("not ignored, and yes: .env is added to .gitignore, checked again, then the key is written", async () => {
    writeFileSync(gitignorePath(), "node_modules");
    const w = world(repo({ ignored: false }));
    const { text } = await setUp(w.deps);
    assert.equal(readFileSync(gitignorePath(), "utf-8"), "node_modules\n.env\n");
    assert.match(text, /init added \.env to \.gitignore, and git now ignores it \(commit that change\)/);
    assert.equal(w.calls.filter((call) => call.startsWith("git check-ignore")).length, 2);
    assert.ok(existsSync(envPath()));
  });

  it("still not ignored after adding it (a !.env rule): no key", async () => {
    const w = world(repo({ ignored: false, ignoredOnceAdded: false }));
    const { text } = await setUp(w.deps);
    assert.match(text, /git still does not ignore it/);
    assert.ok(!existsSync(envPath()) && !w.calls.includes("generate"));
  });

  it("not a git repository: .gitignore gets .env all the same, and the key is written", async () => {
    const w = world(notARepository);
    const { text } = await setUp(w.deps);
    assert.equal(readFileSync(gitignorePath(), "utf-8"), ".env\n");
    assert.match(text, /not a git repository: init added \.env to \.gitignore all the same/);
    assert.ok(existsSync(envPath()));
  });

  it("git that cannot run, in a folder with .git: no key", async () => {
    writeFileSync(path.join(dir, ".git"), "gitdir: elsewhere\n");
    const w = world(gitMissing);
    const { text } = await setUp(w.deps);
    assert.match(text, /git could not say whether \.env is tracked or ignored/);
    assert.ok(!existsSync(envPath()) && !w.calls.includes("generate"));
  });

  it("git that answers ls-files with an error: no key", async () => {
    const git = repo();
    const w = world((args) => (args[0] === "ls-files" ? { code: 128, stdout: "" } : git(args)));
    const { text } = await setUp(w.deps);
    assert.match(text, /git could not say whether \.env is tracked or ignored/);
    assert.ok(!existsSync(envPath()) && !w.calls.includes("generate"));
    assert.ok(!w.calls.some((call) => call.startsWith("git check-ignore")));
  });

  it("a folder inside .git (rev-parse says false): no key", async () => {
    const inside = path.join(dir, ".git");
    mkdirSync(inside);
    const w = world(repo());
    const git: KeySetupDeps["git"] = async (args) => (args[0] === "rev-parse" ? { code: 0, stdout: "false\n" } : repo()(args));
    const { text } = await setUp({ ...w.deps, git }, { cwd: inside });
    assert.match(text, /git could not say whether \.env is tracked or ignored/);
    assert.ok(!existsSync(path.join(inside, ".env")));
  });

  it("DOTENV_CONFIG_PATH set: no key, since wasit reads another file", async () => {
    const w = world(repo());
    const { text } = await setUp(w.deps, { env: { DOTENV_CONFIG_PATH: "/somewhere/.env" } });
    assert.match(text, /DOTENV_CONFIG_PATH is set/);
    assert.ok(!existsSync(envPath()) && w.calls.length === 0);
  });

  it(".env that is a link: no key, and the file it points to is not changed", { skip: process.platform === "win32" }, async () => {
    const target = path.join(dir, "elsewhere.env");
    writeFileSync(target, "FOO=1\n");
    symlinkSync(target, envPath());
    const w = world(repo());
    const { text } = await setUp(w.deps);
    assert.match(text, /\.env is not a plain file/);
    assert.equal(readFileSync(target, "utf-8"), "FOO=1\n");
    assert.ok(!w.calls.includes("generate"));
  });
});

describe("key setup: what fails is said, and the rest goes on (C4 step 4)", () => {
  it("Friendbot's limit: the key stays in .env, and the table says how to finish", async () => {
    const w = world(repo(), { fund: "limit" });
    const { text } = await setUp(w.deps);
    assert.match(readFileSync(envPath(), "utf-8"), /^STELLAR_PRIVATE_KEY=S[A-Z2-7]{55}\n$/);
    assert.match(text, /XLM: {7}missing: Friendbot did not fund it \(.*429.*\)\. Later: wasit wallet fund --role x402$/m);
    assert.match(text, /trustline: missing: it needs the account first\. Later: wasit wallet fund --role x402 --asset usdc/);
    assert.match(text, /USDC: {6}missing\. Get test USDC .*, once the trustline is there/);
    assert.ok(!w.calls.some((call) => call.startsWith("addUsdc")));
    assertNoSecret("the output", text, w.made[0]!);
  });

  it("an account that appears late is waited for", async () => {
    const w = world(repo(), { appearAfter: 2 });
    const { text } = await setUp(w.deps);
    assert.equal(w.calls.filter((call) => call === "sleep").length, 2);
    assert.equal(text.match(/Waiting for the new account/g)?.length, 1);
    assert.match(text, /USDC: {6}ready/);
  });

  it("the wait is said on the first look that finds nothing, and only once", async () => {
    const w = world(repo(), { appearAfter: 1 });
    const { text } = await setUp(w.deps);
    assert.equal(text.match(/Waiting for the new account/g)?.length, 1);
    assert.equal(w.calls.filter((call) => call === "sleep").length, 1);
  });

  it("an account that never appears: eight looks, then the table says so", async () => {
    const w = world(repo(), { appearAfter: 100 });
    const { text } = await setUp(w.deps);
    assert.equal(w.calls.filter((call) => call === "status").length, 8);
    assert.equal(w.calls.filter((call) => call === "sleep").length, 7);
    assert.match(text, /XLM: {7}missing: Friendbot answered, and the account did not appear on testnet in time/);
    assert.ok(!w.calls.some((call) => call.startsWith("addUsdc")));
  });

  it("a trustline that fails: said, with the command that adds it later", async () => {
    const w = world(repo(), { usdc: "fail" });
    const { text } = await setUp(w.deps);
    assert.match(text, /trustline: missing: Could not create the USDC trustline: op_low_reserve\. Later: wasit wallet fund --role x402 --asset usdc/);
  });

  it("Horizon that cannot be read: the table says so, nothing throws", async () => {
    const w = world(repo(), { statusFails: true });
    const { text } = await setUp(w.deps, { env: { STELLAR_PRIVATE_KEY: Keypair.random().secret() } });
    assert.match(text, /could not read the account \(Horizon is down\): wasit wallet status --role x402 checks it/);
  });

  it("an unexpected error is a line, not a throw", async () => {
    const deps = { ...world(repo()).deps, git: async () => Promise.reject(new Error("boom")) };
    const { text } = await setUp(deps);
    assert.match(text, /init stopped the key setup on an unexpected error \(boom\)/);
  });

  it("a route paid in another asset than test USDC: a note", async () => {
    const w = world(repo());
    const { text } = await setUp(w.deps, { asset: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA" });
    assert.match(text, /note: the route asks to be paid in CAS3J7.*not in test USDC.*init sets up test USDC only/);
  });
});

describe("key setup: MPP channel (Najmi, 2026-11-27: no key made)", () => {
  it("not set: no key is made and nothing is written to .env; it says which key belongs there", async () => {
    const w = world(repo());
    const { text } = await setUp(w.deps, { protocol: "mpp-channel", channel: CHANNEL });
    assert.ok(!w.calls.includes("generate") && !w.calls.includes("fund"));
    assert.ok(!existsSync(envPath()));
    assert.match(text, new RegExp(`COMMITMENT_SECRET_HEX: not set\\. Put in \\.env the secret \\(64 hex characters\\) of the commitment key channel ${CHANNEL} was opened with`));
    assert.match(text, /a new one would not match it/);
  });

  it("set: kept, with the note that init cannot check it against the channel", async () => {
    const w = world(repo());
    const hex = "ab".repeat(32);
    const { text } = await setUp(w.deps, { protocol: "mpp-channel", channel: CHANNEL, env: { COMMITMENT_SECRET_HEX: hex } });
    assert.match(text, new RegExp(`set, kept\\. init cannot check that it is the key channel ${CHANNEL} was opened with`));
    assert.ok(!text.includes(hex));
  });

  it("in .env without a value: said, not changed", async () => {
    writeFileSync(envPath(), "COMMITMENT_SECRET_HEX=\n");
    const { text } = await setUp(world(repo()).deps, { protocol: "mpp-channel", channel: CHANNEL });
    assert.match(text, /COMMITMENT_SECRET_HEX: in \.env without a value: init does not change it/);
    assert.equal(readFileSync(envPath(), "utf-8"), "COMMITMENT_SECRET_HEX=\n");
  });

  it("set and not 64 hex characters: said, not changed", async () => {
    const { text } = await setUp(world(repo()).deps, { protocol: "mpp-channel", env: { COMMITMENT_SECRET_HEX: "xyz" } });
    assert.match(text, /set, and not 64 hex characters: init does not change it/);
  });
});

const realGit = spawnSync("git", ["--version"]).status === 0;

describe("key setup with the real git", { skip: !realGit }, () => {
  function gitIn(...args: string[]): void {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  }
  beforeEach(() => {
    gitIn("init", "-q");
    // The machine's own excludes must not decide the test.
    writeFileSync(path.join(dir, ".git", "no-excludes"), "");
    gitIn("config", "core.excludesFile", path.join(dir, ".git", "no-excludes"));
  });

  it("a new repository: .env is added to .gitignore, git then ignores it, the key is written", async () => {
    const w = world(() => assert.fail("the stand-in git was run"));
    const { text } = await setUp({ ...w.deps, git: runGit });
    assert.equal(readFileSync(gitignorePath(), "utf-8"), ".env\n");
    assert.match(text, /git now ignores it/);
    assert.equal(spawnSync("git", ["check-ignore", "-q", "--", ".env"], { cwd: dir }).status, 0);
    assert.match(readFileSync(envPath(), "utf-8"), /^STELLAR_PRIVATE_KEY=S/);
  });

  it("a tracked .env: no key", async () => {
    writeFileSync(envPath(), "FOO=1\n");
    gitIn("add", ".env");
    const w = world(() => assert.fail("the stand-in git was run"));
    const { text } = await setUp({ ...w.deps, git: runGit });
    assert.match(text, /\.env is tracked by git/);
    assert.equal(readFileSync(envPath(), "utf-8"), "FOO=1\n");
  });
});

describe("wasit init with the key setup", () => {
  async function init(flags: Partial<InitCommandOptions>, keys: KeySetupDeps, extra: { answers?: string[]; env?: Record<string, string> } = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const asked: string[] = [];
    const queue = extra.answers === undefined ? undefined : [...extra.answers];
    const code = await executeInit(
      { url: "http://127.0.0.1:4402/paid", operatedByMe: true, rejectHeader: [], config: "wasit.config.json", force: false, read: false, method: "GET", ...flags },
      {
        env: extra.env ?? {},
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
        cwd: dir,
        keys,
        ...(queue === undefined
          ? {}
          : {
              ask: async (question: string) => {
                asked.push(question);
                const next = queue.shift();
                if (next === undefined) throw new Error("closed");
                return next;
              },
            }),
      },
    );
    return { code, out, stdout: out.join("\n"), stderr: err.join("\n"), asked };
  }
  const configText = (): string => readFileSync(path.join(dir, "wasit.config.json"), "utf-8");

  it("--setup-keys: the config first, then the key, then the next command; the key is in no output and not in the config", async () => {
    const w = world(repo());
    const { code, out, stdout, stderr } = await init({ setupKeys: true }, w.deps);
    assert.equal(code, 0, stderr);
    const secret = w.made[0]!;
    assert.match(readFileSync(envPath(), "utf-8"), new RegExp(`^STELLAR_PRIVATE_KEY=${secret}\\n$`));
    assertNoSecret("stdout", stdout, secret);
    assertNoSecret("stderr", stderr, secret);
    assertNoSecret("the config", configText(), secret);
    const first = out.findIndex((line) => line.startsWith("wasit init: wrote"));
    const keys = out.findIndex((line) => line.startsWith("Test key for the payment checks"));
    assert.ok(first === 0 && keys > first, stdout);
    assert.equal(out.at(-1), "Next: wasit run --read-only");
    assert.match(stdout, /key setup: yes \(--setup-keys\)/);
  });

  it("not at a terminal, no flag: no key setup, nothing touched, and it says how", async () => {
    const { code, stdout } = await init({}, untouchable);
    assert.equal(code, 0);
    assert.match(stdout, /Test key: not set up \(init sets one up only with --setup-keys, or a yes at a terminal\)/);
    assert.ok(!existsSync(envPath()));
  });

  it("--no-setup-keys at a terminal: not asked", async () => {
    const { code, asked } = await init({ setupKeys: false, start: "npm start" }, untouchable, { answers: [] });
    assert.equal(code, 0);
    assert.deepEqual(asked, []);
  });

  it("at a terminal: a yes, then the .gitignore question, then the key", async () => {
    const w = world(repo({ ignored: false }));
    const { code, asked, stdout } = await init({ start: "npm start" }, w.deps, { answers: ["yes", "y"] });
    assert.equal(code, 0, stdout);
    assert.equal(asked.length, 2);
    assert.match(asked[1] ?? "", /\.env is not ignored by git\. Add \.env to \.gitignore\?/);
    assert.ok(readFileSync(gitignorePath(), "utf-8").includes(".env"));
    assert.ok(existsSync(envPath()));
  });

  for (const reply of ["", "no", "maybe", "yess"]) {
    it(`a reply of ${JSON.stringify(reply)} to the key question is a no`, async () => {
      const { code, stdout } = await init({ start: "npm start" }, untouchable, { answers: [reply] });
      assert.equal(code, 0);
      assert.match(stdout, /Test key: not set up \(you said no\)/);
    });
  }

  for (const reply of ["", "no", "maybe"]) {
    it(`a reply of ${JSON.stringify(reply)} to the .gitignore question is a no`, async () => {
      const w = world(repo({ ignored: false }));
      const { code } = await init({ start: "npm start" }, w.deps, { answers: ["Y", reply] });
      assert.equal(code, 0);
      assert.ok(!existsSync(gitignorePath()) && !existsSync(envPath()));
    });
  }

  it("input that ends at the .gitignore question is a no: the config stays written, no key, exit 0", async () => {
    const w = world(repo({ ignored: false }));
    const { code, stdout } = await init({ start: "npm start" }, w.deps, { answers: ["yes"] });
    assert.equal(code, 0);
    assert.ok(existsSync(path.join(dir, "wasit.config.json")));
    assert.ok(!existsSync(envPath()) && !existsSync(gitignorePath()));
    assert.match(stdout, /\.gitignore was left as it is/);
  });

  it("input that ends at the key question: nothing written, exit 2", async () => {
    const { code, stderr } = await init({ start: "npm start" }, untouchable, { answers: [] });
    assert.equal(code, 2);
    assert.match(stderr, /the input ended\. Nothing was written/);
    assert.ok(!existsSync(path.join(dir, "wasit.config.json")));
  });

  it("a tracked .env: the config is written, no key, exit 0", async () => {
    const w = world(repo({ tracked: true }));
    const { code, stdout } = await init({ setupKeys: true }, w.deps);
    assert.equal(code, 0);
    assert.ok(existsSync(path.join(dir, "wasit.config.json")));
    assert.match(stdout, /\.env is tracked by git/);
  });

  it("a key already set: kept, and in no output", async () => {
    const canary = Keypair.random().secret();
    const w = world(repo());
    const { stdout, stderr } = await init({ setupKeys: true }, w.deps, { env: { STELLAR_PRIVATE_KEY: canary } });
    assert.ok(!w.calls.includes("generate"));
    assertNoSecret("stdout", stdout, canary);
    assertNoSecret("stderr", stderr, canary);
  });

  it("--setup-keys on another test network: the faucet and the variable, nothing touched", async () => {
    const { code, stdout } = await init({ setupKeys: true, network: "eip155:84532" }, untouchable);
    assert.equal(code, 0);
    assert.match(stdout, /key setup: --setup-keys \(init sets up keys on stellar:testnet only\)/);
    assert.match(stdout, /read EVM_PRIVATE_KEY from \.env/);
  });
});
