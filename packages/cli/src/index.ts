#!/usr/bin/env node
import "dotenv/config";
import { createElement } from "react";
import { render } from "ink";
import { Command } from "commander";
import { App } from "./dashboard/App.js";
import { CLI_VERSION } from "./version.js";
import { registerWalletCommand } from "./wallet-command.js";
import {
  MODE_DESCRIPTIONS,
  SERVE_MODES,
  createServeServer,
  validateServeOptions,
  type ServeMode,
} from "./serve.js";
import {
  CHECK_CATALOGUE,
  PROTOCOL_IDS,
  checkStatus,
  fixFor,
  runMppChannelSuite,
  runMppChargeSuite,
  runX402PaymentChecks,
  runX402ReadChecks,
  summarize,
  toStructuredRun,
  type CheckResult,
  type ProtocolId,
} from "@wasit-dev/core";

/** Which wasit subcommand runs each protocol's checks — for `wasit checks` output. */
const COMMAND_BY_PROTOCOL: Record<ProtocolId, string> = {
  x402: "test",
  "mpp-charge": "mpp-charge",
  "mpp-channel": "mpp-channel",
};

/**
 * Accumulates repeated --header flags into one object.
 *
 * Exits 2 rather than 1 on a malformed value: nothing was learned about the
 * target, so this is a configuration error, not a conformance failure.
 */
function collectHeader(
  value: string,
  previous: Record<string, string> | undefined,
): Record<string, string> {
  const separator = value.indexOf(":");
  if (separator < 1) {
    console.error(`Invalid --header "${value}". Expected "Name: value".`);
    process.exit(2);
  }
  return {
    ...(previous ?? {}),
    [value.slice(0, separator).trim()]: value.slice(separator + 1).trim(),
  };
}

const program = new Command();

program
  .name("wasit")
  .description("Protocol-compliance testing for x402 / MPP on Stellar")
  .version(CLI_VERSION)
  .addHelpText(
    "after",
    `
Examples:
  $ wasit checks
  $ wasit test --target https://api.example.com/paid-endpoint --read-only
  $ wasit mpp-charge --target https://api.example.com/paid-endpoint --payer-key S...
  $ wasit mpp-channel --target https://api.example.com/paid-endpoint
  $ wasit wallet create --role mpp-charge --fund
  $ wasit serve --mode no-settle          # a lying paywall, to test an agent that pays

Run "wasit <command> --help" for that command's own options and cost notes.
Add --json to test/mpp-charge/mpp-channel for machine-readable output.
Full check catalogue (every check ID, spec reference, pass criteria):
  https://github.com/wasit-dev/wasit/blob/main/docs/CHECKS.md`,
  );

/**
 * Prints an advisory/status line meant for a human watching the terminal —
 * never part of the run's actual result. Routed to stderr when --json is
 * set, so stdout stays parseable JSON and a script piping it (jq, etc.)
 * never has to skip past prose first.
 */
function note(json: boolean, message: string): void {
  if (json) {
    console.error(message);
  } else {
    console.log(message);
  }
}

/**
 * Prints results and returns the process exit code.
 *
 * A skipped check carries `pass: false` so it can never be counted as
 * conformance, but it is not a failure and must not fail the run. An errored
 * check produced no verdict at all and is reported separately again.
 *
 * `--json` reuses `toStructuredRun()` from core — the same reshape the MCP
 * server calls for its own structured output — rather than defining a
 * second JSON shape here that could drift from it.
 */
function report(results: CheckResult[], json: boolean): number {
  const counts = summarize(results);

  if (json) {
    console.log(JSON.stringify(toStructuredRun(results), null, 2));
    return counts.exitCode;
  }

  for (const result of results) {
    const flag = result.destructive ? "  [destructive]" : "";
    console.log(`${checkStatus(result)}  ${result.id}  ${result.name}${flag}`);
    console.log(`      ${result.detail}`);
    const guidance = fixFor(result);
    if (guidance !== undefined) {
      console.log(`      Fix: ${guidance.fix}`);
      if (guidance.docs !== undefined) console.log(`      Docs: ${guidance.docs}`);
    }
    console.log("");
  }

  const line = [`${counts.passed} passed`];
  if (counts.failed > 0) line.push(`${counts.failed} failed`);
  if (counts.errored > 0) line.push(`${counts.errored} could not run`);
  if (counts.skipped > 0) line.push(`${counts.skipped} skipped`);
  console.log(`${line.join(", ")}.`);

  if (counts.errored > 0 && counts.failed === 0) {
    console.log(
      "\nNo verdict: some checks never reached the target or the run is " +
        "misconfigured. This is not a statement about the target's conformance.",
    );
  }

  return counts.exitCode;
}

