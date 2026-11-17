#!/usr/bin/env node
import { createRequire } from "node:module";
import { createElement } from "react";
import { render } from "ink";
import { Command } from "commander";
import { App } from "./dashboard/App.js";
import { CLI_VERSION } from "./version.js";
import { registerWalletCommand } from "./wallet-command.js";
import {
  DEFAULT_SERVE_NETWORK,
  MODE_DESCRIPTIONS,
  SERVE_MODES,
  SERVE_NETWORKS,
  createServeServer,
  validateServeOptions,
  type ServeMode,
} from "./serve.js";
import { executeCiReport } from "./ci-report-command.js";
import { note, report } from "./output.js";
import { executeRun } from "./run.js";
import {
  CHECK_CATALOGUE,
  PROTOCOL_IDS,
  deniedEnvValues,
  paymentChainFor,
  runMppChannelSuite,
  runMppChargeSuite,
  runX402PaymentChecks,
  runX402ReadChecks,
  sanitizeText,
  type ProtocolId,
} from "@wasit-dev/core";

const require = createRequire(import.meta.url);

/**
 * Loads `.env` from the working directory exactly as `import "dotenv/config"`
 * did when it sat at the top of this file (it reads the DOTENV_CONFIG_*
 * variables and arguments too). A command runs it before its action; see the
 * hook below for the commands that do not.
 */
function loadDotenv(): void {
  require("dotenv/config");
}

/** CI sets one of these; the value does not matter, `false` included: when in doubt, it is CI. */
function inCi(env: NodeJS.ProcessEnv): boolean {
  return (env["CI"] ?? "") !== "" || (env["GITHUB_ACTIONS"] ?? "") !== "";
}

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

// `.env` is loaded before a command's action, as it always was, with two
// exceptions (spec A8 #2, A-A01): `wasit run` does not load it in CI, where the
// working directory is a checked-out pull request and a `.env` it added could
// steer the run; `wasit ci-report` never does, it has no use for it. CI is read
// from the real environment, before any `.env` could change it.
program.hook("preAction", (_program, action) => {
  const name = action.name();
  if (name === "ci-report") return;
  if (name === "run" && inCi(process.env)) return;
  loadDotenv();
});

/** Waits until what was written to stdout and stderr has been handed to the system, so `process.exit` cannot cut a long report. */
async function flushOutput(): Promise<void> {
  await Promise.all(
    [process.stdout, process.stderr].map((stream) => new Promise<void>((resolve) => stream.write("", () => resolve()))),
  );
}

