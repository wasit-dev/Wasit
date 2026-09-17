/**
 * Runs MPP charge mode and then MPP channel mode inside a single process.
 *
 * This is the shape the MCP server has: one long-lived process answering many
 * tool calls in a row. Running the two suites in separate CLI invocations
 * cannot reproduce state one check leaves behind for the next, which is how a
 * charge client polyfilling `globalThis.fetch` went unnoticed while every
 * single-suite run stayed green.
 *
 * Start both fixtures first, each in its own terminal:
 *   npx tsx packages/core/test/fixtures/mpp-charge-server.ts
 *   npx tsx packages/core/test/fixtures/mpp-channel-server.ts
 *
 * MPP-01 settles a real payment on the configured network. MPP-10 to MPP-12
 * and MPP-14 cost nothing, and MPP-13 is not run here.
 */
import "dotenv/config";

import { type CheckResult, checkStatus, summarize } from "../../src/check.js";
import { runMppChargeSuite } from "../../src/mpp/charge-suite.js";
import { runMppChannelSuite } from "../../src/mpp/suite.js";

const CHARGE_TARGET = "http://localhost:3002/data";
const CHANNEL_TARGET = "http://localhost:3003/data";

function report(title: string, results: readonly CheckResult[]): void {
  console.log(`\n=== ${title} ===`);
  for (const result of results) {
    console.log(`${checkStatus(result)}  ${result.id}  ${result.name}`);
    console.log(`      ${result.detail}\n`);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Check .env.`);
  return value;
}

async function main(): Promise<void> {
  const network = required("MPP_STELLAR_NETWORK");

  const charge = await runMppChargeSuite({
    target: CHARGE_TARGET,
    network,
    payerSecretKey: required("MPP_PAYER_SECRET"),
  });
  report("MPP charge mode", charge);

  const channel = await runMppChannelSuite({
    target: CHANNEL_TARGET,
    commitmentSecretHex: required("COMMITMENT_SECRET_HEX"),
    network,
  });
  report("MPP channel mode, same process", channel);

  const leaked = channel.filter((result) =>
    result.detail.includes("No method found for challenges"),
  );
  if (leaked.length > 0) {
    console.error(
      `\nREGRESSION: ${leaked.length} channel check(s) saw a payment client left ` +
        `behind by charge mode.`,
    );
    process.exitCode = 1;
    return;
  }

  // A skip is not a failure, and an ERROR is not a defect. MPP-10 skips here
  // because this runner supplies no expected on-chain parameters, and MPP-13 is
  // never enabled.
  const summary = summarize([...charge, ...channel]);
  console.log(
    `\n${summary.passed} passed, ${summary.failed} failed, ` +
      `${summary.errored} no verdict, ${summary.skipped} skipped.`,
  );
  process.exitCode = summary.exitCode;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