program
  .command("checks")
  .description("List the check catalogue: every check wasit can run, by ID")
  .option(
    "--protocol <name>",
    `Filter to one protocol (${PROTOCOL_IDS.join(", ")}) — matches the wasit subcommand that runs it`,
  )
  .option("--json", "Print as JSON instead of a formatted list", false)
  .addHelpText(
    "after",
    `
Examples:
  $ wasit checks
  $ wasit checks --protocol mpp-channel
  $ wasit checks --json

Full pass-criteria prose, spec citations, and revision notes for every check
live in docs/CHECKS.md — this command is a quick reference, not a
replacement for it.`,
  )
  .action((opts) => {
    const protocol: string | undefined = opts.protocol;
    if (protocol !== undefined && !PROTOCOL_IDS.includes(protocol as ProtocolId)) {
      console.error(`Unknown --protocol "${protocol}". Expected one of: ${PROTOCOL_IDS.join(", ")}.`);
      process.exit(2);
    }

    const entries = CHECK_CATALOGUE.filter(
      (entry) => protocol === undefined || entry.protocol === protocol,
    );

    if (opts.json === true) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    let currentProtocol: ProtocolId | undefined;
    for (const entry of entries) {
      if (entry.protocol !== currentProtocol) {
        currentProtocol = entry.protocol;
        console.log(`\n${currentProtocol}  (wasit ${COMMAND_BY_PROTOCOL[currentProtocol]})`);
      }
      const flags = [
        entry.negative ? "negative" : null,
        entry.destructive ? "destructive" : null,
        entry.costsFunds ? "costs funds" : null,
      ].filter((flag): flag is string => flag !== null);
      const flagText = flags.length > 0 ? `  [${flags.join(", ")}]` : "";
      console.log(`  ${entry.id}  ${entry.name}${flagText}`);
      console.log(`      ${entry.summary}`);
    }
    console.log(`\n${entries.length} check${entries.length === 1 ? "" : "s"}.`);
  });

program
  .command("test")
  .description("Run x402 compliance checks against a target service")
  .requiredOption("--target <url>", "URL of the service to test")
  .option(
    "--network <network>",
    "Network the payment checks pay on: stellar:testnet or stellar:pubnet. " +
      "X402-01..05 apply to a challenge on any chain.",
    "stellar:testnet",
  )
  .option("--rpc-url <url>", "Override the Soroban RPC endpoint used to verify X402-06's settlement")
  .option(
    "--payer-key <key>",
    "Testnet payer secret key (overrides STELLAR_PRIVATE_KEY from .env)",
  )
  .option(
    "--method <verb>",
    "HTTP method the paid endpoint uses (default: GET). Paid endpoints that " +
      "compute something usually take POST.",
  )
  .option("--body <json>", "Request body, sent verbatim. Implies Content-Type: application/json.")
  .option(
    "--header <name:value>",
    "Extra request header the endpoint needs before it will issue a challenge. Repeatable.",
    collectHeader,
  )
  .option("--read-only", "Skip payment checks (X402-06/07)", false)
  .option("--json", "Print results as JSON instead of formatted text", false)
  .addHelpText(
    "after",
    `
Examples:
  $ wasit test --target https://api.example.com/paid-endpoint --read-only
  $ wasit test --target https://api.example.com/paid-endpoint --payer-key S...
  $ wasit test --target https://api.example.com/paid-endpoint --read-only --json

X402-01..05 (challenge/header checks) always run and cost nothing. X402-06/07
(real payment checks) run only when a payer key is available and --read-only
is not set: X402-06 settles a payment, X402-07 attempts one with a corrupted
signature. See docs/CHECKS.md for what each check ID verifies.`,
  )
  .action(async (opts) => {
    const jsonMode = opts.json === true;
    const shape = {
      ...(opts.method ? { method: opts.method as string } : {}),
      ...(opts.body !== undefined ? { body: opts.body as string } : {}),
      ...(opts.header ? { headers: opts.header as Record<string, string> } : {}),
    };

    const results = await runX402ReadChecks({ target: opts.target, ...shape });
    const payerKey: string | undefined = opts.payerKey ?? process.env.STELLAR_PRIVATE_KEY;

    if (opts.readOnly) {
      note(jsonMode, "(--read-only set: skipping payment checks)\n");
    } else if (!payerKey) {
      note(
        jsonMode,
        "(no payer key: set STELLAR_PRIVATE_KEY in .env or pass --payer-key — skipping payment checks)\n",
      );
    } else {
      note(
        jsonMode,
        `When the target offers a ${opts.network} option, X402-06 settles a real ` +
          "payment and X402-07 attempts one. Testnet funds will move.\n",
      );
      results.push(
        ...(await runX402PaymentChecks({
          target: opts.target,
          network: opts.network,
          payerSecretKey: payerKey,
          ...(opts.rpcUrl ? { rpcUrl: opts.rpcUrl as string } : {}),
          ...shape,
        })),
      );
    }

    process.exit(report(results, jsonMode));
  });

