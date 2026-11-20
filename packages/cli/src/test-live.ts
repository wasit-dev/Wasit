/**
 * `wasit test` for a person at a terminal: the same checks, notes and exit code
 * as the plain output, drawn live (a RUNNING line with a timer while a check is
 * in flight, each result as it arrives, the counts and the duration at the end).
 *
 * Its own module so that a test can drive it with a stream, an environment and
 * stand-in checks, and hold it to what the plain output promises: every text a
 * service chose is sanitised, and no secret of the environment is printed.
 */

import {
  X402_PAYMENT_CHECK_IDS,
  catalogueEntry,
  deniedEnvValues,
  endpointOutcome,
  networkClass,
  paymentChainFor,
  runX402PaymentChecks,
  runX402ReadChecks,
  sanitizeText,
} from "@wasit-dev/core";

import { LiveReport, type LiveStream } from "./live.js";
import { exitCodeFor, verdictNotes } from "./output.js";
import { colorDepth, liveEnabled } from "./style.js";
import { CLI_VERSION } from "./version.js";

export interface LiveTestShape {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface LiveTestDeps {
  /** Where the output goes: `process.stdout` in the CLI. */
  readonly stream: LiveStream;
  /** The environment the payer key and the secrets are read from: `process.env` in the CLI. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The checks, replaceable in tests. */
  readonly readChecks?: typeof runX402ReadChecks;
  readonly paymentChecks?: typeof runX402PaymentChecks;
}

export async function liveX402Test(opts: Record<string, unknown>, shape: LiveTestShape, deps: LiveTestDeps): Promise<number> {
  const { stream, env } = deps;
  const readChecks = deps.readChecks ?? runX402ReadChecks;
  const paymentChecks = deps.paymentChecks ?? runX402PaymentChecks;
  const secrets = deniedEnvValues(env);
  const live = new LiveReport({
    stream,
    live: liveEnabled(stream, env),
    depth: colorDepth(env),
    clean: (text) => sanitizeText(text, { redact: secrets }),
  });
  const target = opts["target"] as string;
  const network = opts["network"] as string;
  live.header(CLI_VERSION, "x402 conformance", [
    ["target", `${target}${shape.method !== undefined ? `  ${shape.method.toUpperCase()}` : ""}`],
    ["network", network],
  ]);

  live.phase("challenge", [["no payment"]]);
  live.running("X402-01..05", "Challenge checks");
  const results = await readChecks({ target, ...shape, onResult: (result) => live.result(result) });
  live.gap();

  const keyEnv = paymentChainFor(network)?.payerKeyEnv ?? "STELLAR_PRIVATE_KEY";
  const payerKey = (opts["payerKey"] as string | undefined) ?? env[keyEnv];
  if (opts["readOnly"] === true) {
    live.phase("payment", [["not run"]]);
    live.note("--read-only set: the payment checks were not run.");
  } else if (!payerKey) {
    live.phase("payment", [["not run"]]);
    live.note(`No payer key: set ${keyEnv} in .env or pass --payer-key. The payment checks were not run.`);
  } else if (networkClass(network) !== "test") {
    // Not a test network: the guard refuses the payment checks before anything
    // is signed (the PREFLIGHT line says why), so no money moves.
    live.phase("payment", [[network], ["not a test network: refused", "danger"]]);
  } else {
    live.phase("payment", [[network], ["testnet funds move", "warning"]]);
    live.note(
      `When the target offers a ${network} option, X402-06 settles a real payment and X402-07..10 send ` +
        "payments it must refuse.",
    );
  }
  if (opts["readOnly"] !== true && payerKey) {
    const order = X402_PAYMENT_CHECK_IDS;
    const startAt = (index: number): void => {
      const id = order[index];
      if (id !== undefined) live.running(id, catalogueEntry(id)?.name ?? id);
    };
    startAt(0);
    results.push(
      ...(await paymentChecks({
        target,
        network,
        payerSecretKey: payerKey,
        ...(opts["rpcUrl"] ? { rpcUrl: opts["rpcUrl"] as string } : {}),
        ...shape,
        onResult: (result) => {
          live.result(result);
          const index = order.indexOf(result.id);
          if (index >= 0) startAt(index + 1);
        },
        onProgress: (line) => live.progress(line),
      })),
    );
  }

  live.finish(results, endpointOutcome(results, "x402"), verdictNotes(results, "x402"));
  return exitCodeFor(results, "x402");
}
