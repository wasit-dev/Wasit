/**
 * `wasit wallet` — testnet-only convenience commands for the payer keys the
 * other subcommands already read from .env. `--network` takes testnets only
 * (the ones `wasit serve` poses on): Friendbot, the printed USDC issuer, and
 * the whole idea of a throwaway generated key only make sense on testnet, so
 * there is nothing here that could be pointed at a mainnet by mistake.
 * Stellar testnet is the default and the only network for the MPP roles; on
 * Base Sepolia and Solana devnet the x402 payer needs USDC from Circle's
 * faucet and no native token, since the facilitator pays the fee.
 *
 * Every failure path here exits 2 (configuration) or 1 (the operation ran and
 * failed) with a single-line message, the same contract the check subcommands
 * follow — core's wallet layer classifies its own errors, so nothing in this
 * file ever has to inspect a Stellar SDK error type to decide which it is.
 */

import type { Command } from "commander";
import { oraPromise } from "ora";
import {
  createUsdcTrustline,
  fundWithFriendbot,
  generateCommitmentKey,
  generateTestnetWallet,
  getTestnetWalletStatus,
  paymentChainFor,
  publicKeyFromSecret,
  sendUsdcFromDistributor,
  TESTNET_USDC_ISSUER,
  type AssetBalance,
  type FriendbotOutcome,
  type WalletStatus,
} from "@wasit-dev/core";

import { DEFAULT_SERVE_NETWORK, SERVE_NETWORKS } from "./serve.js";

type WalletRole = "x402" | "mpp-charge" | "mpp-channel";

/** Every role a key can be generated for. */
const ROLES: readonly WalletRole[] = ["x402", "mpp-charge", "mpp-channel"];

/**
 * Roles that own a funded Stellar account, and are therefore the only ones
 * `status` and `fund` can say anything about. `mpp-channel` is deliberately
 * absent: `COMMITMENT_SECRET_HEX` is a raw ed25519 seed that only ever signs
 * commitment bytes off-chain, so it has no address and no balance to report.
 */
const ACCOUNT_ROLES: readonly WalletRole[] = ["x402", "mpp-charge"];

/** Which .env variable holds each role's key. */
const ROLE_ENV_VAR: Record<WalletRole, string> = {
  x402: "STELLAR_PRIVATE_KEY",
  "mpp-charge": "MPP_PAYER_SECRET",
  "mpp-channel": "COMMITMENT_SECRET_HEX",
};

/**
 * Validates --role against the roles the calling subcommand actually
 * supports, printing the same "Unknown option" style as the rest of the CLI.
 *
 * `allowed` is per-subcommand rather than global because `create` works for
 * all three roles while `status` and `fund` only work for the two that have
 * an on-chain account. Accepting a role a subcommand cannot serve and only
 * discovering it deeper in — where it surfaced as an SDK stack trace — was
 * the behavior this replaces.
 */
function requireRole(value: string | undefined, allowed: readonly WalletRole[]): WalletRole {
  if (value !== undefined && (allowed as readonly string[]).includes(value)) {
    return value as WalletRole;
  }

  if (value === undefined) {
    console.error(`--role is required. Expected one of: ${allowed.join(", ")}.`);
    process.exit(2);
  }

  const knownButUnsupported = (ROLES as readonly string[]).includes(value);
  console.error(
    knownButUnsupported
      ? `--role "${value}" is not supported by this command. Expected one of: ` +
          `${allowed.join(", ")}. ${ROLE_ENV_VAR[value as WalletRole]} signs off-chain ` +
          `and has no account to inspect or fund — see docs/guides/configuration.md.`
      : `Unknown --role "${value}". Expected one of: ${allowed.join(", ")}.`,
  );
  process.exit(2);
}

/**
 * Resolves a role's configured secret to its public key, exiting 2 with a
 * readable message when the variable is unset or holds something that is not
 * a Stellar secret key. Without this a typo in .env reached
 * `Keypair.fromSecret` unguarded and terminated the process with an SDK stack
 * trace instead of the CLI's own error contract.
 */
function resolvePublicKey(role: WalletRole): { secret: string; publicKey: string } {
  const envVar = ROLE_ENV_VAR[role];
  const secret = process.env[envVar];
  if (!secret) {
    console.error(`${envVar} is not set. Run \`wasit wallet create --role ${role}\` first.`);
    process.exit(2);
  }
  try {
    return { secret, publicKey: publicKeyFromSecret(secret, envVar) };
  } catch (error) {
    console.error(messageOf(error));
    process.exit(2);
  }
}

