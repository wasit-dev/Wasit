/**
 * `wasit wallet` — testnet-only convenience commands for the payer keys the
 * other subcommands already read from .env. Deliberately has no --network
 * flag: Friendbot, the printed USDC issuer, and the whole idea of a
 * throwaway generated key only make sense on testnet, so there is nothing
 * here that could be pointed at pubnet by mistake.
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
  publicKeyFromSecret,
  sendUsdcFromDistributor,
  TESTNET_USDC_ISSUER,
  type AssetBalance,
  type FriendbotOutcome,
  type WalletStatus,
} from "@wasit-dev/core";

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

export function registerWalletCommand(program: Command): void {
  const wallet = program
    .command("wallet")
    .description("Generate, fund, and inspect disposable Stellar testnet wallets");

  wallet
    .command("status")
    .description("Show balances for the configured payer role(s)")
    .option("--role <role>", `One of: ${ACCOUNT_ROLES.join(", ")}. Default: check both.`)
    .option("--json", "Print as JSON instead of formatted text", false)
    .addHelpText(
      "after",
      `
Examples:
  $ wasit wallet status
  $ wasit wallet status --role mpp-charge --json

With --role, exits 2 if that role could not be checked (key not set,
unreadable, or lookup failed); without it, every role is a row and it exits 0.

Testnet only — there is no --network flag. mpp-channel is not accepted here
even when configured: COMMITMENT_SECRET_HEX only ever signs off-chain (see
docs/guides/configuration.md) and has no on-chain balance of its own.`,
    )
    .action(async (opts) => {
      const jsonMode = opts.json === true;
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
    .option("--fund", "Immediately fund the new key with testnet XLM", false)
    .addHelpText(
      "after",
      `
Examples:
  $ wasit wallet create --role mpp-charge --fund
  $ wasit wallet create --role mpp-channel

Testnet only. Prints the exact .env line(s) to paste — never writes to .env
itself, so it can never silently overwrite something already there.

The generated secret is printed to stdout: do not run this on a screen you
are recording, and never paste a pubnet key into these variables.`,
    )
    .action(async (opts) => {
      const role = requireRole(opts.role, ROLES);

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
funded that way once — there is no scriptable USDC faucet for Stellar.`,
    )
    .action(async (opts) => {
      const role = requireRole(opts.role, ACCOUNT_ROLES);
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