program
  .command("serve")
  .description("Run a local x402 paywall that misbehaves on purpose, to test an agent that pays")
  .requiredOption("--mode <mode>", `How the paywall misbehaves: ${SERVE_MODES.join(", ")}`)
  .option("--port <port>", "Port to listen on", "4020")
  .option("--host <host>", "Interface to bind (local only by default)", "127.0.0.1")
  .option(
    "--pay-to <address>",
    "Payee account (G...) with a USDC trustline on testnet (overrides STELLAR_PAYEE_ADDRESS)",
  )
  .option("--amount <units>", "Price in base units for every mode except overprice", "10000")
  .option("--asset <contract>", "Token contract (default: testnet USDC)")
  .option(
    "--settlement-tx <hash>",
    "wrong-settlement: transaction to cite (default: a random hash that exists nowhere)",
  )
  .addHelpText(
    "after",
    `
Modes:
${SERVE_MODES.map((mode) => `  ${mode.padEnd(17)} ${MODE_DESCRIPTIONS[mode].does}`).join("\n")}

Point your agent at http://127.0.0.1:4020/ (any path) and watch what it does.
The server never settles and never forwards a payment, so nothing it receives
moves funds. Your agent still needs a funded testnet wallet: payment clients
simulate the transfer to --pay-to before signing.

Examples:
  $ wasit serve --mode no-settle
  $ wasit serve --mode wrong-settlement --settlement-tx <hash of an unrelated tx>
  $ wasit serve --mode overprice --port 4021`,
  )
  .action((opts) => {
    const options = {
      mode: opts.mode as ServeMode,
      payTo: (opts.payTo as string | undefined) ?? process.env.STELLAR_PAYEE_ADDRESS ?? "",
      amount: opts.amount as string,
      ...(opts.asset ? { asset: opts.asset as string } : {}),
      ...(opts.settlementTx ? { settlementTx: opts.settlementTx as string } : {}),
      log: (line: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${line}`),
    };
    const problem = validateServeOptions(options);
    if (problem !== undefined) {
      console.error(problem);
      process.exit(2);
    }

    const port = Number(opts.port);
    const server = createServeServer(options);
    server.on("error", (error) => {
      console.error(`Could not listen on ${opts.host}:${opts.port}: ${(error as Error).message}`);
      process.exit(2);
    });
    server.listen(port, opts.host as string, () => {
      const description = MODE_DESCRIPTIONS[options.mode];
      console.log(`wasit serve: ${options.mode} on http://${opts.host}:${port}/ (any path)`);
      console.log(`  This paywall ${description.does}`);
      console.log(`  An agent that pays carefully ${description.careful}`);
      console.log("  Nothing is settled or forwarded; no funds move. Ctrl+C to stop.\n");
    });
    process.on("SIGINT", () => server.close(() => process.exit(0)));
  });

