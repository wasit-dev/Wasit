#!/usr/bin/env node
/**
 * MCP server exposing Wasit's conformance checks to agents.
 *
 * The suite logic is not reimplemented here: this is an adapter over
 * `@wasit-dev/core`, so the CLI and an agent running the same checks against the
 * same target always reach the same verdict.
 *
 * MPP-13 permanently closes a channel and cannot be undone. An agent cannot be
 * assumed to carry meaningful human consent for that, so the destructive tool
 * is only registered when a human starts this process with an explicit opt-in.
 * Without it the tool is absent from the tool list entirely — an agent cannot
 * call what it cannot see.
 *
 * Mainnet is never a tool argument (spec B5): the existing tools refuse any
 * network that is not a test network, always. The mainnet opt-in (beta, B18
 * O3) is start-up only: `WASIT_MAINNET_OPT_IN=1` with `WASIT_MAINNET_CONFIG`
 * and `WASIT_MAINNET_ENVIRONMENT`, read once (`mainnet.ts`); any rule broken
 * stops this server before it starts, and with them it registers
 * `wasit_x402_mainnet_test`, whose only argument is an endpoint name of that
 * frozen config. `--mainnet` among its arguments is not read: the server does
 * not start. `WASIT_RPC_URL`, read once at start-up,
 * fixes the RPC of every tool call, and the `rpcUrl` argument is then refused,
 * so an agent cannot point a run at another RPC (D-023c). A result that reads
 * the chain names its RPC by origin, and flags one that is not the default.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  MAINNET_TOOL,
  mainnetToolDescription,
  readMainnetStartup,
  runMainnetEndpoint,
  summarizeMainnetRun,
  type MainnetSetup,
  type MainnetToolResult,
} from "./mainnet.js";
import { SERVER_VERSION } from "./version.js";
import {
  RPC_LOCK_VARIABLE,
  checkStatus,
  deniedEnvValues,
  describeRpcInUse,
  fixFor,
  paymentChainFor,
  readRpcLock,
  readToolVersions,
  redactValue,
  rpcInUse,
  runMppChannelSuite,
  runMppChargeSuite,
  runX402PaymentChecks,
  runX402ReadChecks,
  sanitizeText,
  summarize,
  toGradedRun,
  toStructuredRun,
  urlOrigin,
  type CheckResult,
  type ProtocolId,
  type RpcInUse,
} from "@wasit-dev/core";
import { z } from "zod";

const DESTRUCTIVE_ENABLED =
  process.env.WASIT_ALLOW_DESTRUCTIVE === "1" ||
  process.argv.includes("--allow-destructive");

/**
 * Start-up, read once: a mainnet opt-in that breaks a rule, `--mainnet` among
 * the arguments, or an RPC lock that is not an http(s) URL, stops the server
 * before it registers a tool. Each reason goes to stderr (stdout is the
 * protocol channel), and the exit code is 2.
 */
const startupRefusals: string[] = [];
const mainnetStartup = readMainnetStartup(process.env, process.argv.slice(2));
if (mainnetStartup.kind === "refused") startupRefusals.push(...mainnetStartup.reasons);
const rpcLock = readRpcLock(process.env);
if (rpcLock !== undefined && "problem" in rpcLock) startupRefusals.push(`${rpcLock.problem}, so this server does not start.`);
if (startupRefusals.length > 0) {
  for (const reason of startupRefusals) process.stderr.write(`wasit MCP server: ${reason}\n`);
  process.exit(2);
}

/** The mainnet tool's frozen setup, when the opt-in was set at start-up and every rule held. */
const MAINNET_SETUP: MainnetSetup | undefined = mainnetStartup.kind === "on" ? mainnetStartup.setup : undefined;

/** The RPC every tool call uses when `WASIT_RPC_URL` was set at start-up; the `rpcUrl` argument is then refused. */
const LOCKED_RPC: string | undefined = rpcLock !== undefined && "url" in rpcLock ? rpcLock.url : undefined;