/** The testnets `wasit wallet` takes: the ones `wasit serve` poses on. */
export const WALLET_NETWORKS: readonly string[] = Object.keys(SERVE_NETWORKS);

/**
 * Checks --network against the testnets, and the role against the network:
 * the MPP roles are Stellar only. Returns the problem, or undefined.
 */
export function walletNetworkProblem(network: string, role: WalletRole): string | undefined {
  if (!WALLET_NETWORKS.includes(network)) {
    return `Unknown --network "${network}". Expected a testnet: ${WALLET_NETWORKS.join(", ")}.`;
  }
  if (network !== DEFAULT_SERVE_NETWORK && role !== "x402") {
    return `--role ${role} is Stellar only: MPP runs on Stellar. Only --role x402 takes --network ${network}.`;
  }
  return undefined;
}

function requireNetwork(value: string | undefined, role: WalletRole): string {
  const network = value ?? DEFAULT_SERVE_NETWORK;
  const problem = walletNetworkProblem(network, role);
  if (problem !== undefined) {
    console.error(problem);
    process.exit(2);
  }
  return network;
}

/** Base units as a decimal amount, e.g. 19970000 with 6 decimals as 19.97. */
export function formatUnits(units: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${units / scale}${fraction === "" ? "" : `.${fraction}`}`;
}

/** Where a payer on `network` gets its USDC, and what it does not need. */
function faucetLines(network: string, address: string): string[] {
  const profile = SERVE_NETWORKS[network]!;
  return [
    `Fund it with USDC at https://faucet.circle.com (network ${profile.faucetNetwork}),`,
    `pasting ${address}.`,
    `It needs no ${profile.nativeToken}: the facilitator pays the fee.`,
  ];
}