program
  .command("mpp-channel")
  .description("Run MPP channel-mode compliance checks against a target service")
  .requiredOption("--target <url>", "URL of the paid resource to test")
  .option(
    "--commitment-key <hex>",
    "Raw ed25519 commitment seed, hex (default: COMMITMENT_SECRET_HEX)",
  )
  .option("--network <network>", "CAIP-2 network id (default: MPP_STELLAR_NETWORK)")
  .option("--rpc-url <url>", "Override the default Soroban RPC endpoint")
  .option(
    "--channel <address>",
    "Assert which channel the target bills through. Defaults to the channel " +
      "the target advertises; a mismatch fails MPP-10. (env: CHANNEL_CONTRACT)",
  )
  .option("--expect-token <address>", "MPP-10: expected token contract")
  .option("--expect-from <address>", "MPP-10: expected funder address")
  .option("--expect-to <address>", "MPP-10: expected recipient address")
  .option("--expect-refund-period <ledgers>", "MPP-10: expected refund waiting period")
  .option(
    "--allow-destructive",
    "Enable MPP-13. Closing settles on-chain and permanently ends the channel.",
    false,
  )
  .option(
    "--destructive-channel <address>",
    "Channel MPP-13 is permitted to close (default: CHANNEL_CONTRACT_DISPOSABLE)",
  )
  .option("--json", "Print results as JSON instead of formatted text", false)
  .addHelpText(
    "after",
    `
Examples:
  $ wasit mpp-channel --target https://api.example.com/paid-endpoint
  $ wasit mpp-channel --target https://api.example.com/paid-endpoint --allow-destructive --destructive-channel C...
  $ wasit mpp-channel --target https://api.example.com/paid-endpoint --json

MPP-10, MPP-11, MPP-12, MPP-14 run by default and are non-destructive.
MPP-13 (channel close) only runs with --allow-destructive, and only against
the channel named by --destructive-channel — running it permanently ends
that channel.`,
  )
  .action(async (opts) => {
    const jsonMode = opts.json === true;
    const commitmentSecretHex: string | undefined =
      opts.commitmentKey ?? process.env.COMMITMENT_SECRET_HEX;
    if (!commitmentSecretHex) {
      console.error(
        "No commitment key. Pass --commitment-key or set COMMITMENT_SECRET_HEX in .env.",
      );
      process.exit(2);
    }

    const network: string =
      opts.network ?? process.env.MPP_STELLAR_NETWORK ?? "stellar:testnet";
    const channelOverride: string | undefined =
      opts.channel ?? process.env.CHANNEL_CONTRACT;
    const destructiveChannel: string | undefined =
      opts.destructiveChannel ?? process.env.CHANNEL_CONTRACT_DISPOSABLE;
    const refundWaitingPeriod = Number(opts.expectRefundPeriod);

    const results = await runMppChannelSuite({
      target: opts.target as string,
      commitmentSecretHex,
      network,
      allowDestructive: opts.allowDestructive === true,
      ...(opts.rpcUrl ? { rpcUrl: opts.rpcUrl as string } : {}),
      ...(channelOverride ? { channelOverride } : {}),
      ...(destructiveChannel ? { destructiveChannel } : {}),
      expected: {
        ...(opts.expectToken ? { token: opts.expectToken as string } : {}),
        ...(opts.expectFrom ? { from: opts.expectFrom as string } : {}),
        ...(opts.expectTo ? { to: opts.expectTo as string } : {}),
        ...(Number.isInteger(refundWaitingPeriod) ? { refundWaitingPeriod } : {}),
      },
    });

    process.exit(report(results, jsonMode));
  });

program
  .command("mpp-charge")
  .description("Run the MPP charge-mode check (MPP-01) against a target service")
  .requiredOption("--target <url>", "URL of the paid resource to test")
  .option("--payer-key <key>", "Payer secret key, S... (default: MPP_PAYER_SECRET)")
  .option("--network <network>", "CAIP-2 network id (default: MPP_STELLAR_NETWORK)")
  .option("--rpc-url <url>", "Override the default Soroban RPC endpoint")
  .option("--json", "Print results as JSON instead of formatted text", false)
  .addHelpText(
    "after",
    `
Examples:
  $ wasit mpp-charge --target https://api.example.com/paid-endpoint --payer-key S...
  $ wasit mpp-charge --target https://api.example.com/paid-endpoint --payer-key S... --json

Runs MPP-01 only. Not idempotent and has no read-only mode: every run settles
a real payment and moves testnet funds, because charge mode has no dry run.`,
  )
  .action(async (opts) => {
    const jsonMode = opts.json === true;
    const payerSecretKey = opts.payerKey ?? process.env.MPP_PAYER_SECRET;
    if (!payerSecretKey) {
      console.error("No payer key. Pass --payer-key or set MPP_PAYER_SECRET in .env.");
      process.exit(2);
    }

    note(
      jsonMode,
      "MPP-01 settles a real payment. If the target is reachable, testnet funds will move.\n",
    );

    const results = await runMppChargeSuite({
      target: opts.target,
      network: opts.network ?? process.env.MPP_STELLAR_NETWORK ?? "stellar:testnet",
      payerSecretKey,
      ...(opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : {}),
    });

    process.exit(report(results, jsonMode));
  });

registerWalletCommand(program);

const isBareInteractiveInvocation =
  process.argv.length <= 2 && process.stdout.isTTY === true;

if (isBareInteractiveInvocation) {
  render(createElement(App));
} else {
  program.parse();
}
