/**
 * Runs MPP-11, MPP-12 and MPP-14 against a channel target.
 *
 * Start the fixture first:
 *   npx tsx packages/core/test/fixtures/mpp-channel-server.ts
 *
 * Run twice in a row. Every check must stay green on the second pass, which is
 * the property the manual commitment helper exists to provide.
 *
 * Pass a target to point it somewhere else, for example at the refusing fixture
 * that proves a setup failure is reported as no verdict rather than as a defect:
 *   npx tsx packages/core/test/manual/run-channel-checks.ts http://localhost:3004/data
 */
import "dotenv/config";
import { checkStatus, summarize } from "../../src/check.js";
import {
  runMppChannelCommitmentReplayCheck,
  runMppChannelOrderingCheck,
  runMppChannelReplayCheck,
} from "../../src/mpp/channel.js";

const DEFAULT_TARGET = "http://localhost:3003/data";

async function main(): Promise<void> {
  const commitmentSecretHex = process.env.COMMITMENT_SECRET_HEX;
  if (!commitmentSecretHex) throw new Error("Missing COMMITMENT_SECRET_HEX.");

  const options = {
    target: process.argv[2] ?? DEFAULT_TARGET,
    commitmentSecretHex,
    network: process.env.MPP_STELLAR_NETWORK ?? "stellar:testnet",
  };
  console.log(`Target: ${options.target}\n`);

  const results = [
    ...(await runMppChannelOrderingCheck(options)),
    ...(await runMppChannelReplayCheck(options)),
    ...(await runMppChannelCommitmentReplayCheck(options)),
  ];

  for (const result of results) {
    console.log(`${checkStatus(result)}  ${result.id}  ${result.name}`);
    console.log(`      ${result.detail}\n`);
  }

  // ERROR and FAIL are different claims, so the exit code must tell them apart:
  // 1 means the target did not conform, 2 means no verdict was reached.
  const summary = summarize(results);
  console.log(
    `${summary.passed} passed, ${summary.failed} failed, ` +
      `${summary.errored} no verdict, ${summary.skipped} skipped.`,
  );
  process.exitCode = summary.exitCode;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