/** A mistake on the command line learned nothing about a service: exit 2, not commander's 1. */
function exitTwoOnUsageError(error: { exitCode: number }): never {
  process.exit(error.exitCode === 0 ? 0 : 2);
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
    "Network the payment checks pay on: stellar:testnet, " +
      "eip155:84532 (Base Sepolia), eip155:11155111 (Ethereum Sepolia) or " +
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 (Solana devnet). Test networks " +
      "only: on any other network, stellar:pubnet included, the payment checks " +
      "stop before anything is signed. X402-01..05 apply to a challenge on any chain.",
    "stellar:testnet",
  )
  .option(
    "--rpc-url <url>",
    "Override the RPC endpoint used to verify X402-06's settlement (Soroban RPC on Stellar, JSON-RPC on EVM and Solana)",
  )
  .option(
    "--payer-key <key>",
    "Testnet payer key (overrides STELLAR_PRIVATE_KEY, EVM_PRIVATE_KEY on eip155 networks, " +
      "or SVM_PRIVATE_KEY on Solana, from .env)",
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
  .option("--read-only", "Skip the payment checks (X402-06..11)", false)
  .option("--json", "Print results as JSON instead of formatted text", false)
  .addHelpText(
    "after",
    `
Examples:
  $ wasit test --target https://api.example.com/paid-endpoint --read-only
  $ wasit test --target https://api.example.com/paid-endpoint --payer-key S...
  $ wasit test --target https://api.example.com/paid-endpoint --read-only --json

X402-01..05 (challenge/header checks) always run and cost nothing. X402-06..10
(real payment checks) run only when a payer key is available and --read-only
is not set: X402-06 settles a payment; X402-07..10 send payments the target
must refuse (a corrupted signature, a replay, an underpayment, an expired
authorization). X402-11 needs a request the service must refuse, the reject case
of a wasit.config.json endpoint: it runs in wasit run and is skipped here. See
docs/CHECKS.md for what each check ID verifies.`,
  )
  .action(async (opts) => {
    const jsonMode = opts.json === true;
    const shape = {
      ...(opts.method ? { method: opts.method as string } : {}),
      ...(opts.body !== undefined ? { body: opts.body as string } : {}),
      ...(opts.header ? { headers: opts.header as Record<string, string> } : {}),
    };

    const results = await runX402ReadChecks({ target: opts.target, ...shape });
    // Each chain reads its own payer key: a Stellar secret is no use on EVM.
    const keyEnv = paymentChainFor(opts.network as string)?.payerKeyEnv ?? "STELLAR_PRIVATE_KEY";
    const payerKey: string | undefined = opts.payerKey ?? process.env[keyEnv];

    if (opts.readOnly) {
      note(jsonMode, "(--read-only set: skipping payment checks)\n");
    } else if (!payerKey) {
      note(
        jsonMode,
        `(no payer key: set ${keyEnv} in .env or pass --payer-key — skipping payment checks)\n`,
      );
    } else {
      note(
        jsonMode,
        `When the target offers a ${opts.network} option, X402-06 settles a real ` +
          "payment and X402-07..10 send payments it must refuse. Testnet funds will move.\n",
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

    // One endpoint: a service Wasit could not grade exits 2, not 0 (spec A8 #3).
    process.exit(report(results, jsonMode, { protocol: "x402" }));
  });

program
  .command("run")
  .description("Run the endpoints of a wasit.config.json and write one report: the payment tier on a test network, --read-only, or --dry-run")
  .option("--config <path>", "The config file", "wasit.config.json")
  .option("--env <name>", "The environment to run (default: defaultEnvironment, else the only one)")
  .option(
    "--endpoint <name>",
    "Run only this endpoint, by name. Repeatable.",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option(
    "--read-only",
    "Run the unpaid challenge checks (X402-01..05) only. They send no payment and sign nothing. Without it (and without --dry-run) the run is the payment tier.",
    false,
  )
  .option(
    "--dry-run",
    "Print what the payment checks would sign: per endpoint the payee, the asset, the amount of each signature and the worst case, " +
      "against the caps ($1 a payment, $5 a run, lower with maxRunUsd). Reads each x402 endpoint's unpaid challenge; " +
      "uses no key, sends no payment, signs nothing. Exit 2 when a paying run would be refused. Not with --read-only.",
    false,
  )
  .option("--json", "Print the report as JSON instead of text", false)
  .option("--out <file>", "Write the JSON report to this file as well")
  .option(
    "--start",
    "Run service.start from the config, wait for service.ready, run, and stop the service afterwards. " +
      "The service does not receive Wasit's key variables, header variables or WASIT_RPC_URL.",
    false,
  )
  .option(
    "--start-if-local",
    "Like --start, but only when service.start is set and the environment is on this machine (localhost, 127.x.x.x or [::1]); " +
      "otherwise the configured baseUrl is read as it is, which is how a deployed endpoint is checked. Not with --start.",
    false,
  )
  .option(
    "--baseline <file>",
    "The report of the default branch: an endpoint graded there that is unsupported or without a verdict now is a regression (exit 1)",
  )
  .option(
    "--mainnet",
    "Refused in this version: the mainnet opt-in is not part of it. The run stops with exit 2 before the config is read; nothing is started, sent or signed.",
    false,
  )
  .addHelpText(
    "after",
    `
Examples:
  $ wasit run --read-only
  $ wasit run --read-only --env staging --endpoint weather --json --out wasit-report.json
  $ wasit run --read-only --start
  $ wasit run --read-only --start-if-local --env mainnet
  $ wasit run --dry-run --start
  $ wasit run --start                     (payment tier: STELLAR_PRIVATE_KEY on stellar:testnet)

Exit codes: 0 every graded endpoint conforms; 1 an endpoint does not conform, or one
graded on the baseline is not graded now; 2 no verdict (nothing could be graded, a
check could not run, the config or the service could not be used, or the payment
tier was asked for and did not pay: no payer key, or operatedByMe not true).
The payment tier pays on test networks only: at most $1.00 a payment and $5.00 a run
(lower with maxRunUsd), only the pinned payTo and asset when the config pins them.
In GitHub Actions it pays only on push to the default branch, schedule and
workflow_dispatch; a pull request runs the read-only checks, and a payer key set on
a run that may not pay is refused before the service starts. In another CI (CI set,
not GitHub Actions) the payment tier is refused with exit 2: use --read-only there,
with no payer key in the job.
X402-11 runs for an endpoint with a reject case, on Stellar: it sends a valid payment
with the request the service must refuse, then reads the chain until that payment's
authorization has expired, up to six minutes; a lifetime above 300 s or below 30 s is
not signed, and an authorization signed to outlive 300 s is not sent.
In CI (CI or GITHUB_ACTIONS set) a .env file in the working directory is not read.`,
  )
  .exitOverride(exitTwoOnUsageError)
  .action(async (opts) => {
    let code: number;
    try {
      code = await executeRun(
        {
          config: opts.config as string,
          ...(opts.env === undefined ? {} : { env: opts.env as string }),
          endpoint: opts.endpoint as string[],
          readOnly: opts.readOnly === true,
          dryRun: opts.dryRun === true,
          json: opts.json === true,
          ...(opts.out === undefined ? {} : { out: opts.out as string }),
          start: opts.start === true,
          startIfLocal: opts.startIfLocal === true,
          ...(opts.baseline === undefined ? {} : { baseline: opts.baseline as string }),
          mainnet: opts.mainnet === true,
        },
        { env: process.env, stdout: (line) => console.log(line), stderr: (line) => console.error(line) },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(sanitizeText(`wasit run: unexpected error: ${message}`, { redact: deniedEnvValues(process.env) }));
      code = 2;
    }
    await flushOutput();
    process.exit(code);
  });

program
  .command("ci-report")
  .description("Write the pull request comment and the job summary from the report of wasit run")
  .requiredOption("--report <file>", "The report written by wasit run --json --out")
  .option("--baseline <file>", "The baseline of the default branch, for \"Changed since main\" and the recent failures")
  .option("--comment <file>", "Where the comment goes", "comment.md")
  .option("--summary <file>", "The job summary file, appended to (default: $GITHUB_STEP_SUMMARY)")
  .option(
    "--baseline-out <file>",
    "Write the next baseline here: this report with its history. For a run on the default branch.",
  )
  .option(
    "--history <file>",
    "The baseline file of the newest completed run on the default branch, failed or not: the recent failures are counted from its history",
  )
  .option("--baseline-run <id>", "The id of the run the baseline came from, named in the comment")
  .exitOverride(exitTwoOnUsageError)
  .action(async (opts) => {
    let code: number;
    try {
      code = await executeCiReport(
        {
          report: opts.report as string,
          ...(opts.baseline === undefined ? {} : { baseline: opts.baseline as string }),
          comment: opts.comment as string,
          ...(opts.summary === undefined ? {} : { summary: opts.summary as string }),
          ...(opts.baselineOut === undefined ? {} : { baselineOut: opts.baselineOut as string }),
          ...(opts.history === undefined ? {} : { history: opts.history as string }),
          ...(opts.baselineRun === undefined ? {} : { baselineRun: opts.baselineRun as string }),
        },
        { env: process.env, stdout: (line) => console.log(line), stderr: (line) => console.error(line) },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(sanitizeText(`wasit ci-report: unexpected error: ${message}`, { redact: deniedEnvValues(process.env) }));
      code = 2;
    }
    await flushOutput();
    process.exit(code);
  });

program
  .command("serve")
  .description("Run a local x402 paywall that misbehaves on purpose, to test an agent that pays")
  .requiredOption("--mode <mode>", `How the paywall misbehaves: ${SERVE_MODES.join(", ")}`)
  .option(
    "--network <network>",
    `Testnet to pose on: ${Object.keys(SERVE_NETWORKS).join(" or ")}`,
    DEFAULT_SERVE_NETWORK,
  )
  .option("--port <port>", "Port to listen on", "4020")
  .option("--host <host>", "Interface to bind (local only by default)", "127.0.0.1")
  .option(
    "--pay-to <address>",
    "Payee: a Stellar account (G...) with a USDC trustline, an EVM address (0x...) " +
      "on Base or Ethereum Sepolia, or a Solana address on devnet (overrides " +
      "STELLAR_PAYEE_ADDRESS, EVM_PAYEE_ADDRESS or SVM_PAYEE_ADDRESS)",
  )
  .option("--amount <units>", "Price in base units for every mode except overprice", "10000")
  .option("--asset <contract>", "Token contract (default: the network's testnet USDC)")
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
moves funds. On Stellar your agent still needs a funded testnet wallet:
payment clients simulate the transfer to --pay-to before signing.

Examples:
  $ wasit serve --mode no-settle
  $ wasit serve --mode wrong-settlement --settlement-tx <hash of an unrelated tx>
  $ wasit serve --mode overprice --port 4021
  $ wasit serve --mode no-settle --network eip155:84532   # Base Sepolia
  $ wasit serve --mode no-settle --network solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1   # Solana devnet`,
  )
  .action((opts) => {
    const network = opts.network as string;
    const payeeEnv = SERVE_NETWORKS[network]?.payeeEnv ?? "STELLAR_PAYEE_ADDRESS";
    const options = {
      mode: opts.mode as ServeMode,
      network,
      payTo: (opts.payTo as string | undefined) ?? process.env[payeeEnv] ?? "",
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
      console.log(`wasit serve: ${options.mode} on ${network}, http://${opts.host}:${port}/ (any path)`);
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
  .option(
    "--network <network>",
    "CAIP-2 network id, stellar:testnet only; any other network is refused before " +
      "anything is sent (default: MPP_STELLAR_NETWORK, else stellar:testnet)",
  )
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
  .option(
    "--network <network>",
    "CAIP-2 network id, stellar:testnet only; any other network is refused before " +
      "anything is sent (default: MPP_STELLAR_NETWORK, else stellar:testnet)",
  )
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
  loadDotenv();
  render(createElement(App));
} else {
  program.parse();
}
