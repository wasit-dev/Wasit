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
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_VERSION } from "./version.js";
import {
  checkStatus,
  runMppChannelSuite,
  runMppChargeSuite,
  runX402PaymentChecks,
  runX402ReadChecks,
  summarize,
  toStructuredRun,
  type CheckResult,
} from "@wasit-dev/core";
import { z } from "zod";

const DESTRUCTIVE_ENABLED =
  process.env.WASIT_ALLOW_DESTRUCTIVE === "1" ||
  process.argv.includes("--allow-destructive");

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
};

const runOutputShape = {
  outcome: z.enum(["conformant", "non-conformant", "no-verdict"]),
  passed: z.number(),
  failed: z.number(),
  errored: z.number(),
  skipped: z.number(),
  results: z.array(z.object(resultShape)),
};

/**
 * Renders a run for both the agent's prose channel and its structured channel.
 *
 * `outcome` is deliberately named rather than numeric: an exit code means
 * nothing to an agent, and "no-verdict" must never be read as "compliant".
 */
function present(results: CheckResult[]): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const counts = summarize(results);
  const structured = toStructuredRun(results);

  const lines = results.map((result) => {
    const flag = result.destructive === true ? " [destructive]" : "";
    return `${checkStatus(result)}  ${result.id}  ${result.name}${flag}\n      ${result.detail}`;
  });

  const summaryLine =
    `${counts.passed} passed, ${counts.failed} failed, ` +
    `${counts.errored} could not run, ${counts.skipped} skipped.`;

  const caveat =
    counts.errored > 0
      ? "\n\nSome checks produced no verdict: they never reached the target, or " +
        "the run is misconfigured. That is not a statement about the target's " +
        "conformance, and must not be reported as one."
      : "";

  // structuredContent is `toStructuredRun()` verbatim — the same reshape
  // the CLI's `--json` output calls — so the two front ends can never
  // report the same run two different ways.
  return {
    content: [{ type: "text", text: `${lines.join("\n\n")}\n\n${summaryLine}${caveat}` }],
    // toStructuredRun() returns a precisely-typed StructuredRun, which has
    // no index signature and so is not directly assignable to the SDK's
    // looser Record<string, unknown>. It is still a plain JSON-serializable
    // object — this cast widens the type, it does not change the value.
    structuredContent: structured as unknown as Record<string, unknown>,
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
      "Runs the x402 conformance checks (X402-01..07) against a running service. " +
      "Payment checks are included only when STELLAR_PRIVATE_KEY is set in this " +
      "server's environment; otherwise they are skipped. When they do run, "
      + "X402-06 settles a real payment and X402-07 attempts one, so each call "
      + "spends testnet funds and repeated calls spend repeatedly. Testnet only.",
    inputSchema: {
      target: z.string().describe("Full URL of the paid resource, including scheme"),
      network: z
        .string()
        .optional()
        .describe('CAIP-2 network id, e.g. "stellar:testnet" (default)'),
      readOnly: z
        .boolean()
        .optional()
        .describe("Skip the payment checks (X402-06/07) even if a payer key is set"),
    },
    outputSchema: runOutputShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ target, network, readOnly }) => {
    const results = await runX402ReadChecks({ target });
    const payerKey = process.env.STELLAR_PRIVATE_KEY;

    if (readOnly !== true && payerKey) {
      results.push(
        ...(await runX402PaymentChecks({
          target,
          network: network ?? "stellar:testnet",
          payerSecretKey: payerKey,
        })),
      );
    }

    return present(results);
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
      "Testnet only.",
    inputSchema: {
      target: z.string().describe("Full URL of the paid resource, including scheme"),
      network: z.string().optional().describe('CAIP-2 network id, default "stellar:testnet"'),
      rpcUrl: z.string().optional().describe("Override the Soroban RPC endpoint"),
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
    const payerSecretKey = process.env.MPP_PAYER_SECRET;
    if (!payerSecretKey) return missingKey("MPP_PAYER_SECRET");

    return present(
      await runMppChargeSuite({
        target,
        network: network ?? process.env.MPP_STELLAR_NETWORK ?? "stellar:testnet",
        payerSecretKey,
        ...(rpcUrl ? { rpcUrl } : {}),
      }),
    );
  },
);

const channelInputShape = {
  target: z.string().describe("Full URL of the paid resource, including scheme"),
  network: z.string().optional().describe('CAIP-2 network id, default "stellar:testnet"'),
  rpcUrl: z.string().optional().describe("Override the Soroban RPC endpoint"),
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
  const results = await runMppChannelSuite({
    target: input.target,
    commitmentSecretHex: process.env.COMMITMENT_SECRET_HEX ?? "",
    network: input.network ?? process.env.MPP_STELLAR_NETWORK ?? "stellar:testnet",
    allowDestructive,
    ...(input.rpcUrl ? { rpcUrl: input.rpcUrl } : {}),
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

  return present(results);
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
      if (!process.env.COMMITMENT_SECRET_HEX) return missingKey("COMMITMENT_SECRET_HEX");
      return runChannel(input, true, destructiveChannel);
    },
  );
}

await server.connect(new StdioServerTransport());