/** Locates docs/CHECKS.md by walking up from this file. */
function locateChecksCatalogue(): string | undefined {
  const override = process.env.WASIT_CHECKS_PATH;
  if (override) return existsSync(override) ? override : undefined;

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, "docs", "CHECKS.md");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const resultShape = {
  id: z.string(),
  name: z.string(),
  status: z.enum(["PASS", "FAIL", "ERROR", "SKIP"]),
  detail: z.string(),
  destructive: z.boolean(),
  /** Present only on ERROR: unreachable | configuration | harness | setup. */
  errorKind: z.string().optional(),
  /** Present only on a SKIP whose reason has a kind: why the check did not run. */
  skipKind: z
    .enum(["unsupported", "resource-consumed", "needs-payer", "read-only", "not-applicable", "dependency"])
    .optional(),
  /** Present only on a FAIL whose check recorded them: what it expected, and what the service sent. */
  expected: z.string().optional(),
  actual: z.string().optional(),
  /** Present only on a PASS that read its settlement back from the chain (X402-06): the transaction. */
  reference: z.string().optional(),
  /** Present only on FAIL: what to change. */
  fix: z.string().optional(),
  /** Present only on FAIL: the check's docs page. */
  docs: z.string().optional(),
};

const runOutputShape = {
  outcome: z.enum(["conformant", "non-conformant", "no-verdict"]),
  passed: z.number(),
  failed: z.number(),
  errored: z.number(),
  skipped: z.number(),
  results: z.array(z.object(resultShape)),
  /**
   * Present only when the run read the chain: its RPC by origin, where it came
   * from, and whether it is Wasit's default for the network (D-023c). The one
   * field this server adds to the CLI's JSON shape.
   */
  rpc: z
    .object({
      origin: z.string(),
      source: z.enum(["default", "argument", "start-up"]),
      isDefault: z.boolean(),
    })
    .optional(),
};

/** What a run reads the chain through, for {@link present}. */
interface RunRpc {
  readonly network: string;
  readonly rpc: RpcInUse;
}

/**
 * The RPC a tool call reads through: the lock when the server has one, else the
 * argument, else the network's default. Undefined when the run reads no chain.
 */
function rpcFor(protocol: "x402" | "mpp", network: string, argument: string | undefined): RunRpc | undefined {
  const given =
    LOCKED_RPC !== undefined
      ? { url: LOCKED_RPC, source: "start-up" as const }
      : argument !== undefined && argument !== ""
        ? { url: argument, source: "argument" as const }
        : undefined;
  const rpc = rpcInUse(protocol, network, given);
  return rpc === undefined ? undefined : { network, rpc };
}

/** The RPC the call passes on: the lock, else the argument. */
function rpcOption(argument: string | undefined): { rpcUrl: string } | Record<string, never> {
  const url = LOCKED_RPC ?? argument;
  return url !== undefined && url !== "" ? { rpcUrl: url } : {};
}

/** With a lock, a call that names an RPC is refused before anything is sent (D-023c). */
function rpcArgumentRefused(argument: string | undefined): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} | undefined {
  if (LOCKED_RPC === undefined || argument === undefined) return undefined;
  return {
    content: [
      {
        type: "text",
        text:
          `rpcUrl is not taken by this server: its RPC was fixed when it started (${RPC_LOCK_VARIABLE}, ` +
          `${urlOrigin(LOCKED_RPC)}). Call the tool without rpcUrl. Nothing was sent.`,
      },
    ],
    isError: true,
  };
}

/**
 * Renders a run for both the agent's prose channel and its structured channel.
 *
 * `outcome` is deliberately named rather than numeric: an exit code means
 * nothing to an agent, and "no-verdict" must never be read as "compliant".
 */