/** What `wallet create --role x402 --network <not Stellar>` prints. */
export function generatedKeyLines(network: string, secret: string): string[] {
  const chain = paymentChainFor(network)!;
  const address = chain.payerAddress(secret);
  return [
    `Generated a new ${SERVE_NETWORKS[network]!.name} key for x402:`,
    "",
    `Address: ${address}`,
    `Secret:  ${secret}`,
    "",
    "Paste into .env:",
    "",
    `${chain.payerKeyEnv}=${secret}`,
    "",
    ...faucetLines(network, address),
    "",
    "Testnet only — never reuse this key, and never put a mainnet key here.",
  ];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Says what Friendbot actually did, rather than always claiming a transfer. */
function friendbotText(outcome: FriendbotOutcome): string {
  return outcome === "funded"
    ? "Funded: 10,000 XLM."
    : "Already funded — Friendbot left the existing balance alone.";
}

function formatBalance(balance: AssetBalance): string {
  const note = balance.issuer === TESTNET_USDC_ISSUER ? "  (Circle testnet USDC)" : "";
  return `    ${balance.code.padEnd(10)} ${balance.balance}${note}`;
}

/** One role's row in `wallet status`. */
export interface WalletStatusRow {
  readonly configured: boolean;
  readonly status?: unknown;
  readonly error?: string;
}

/**
 * The exit code for `wallet status`.
 *
 * With `--role`, the command answers one question, so it exits 2 whenever it
 * could not answer it: the key is not set, cannot be read, or its balance
 * could not be looked up. Otherwise `wasit wallet status --role x402 && deploy`
 * proceeds on a key that was never checked. An account that does not exist
 * yet is an answer, and exits 0. Without `--role` it reports every role as a
 * table, and one role it could not check is a row, not a failed command.
 */
export function walletStatusExitCode(
  explicitRole: boolean,
  rows: readonly WalletStatusRow[],
): 0 | 2 {
  if (!explicitRole) return 0;
  // Only a role that was actually looked up has a status.
  return rows.every((row) => row.status !== undefined) ? 0 : 2;
}

function printWalletStatus(role: WalletRole, publicKey: string, status: WalletStatus): void {
  console.log(`${role}  ${publicKey}`);
  if (!status.exists) {
    console.log(`    Not yet created on-chain. Run: wasit wallet fund --role ${role}`);
    return;
  }
  for (const balance of status.balances) {
    console.log(formatBalance(balance));
  }
}

/**
 * The configured x402 payer on a network other than Stellar testnet, exiting
 * 2 when its key is unset or is not a key for that chain. The message never
 * echoes the key.
 */
function resolvePayer(network: string): { address: string } {
  const chain = paymentChainFor(network)!;
  const secret = process.env[chain.payerKeyEnv];
  if (!secret) {
    console.error(
      `${chain.payerKeyEnv} is not set. Run \`wasit wallet create --role x402 --network ${network}\` first.`,
    );
    process.exit(2);
  }
  try {
    return { address: chain.payerAddress(secret) };
  } catch {
    console.error(`${chain.payerKeyEnv} is not a ${chain.name} key.`);
    process.exit(2);
  }
}

/**
 * Prints the x402 payer's USDC balance on a network other than Stellar
 * testnet, and returns the exit code: 2 when it could not be read, since
 * `wallet status` must not pass on a balance it never saw.
 */
async function printPayerStatus(network: string, jsonMode: boolean): Promise<0 | 2> {
  const chain = paymentChainFor(network)!;
  const profile = SERVE_NETWORKS[network]!;
  const { address } = resolvePayer(network);
  let balance: bigint | undefined;
  let error: string | undefined;
  try {
    const read = chain.payerBalance(network, chain.resolveRpcUrl(network), address, profile.asset);
    balance = jsonMode ? await read : await oraPromise(read, `Checking x402 on ${profile.name}...`);
    if (balance === undefined) error = "the chain gave no balance";
  } catch (caught) {
    error = messageOf(caught);
  }
  if (jsonMode) {
    console.log(
      JSON.stringify(
        [{ role: "x402", network, address, usdc: balance === undefined ? undefined : formatUnits(balance, profile.decimals), error }],
        null,
        2,
      ),
    );
  } else {
    console.log(`x402  ${address}  (${profile.name})`);
    console.log(
      balance === undefined
        ? `    Could not check: ${error}`
        : `    ${"USDC".padEnd(10)} ${formatUnits(balance, profile.decimals)}`,
    );
    if (balance === 0n) for (const line of faucetLines(network, address)) console.log(`    ${line}`);
  }
  return balance === undefined ? 2 : 0;
}

export function registerWalletCommand(program: Command): void {
  const wallet = program
    .command("wallet")
    .description(
      "Generate, fund, and inspect disposable testnet wallets: Stellar's payers, and the x402 payer on Base Sepolia, Ethereum Sepolia and Solana devnet",
    );

  wallet
    .command("status")
    .description("Show balances for the configured payer role(s)")
    .option("--role <role>", `One of: ${ACCOUNT_ROLES.join(", ")}. Default: check both.`)
    .option("--network <network>", `Testnet: ${WALLET_NETWORKS.join(", ")}`, DEFAULT_SERVE_NETWORK)
    .option("--json", "Print as JSON instead of formatted text", false)
    .addHelpText(
      "after",
      `
Examples:
  $ wasit wallet status
  $ wasit wallet status --role mpp-charge --json
  $ wasit wallet status --network eip155:84532

With --role, exits 2 if that role could not be checked (key not set,
unreadable, or lookup failed); without it, every role is a row and it exits 0.

Testnet only. On a network other than Stellar testnet it shows the x402
payer's USDC balance. mpp-channel is not accepted here
even when configured: COMMITMENT_SECRET_HEX only ever signs off-chain (see
docs/guides/configuration.md) and has no on-chain balance of its own.`,
    )
    .action(async (opts) => {
      const jsonMode = opts.json === true;
      if (opts.network !== DEFAULT_SERVE_NETWORK) {
        const role = opts.role === undefined ? "x402" : requireRole(opts.role, ACCOUNT_ROLES);
        const network = requireNetwork(opts.network, role);
        process.exit(await printPayerStatus(network, jsonMode));
      }
      const roles: readonly WalletRole[] =
        opts.role !== undefined ? [requireRole(opts.role, ACCOUNT_ROLES)] : ACCOUNT_ROLES;

      const rows: Array<{
        role: WalletRole;
        configured: boolean;
        publicKey?: string;
        status?: WalletStatus;
        error?: string;
      }> = [];

      for (const role of roles) {
        const envVar = ROLE_ENV_VAR[role];
        const secret = process.env[envVar];
        if (!secret) {
          rows.push({ role, configured: false });
          continue;
        }

        // A malformed key is this role's own problem, not the run's: the
        // other role is still worth reporting, so it is recorded as that
        // row's error rather than exiting the whole command.
        let publicKey: string;
        try {
          publicKey = publicKeyFromSecret(secret, envVar);
        } catch (error) {
          rows.push({ role, configured: true, error: messageOf(error) });
          continue;
        }

        try {
          const status = jsonMode
            ? await getTestnetWalletStatus(publicKey)
            : await oraPromise(getTestnetWalletStatus(publicKey), `Checking ${role}...`);
          rows.push({ role, configured: true, publicKey, status });
        } catch (error) {
          // One role's Horizon lookup failing (a network hiccup, most
          // likely) should not stop the rest of the roles from reporting.
          rows.push({ role, configured: true, publicKey, error: messageOf(error) });
        }
      }

      const exitCode = walletStatusExitCode(opts.role !== undefined, rows);

      if (jsonMode) {
        console.log(JSON.stringify(rows, null, 2));
        process.exit(exitCode);
      }

      for (const row of rows) {
        if (!row.configured) {
          console.log(`${row.role}  (${ROLE_ENV_VAR[row.role]} not set)`);
          continue;
        }
        if (row.error !== undefined) {
          console.log(`${row.role}  ${row.publicKey ?? `(${ROLE_ENV_VAR[row.role]} unreadable)`}`);
          console.log(`    Could not check: ${row.error}`);
          continue;
        }
        printWalletStatus(row.role, row.publicKey as string, row.status as WalletStatus);
      }
      process.exit(exitCode);
    });

  wallet
    .command("create")
    .description("Generate a new testnet key for a payer role")
    .requiredOption("--role <role>", `One of: ${ROLES.join(", ")}`)
    .option("--network <network>", `Testnet: ${WALLET_NETWORKS.join(", ")}`, DEFAULT_SERVE_NETWORK)
    .option("--fund", "Immediately fund the new key with testnet XLM (Stellar only)", false)
    .addHelpText(
      "after",
      `
Examples:
  $ wasit wallet create --role mpp-charge --fund
  $ wasit wallet create --role mpp-channel
  $ wasit wallet create --role x402 --network eip155:84532
  $ wasit wallet create --role x402 --network solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1

Testnet only. Prints the exact .env line(s) to paste — never writes to .env
itself, so it can never silently overwrite something already there.

The generated secret is printed to stdout: do not run this on a screen you
are recording, and never paste a pubnet key into these variables.`,
    )
    .action(async (opts) => {
      const role = requireRole(opts.role, ROLES);
      const network = requireNetwork(opts.network, role);

      if (network !== DEFAULT_SERVE_NETWORK) {
        if (opts.fund === true) {
          console.error(
            `--fund is Stellar only (Friendbot). On ${SERVE_NETWORKS[network]!.name} the payer ` +
              "needs USDC from https://faucet.circle.com and nothing else.",
          );
          process.exit(2);
        }
        for (const line of generatedKeyLines(network, paymentChainFor(network)!.generatePayerKey())) {
          console.log(line);
        }
        return;
      }

      if (role === "mpp-channel") {
        const key = generateCommitmentKey();
        console.log(
          "Generated a new MPP commitment key (a signing key, not a funded account " +
            "— see docs/guides/configuration.md):\n",
        );
        console.log("Paste into .env:\n");
        console.log(`COMMITMENT_SECRET_HEX=${key.secretHex}`);
        console.log(`COMMITMENT_PUBKEY_HEX=${key.publicKeyHex}`);
        return;
      }

      const generated = generateTestnetWallet();
      console.log(`Generated a new testnet keypair for ${role}:\n`);
      console.log(`Public:  ${generated.publicKey}`);
      console.log(`Secret:  ${generated.secretKey}\n`);
      console.log("Paste into .env:\n");
      if (role === "x402") {
        console.log(`STELLAR_PRIVATE_KEY=${generated.secretKey}`);
      } else {
        console.log(`MPP_PAYER_SECRET=${generated.secretKey}`);
        console.log(`MPP_PAYER_PUBLIC=${generated.publicKey}`);
      }
      console.log("\nTestnet only — never reuse this key, and never put a pubnet secret here.");

      if (opts.fund === true) {
        console.log();
        try {
          await oraPromise(fundWithFriendbot(generated.publicKey), {
            text: "Funding with testnet XLM via Friendbot...",
            successText: (result) => friendbotText(result),
            failText: (error) => `Could not fund via Friendbot: ${messageOf(error)}`,
          });
        } catch {
          process.exit(1);
        }
      }
    });

  wallet
    .command("fund")
    .description("Fund a configured payer role with testnet XLM or USDC")
    .requiredOption("--role <role>", `One of: ${ACCOUNT_ROLES.join(", ")}`)
    .option("--network <network>", `Testnet: ${WALLET_NETWORKS.join(", ")}`, DEFAULT_SERVE_NETWORK)
    .option("--asset <asset>", "xlm or usdc", "xlm")
    .option("--amount <amount>", "USDC amount to request from the distributor account", "50")
    .addHelpText(
      "after",
      `
Examples:
  $ wasit wallet fund --role mpp-charge
  $ wasit wallet fund --role mpp-charge --asset usdc

--asset xlm calls Stellar's public Friendbot directly — fully automatic.
--asset usdc creates a trustline to Circle's testnet USDC automatically, but
actually receiving a balance needs either a manual visit to
https://faucet.circle.com (paste the printed public key) or
WASIT_USDC_DISTRIBUTOR_SECRET set in .env, naming an account you already
funded that way once — there is no scriptable USDC faucet for Stellar.

On another network (--network) there is nothing to do on-chain first: it
prints where to get USDC for the configured x402 payer.`,
    )
    .action(async (opts) => {
      const role = requireRole(opts.role, ACCOUNT_ROLES);
      const network = requireNetwork(opts.network, role);
      if (network !== DEFAULT_SERVE_NETWORK) {
        const { address } = resolvePayer(network);
        console.log(`No faucet can be called for ${SERVE_NETWORKS[network]!.name} from here.`);
        for (const line of faucetLines(network, address)) console.log(line);
        return;
      }
      const { secret, publicKey } = resolvePublicKey(role);
      const asset: string = opts.asset;

      if (asset !== "xlm" && asset !== "usdc") {
        console.error(`Unknown --asset "${asset}". Expected "xlm" or "usdc".`);
        process.exit(2);
      }

      if (asset === "xlm") {
        try {
          await oraPromise(fundWithFriendbot(publicKey), {
            text: `Funding ${publicKey} with testnet XLM via Friendbot...`,
            successText: (result) => friendbotText(result),
            failText: (error) => `Could not fund via Friendbot: ${messageOf(error)}`,
          });
        } catch {
          process.exit(1);
        }
        return;
      }

      let before: WalletStatus;
      try {
        before = await oraPromise(getTestnetWalletStatus(publicKey), "Checking XLM balance...");
      } catch (error) {
        console.error(`Could not read the account: ${messageOf(error)}`);
        process.exit(1);
      }

      const xlmBalance = before.balances.find((balance) => balance.code === "XLM");
      if (!before.exists || Number(xlmBalance?.balance ?? "0") < 2) {
        try {
          await oraPromise(fundWithFriendbot(publicKey), {
            text: "Funding XLM first — a trustline needs a small reserve and fee...",
            successText: (result) => friendbotText(result),
            failText: (error) => `Could not fund via Friendbot: ${messageOf(error)}`,
          });
        } catch {
          process.exit(1);
        }
      }

      try {
        await oraPromise(createUsdcTrustline(secret, ROLE_ENV_VAR[role]), {
          text: "Creating a trustline to testnet USDC...",
          successText: "Trustline created.",
          failText: (error) => `Could not create the trustline: ${messageOf(error)}`,
        });
      } catch {
        process.exit(1);
      }

      const distributorSecret = process.env.WASIT_USDC_DISTRIBUTOR_SECRET;
      if (!distributorSecret) {
        console.log(
          `\nNo USDC balance yet. Get some at https://faucet.circle.com ` +
            `(Stellar Testnet, paste ${publicKey}),\n` +
            "or set WASIT_USDC_DISTRIBUTOR_SECRET in .env to an account you've already funded " +
            "that\nway, then rerun this command to send automatically.",
        );
        return;
      }

      const amount: string = opts.amount;
      try {
        await oraPromise(sendUsdcFromDistributor(distributorSecret, publicKey, amount), {
          text: `Sending ${amount} USDC from the distributor account...`,
          successText: `Sent ${amount} USDC.`,
          failText: (error) => `Could not send USDC: ${messageOf(error)}`,
        });
      } catch {
        process.exit(1);
      }
    });
}