function present(results: CheckResult[], protocol?: ProtocolId, read?: RunRpc): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const counts = summarize(results);
  // Given the protocol of the one endpoint, a service that was never graded is
  // `no-verdict`, as it is for the CLI's exit code (spec A8 #3).
  const structured = protocol === undefined ? toStructuredRun(results) : toGradedRun(results, protocol);
  // Text a service sent reaches both channels through the check details. Both
  // go through the one sanitiser, with this server's own keys and header values
  // taken out (spec A8 #6).
  const secrets = deniedEnvValues(process.env);

  const lines = results.map((result) => {
    const flag = result.destructive === true ? " [destructive]" : "";
    const guidance = fixFor(result);
    const advice =
      guidance === undefined
        ? ""
        : `\n      Fix: ${guidance.fix}${guidance.docs ? `\n      Docs: ${guidance.docs}` : ""}`;
    return sanitizeText(`${checkStatus(result)}  ${result.id}  ${result.name}${flag}\n      ${result.detail}${advice}`, {
      redact: secrets,
    });
  });

  const summaryLine =
    `${counts.passed} passed, ${counts.failed} failed, ` +
    `${counts.errored} could not run, ${counts.skipped} skipped.`;

  const caveat =
    counts.errored > 0
      ? "\n\nSome checks produced no verdict: they never reached the target, or " +
        "the run is misconfigured. That is not a statement about the target's " +
        "conformance, and must not be reported as one."
      : structured.outcome === "no-verdict" && counts.failed === 0
        ? "\n\nNo verdict: Wasit could not grade this service (unsupported; the skipped " +
          "checks say why). That is not a failure of the service, and not a pass."
        : "";

  // structuredContent is `toStructuredRun()` verbatim — the same reshape
  // the CLI's `--json` output calls — so the two front ends can never
  // report the same run two different ways.
  // D-023c: every chain read of the run is this RPC's word; it is named, by origin only.
  const rpcLine = read === undefined ? "" : `\n${describeRpcInUse(read.network, read.rpc)}`;

  return {
    content: [{ type: "text", text: `${lines.join("\n\n")}\n\n${summaryLine}${rpcLine}${caveat}` }],
    // toStructuredRun() returns a precisely-typed StructuredRun, which has
    // no index signature and so is not directly assignable to the SDK's
    // looser Record<string, unknown>. It is still a plain JSON-serializable
    // object — this cast widens the type, it does not change the value.
    structuredContent: redactValue(
      read === undefined ? structured : { ...structured, rpc: { ...read.rpc } },
      secrets,
    ) as unknown as Record<string, unknown>,
  };
}

function missingKey(variable: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text:
          `${variable} is not set in this server's environment. Secrets are read ` +
          `from the environment rather than accepted as tool arguments, so an ` +
          `agent never handles them. Set it in the MCP client's server config.`,
      },
    ],
    isError: true,
  };
}

const server = new McpServer({ name: "wasit", version: SERVER_VERSION });

const catalogue = locateChecksCatalogue();
if (catalogue) {
  server.registerResource(
    "checks-catalogue",
    "wasit://checks",
    {
      title: "Wasit Check Catalogue",
      description:
        "Every check Wasit runs, with its spec reference and exact pass criteria. " +
        "Read this before interpreting a result — it is the authority on what a " +
        "check actually asserts.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: readFileSync(catalogue, "utf-8") },
      ],
    }),
  );
}

server.registerTool(
  "wasit_x402_test",
  {
    title: "Test x402 compliance",
    description:
      "Runs the x402 conformance checks (X402-01..10) against a running service; " +
      "X402-11 needs the reject case of a wasit.config.json endpoint and is skipped by this tool. " +
      "Payment checks are included only when the network's payer key is set in " +
      "this server's environment (STELLAR_PRIVATE_KEY on Stellar, EVM_PRIVATE_KEY " +
      "on Base and Ethereum Sepolia, SVM_PRIVATE_KEY on Solana devnet); otherwise they are " +
      "skipped. When they do run, "
      + "X402-06 settles a real payment and X402-07..10 send payments the target "
      + "must refuse, so each call spends testnet funds and repeated calls spend "
      + "repeatedly. X402-10 waits for an authorization to expire (about 20 s on "
      + "Stellar). Testnet only.",
    inputSchema: {
      target: z.string().describe("Full URL of the paid resource, including scheme"),
      network: z
        .string()
        .optional()
        .describe(
          'Network the payment checks pay on: "stellar:testnet" (default), ' +
            '"eip155:84532" (Base Sepolia), "eip155:11155111" ' +
            '(Ethereum Sepolia) or ' +
            '"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" (Solana devnet). Test ' +
            'networks only: on any other network, "stellar:pubnet" included, the ' +
            "payment checks stop before anything is signed. The read-only checks " +
            "apply to a challenge on any chain.",
        ),
      readOnly: z
        .boolean()
        .optional()
        .describe("Skip the payment checks (X402-06..11) even if a payer key is set"),
      rpcUrl: z
        .string()
        .optional()
        .describe(
          "Override the RPC endpoint used to verify X402-06's settlement (Soroban RPC on Stellar, JSON-RPC on EVM and Solana). " +
            "Refused when the server was started with WASIT_RPC_URL, which fixes the RPC of every call.",
        ),
      method: z
        .string()
        .optional()
        .describe(
          'HTTP method the paid endpoint uses, default "GET". Endpoints that ' +
            'compute something usually take "POST".',
        ),
      body: z
        .string()
        .optional()
        .describe(
          "Request body, sent verbatim; implies Content-Type: application/json. " +
            "Not allowed with GET or HEAD.",
        ),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Extra request headers the endpoint needs before it will issue a " +
            "challenge. Values appear in the agent's transcript, so never pass " +
            "credentials here; use the CLI's --header for an endpoint that needs one.",
        ),
    },
    outputSchema: runOutputShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ target, network, readOnly, rpcUrl, method, body, headers }) => {
    const refused = rpcArgumentRefused(rpcUrl);
    if (refused !== undefined) return refused;
    // Same request shape for every probe, exactly as the CLI's --method,
    // --body and --header build it, so a POST endpoint is tested as a POST.
    const shape = {
      ...(method !== undefined ? { method } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(headers !== undefined ? { headers } : {}),
    };
    const results = await runX402ReadChecks({ target, ...shape });
    const payNetwork = network ?? "stellar:testnet";
    const payerKey = process.env[paymentChainFor(payNetwork)?.payerKeyEnv ?? "STELLAR_PRIVATE_KEY"];

    let read: RunRpc | undefined;
    if (readOnly !== true && payerKey) {
      read = rpcFor("x402", payNetwork, rpcUrl);
      results.push(
        ...(await runX402PaymentChecks({
          target,
          network: payNetwork,
          payerSecretKey: payerKey,
          ...rpcOption(rpcUrl),
          ...shape,
        })),
      );
    }

    return present(results, "x402", read);
  },
);

server.registerTool(
  "wasit_mpp_charge_test",
  {
    title: "Test MPP charge-mode settlement",
    description:
      "Runs MPP-01 against a running service: pays the advertised charge and " +
      "verifies on-chain that the settlement moved exactly the advertised " +
      "amount, to the advertised recipient, in the advertised token. " +
      "NOT IDEMPOTENT - every call settles a real payment and spends testnet " +
      "funds from the payer key. Repeated calls repeatedly spend. The payer " +
      "key is read from MPP_PAYER_SECRET in this server's environment. " +
      "Pays only a challenge on `network`: one for any other network is " +
      "refused before anything is signed. Testnet only.",
    inputSchema: {
      target: z.string().describe("Full URL of the paid resource, including scheme"),
      network: z
        .string()
        .optional()
        .describe(
          'CAIP-2 network id, default "stellar:testnet". "stellar:testnet" only: ' +
            "any other network is refused before anything is sent.",
        ),
      rpcUrl: z
        .string()
        .optional()
        .describe(
          "Override the Soroban RPC endpoint (https), used for the payment and the settlement read. " +
            "Refused when the server was started with WASIT_RPC_URL, which fixes the RPC of every call.",
        ),
    },
    outputSchema: runOutputShape,
    annotations: {
      readOnlyHint: false,
      // Not destructive: nothing is permanently ended, unlike MPP-13. But each
      // call spends, so it is emphatically not idempotent.
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ target, network, rpcUrl }) => {
    const refused = rpcArgumentRefused(rpcUrl);
    if (refused !== undefined) return refused;
    const payerSecretKey = process.env.MPP_PAYER_SECRET;
    if (!payerSecretKey) return missingKey("MPP_PAYER_SECRET");

    const runNetwork = network ?? process.env.MPP_STELLAR_NETWORK ?? "stellar:testnet";
    return present(
      await runMppChargeSuite({
        target,
        network: runNetwork,
        payerSecretKey,
        ...rpcOption(rpcUrl),
      }),
      undefined,
      rpcFor("mpp", runNetwork, rpcUrl),
    );
  },
);

const channelInputShape = {
  target: z.string().describe("Full URL of the paid resource, including scheme"),
  network: z
    .string()
    .optional()
    .describe(
      'CAIP-2 network id, default "stellar:testnet". "stellar:testnet" only: ' +
        "any other network is refused before anything is sent.",
    ),
  rpcUrl: z
    .string()
    .optional()
    .describe("Override the Soroban RPC endpoint. Refused when the server was started with WASIT_RPC_URL, which fixes the RPC of every call."),
  channel: z
    .string()
    .optional()
    .describe(
      "Assert which channel the target bills through. The target's own challenge " +
        "is authoritative; a mismatch fails MPP-10 rather than silently reporting " +
        "on two contracts.",
    ),
  expectToken: z.string().optional().describe("MPP-10: expected token contract"),
  expectFrom: z.string().optional().describe("MPP-10: expected funder address"),
  expectTo: z.string().optional().describe("MPP-10: expected recipient address"),
  expectRefundPeriod: z
    .number()
    .int()
    .optional()
    .describe("MPP-10: expected refund waiting period, in ledgers"),
};

type ChannelInput = {
  target: string;
  network?: string;
  rpcUrl?: string;
  channel?: string;
  expectToken?: string;
  expectFrom?: string;
  expectTo?: string;
  expectRefundPeriod?: number;
};

async function runChannel(
  input: ChannelInput,
  allowDestructive: boolean,
  destructiveChannel?: string,
): Promise<ReturnType<typeof present>> {
  const network = input.network ?? process.env.MPP_STELLAR_NETWORK ?? "stellar:testnet";
  const results = await runMppChannelSuite({
    target: input.target,
    commitmentSecretHex: process.env.COMMITMENT_SECRET_HEX ?? "",
    network,
    allowDestructive,
    ...rpcOption(input.rpcUrl),
    ...(input.channel ? { channelOverride: input.channel } : {}),
    ...(destructiveChannel ? { destructiveChannel } : {}),
    expected: {
      ...(input.expectToken ? { token: input.expectToken } : {}),
      ...(input.expectFrom ? { from: input.expectFrom } : {}),
      ...(input.expectTo ? { to: input.expectTo } : {}),
      ...(input.expectRefundPeriod !== undefined
        ? { refundWaitingPeriod: input.expectRefundPeriod }
        : {}),
    },
  });

  return present(results, undefined, rpcFor("mpp", network, input.rpcUrl));
}

server.registerTool(
  "wasit_mpp_channel_test",
  {
    title: "Test MPP channel-mode compliance",
    description:
      "Runs the non-destructive MPP channel-mode checks (MPP-10, 11, 12, 14) " +
      "against a running service. MPP-13 (Close Settlement) is always skipped " +
      "here because a close permanently ends the channel. Testnet only.",
    inputSchema: channelInputShape,
    outputSchema: runOutputShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (input) => {
    const refused = rpcArgumentRefused(input.rpcUrl);
    if (refused !== undefined) return refused;
    if (!process.env.COMMITMENT_SECRET_HEX) return missingKey("COMMITMENT_SECRET_HEX");
    return runChannel(input, false);
  },
);

if (DESTRUCTIVE_ENABLED) {
  server.registerTool(
    "wasit_mpp_channel_test_with_close",
    {
      title: "Test MPP channel-mode compliance, including close settlement",
      description:
        "Runs the full MPP channel-mode suite INCLUDING MPP-13 (Close Settlement). " +
        "MPP-13 permanently closes the channel: the settlement is final, the " +
        "channel can never be reopened, and no later check can run against it. " +
        "`destructiveChannel` must name the channel to destroy, and the run " +
        "refuses to close anything else. Only use this against a channel the " +
        "operator owns and has explicitly agreed to destroy.",
      inputSchema: {
        ...channelInputShape,
        destructiveChannel: z
          .string()
          .describe("Address of the channel this run is permitted to close"),
      },
      outputSchema: runOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ destructiveChannel, ...input }) => {
      const refused = rpcArgumentRefused(input.rpcUrl);
      if (refused !== undefined) return refused;
      if (!process.env.COMMITMENT_SECRET_HEX) return missingKey("COMMITMENT_SECRET_HEX");
      return runChannel(input, true, destructiveChannel);
    },
  );
}

/** The mainnet tool's structured result: the run's shape, and what the run did with real funds. */
const mainnetOutputShape = {
  ...runOutputShape,
  mainnet: z.object({
    network: z.string(),
    payTo: z.string(),
    ledger: z.string(),
    consistent: z.boolean(),
    stopped: z.string().optional(),
    spentUsd: z.string(),
    processSpentUsd: z.string(),
    processCapUsd: z.string(),
  }),
};

/** The versions for a mainnet run's ledger header, flat: "wasit.server", "sdk.@x402/core" and so on. */
function mainnetVersions(): Record<string, string> {
  const versions: Record<string, string> = { "wasit.server": SERVER_VERSION };
  for (const [group, entries] of Object.entries(readToolVersions())) {
    for (const [name, value] of Object.entries(entries as Record<string, unknown>)) {
      if (value !== undefined && `${group}.${name}` !== "wasit.cli") versions[`${group}.${name}`] = String(value);
    }
  }
  return versions;
}

/**
 * A mainnet call for both channels: its lines first (MAINNET RUN), then the
 * checks as every tool shows them. A run that stopped, or whose ledger does
 * not match the payer's balances, is no-verdict, as the CLI exits 2 for it.
 */
function presentMainnet(setup: MainnetSetup, result: MainnetToolResult) {
  const secrets = deniedEnvValues(process.env);
  if (result.refused !== undefined || result.ledgerPath === undefined) {
    const text = sanitizeText([...result.lines, result.refused ?? "The mainnet run was refused. Nothing was signed."].join("\n"), { redact: secrets });
    return { content: [{ type: "text" as const, text }], isError: true as const };
  }
  const rpcUrl = setup.run.rpcUrl ?? "";
  const base = present([...result.results], "x402", {
    network: setup.run.network,
    rpc: { origin: urlOrigin(rpcUrl), source: "start-up", isDefault: false },
  });
  const summary = summarizeMainnetRun(setup, result);
  const caveat = summary.caveat === "" ? "" : `\n\n${summary.caveat}`;
  return {
    content: [{ type: "text" as const, text: sanitizeText(`${result.lines.join("\n")}\n\n${base.content[0]!.text}${caveat}`, { redact: secrets }) }],
    structuredContent: redactValue(
      { ...base.structuredContent, ...(summary.trusted ? {} : { outcome: "no-verdict" }), mainnet: summary.fields },
      secrets,
    ) as Record<string, unknown>,
  };
}

if (MAINNET_SETUP !== undefined) {
  const setup = MAINNET_SETUP;
  const names = setup.endpoints as unknown as [string, ...string[]];
  server.registerTool(
    MAINNET_TOOL,
    {
      title: "Test x402 compliance on Stellar mainnet, with real funds (beta)",
      description: mainnetToolDescription(setup),
      inputSchema: {
        endpoint: z.enum(names).describe("The name of an x402 endpoint of the config this server read at start-up"),
      },
      outputSchema: mainnetOutputShape,
      annotations: {
        readOnlyHint: false,
        // Real funds leave the payer's account and cannot be taken back.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ endpoint }, extra) => {
      const token = extra._meta?.progressToken;
      const secrets = deniedEnvValues(process.env);
      let step = 0;
      // The run goes to its end whatever the client does (B18 O3): its ledger is closed and its lock released.
      const result = await runMainnetEndpoint(setup, endpoint, {
        env: process.env,
        versions: mainnetVersions(),
        onLine: (line) => {
          const clean = sanitizeText(line, { redact: secrets });
          process.stderr.write(`wasit MCP server: ${clean}\n`);
          if (token === undefined) return;
          step += 1;
          extra
            .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: step, message: clean } })
            .catch(() => undefined);
        },
      });
      return presentMainnet(setup, result);
    },
  );
}

await server.connect(new StdioServerTransport());
