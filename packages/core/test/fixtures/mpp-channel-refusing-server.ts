/**
 * A channel target that issues well-formed challenges and then refuses every
 * credential, used to prove how a setup failure is reported.
 *
 * MPP-11, MPP-12 and MPP-14 each need one correctly advancing commitment
 * accepted before they can probe anything. Against a real channel that step can
 * fail for a reason that says nothing about the target, namely another payer
 * advancing the cumulative mid-run, so those checks retry with a fresh challenge
 * and, when every attempt is refused, report ERROR with kind `setup` instead of
 * FAIL. Racing two runners reproduces that only by luck. This fixture reproduces
 * the refusal deterministically, so the reporting path can be demonstrated on
 * demand.
 *
 * It is not a conformance target and must never be used as one. It always
 * answers 402, so the only outcome it can produce is a setup failure.
 *
 * Run: npx tsx packages/core/test/fixtures/mpp-channel-refusing-server.ts
 */
import "dotenv/config";

import crypto from "node:crypto";
import http from "node:http";

import { Challenge } from "mppx";

const PORT = 3004;

const channelContract = process.env.CHANNEL_CONTRACT;
if (!channelContract) {
  throw new Error("Missing CHANNEL_CONTRACT. Check .env.");
}

/** Matches the price the real channel fixture advertises, in base units. */
const PRICE = "10000";

function challengeHeader(): string {
  return Challenge.serialize(
    Challenge.from({
      id: crypto.randomUUID(),
      realm: "localhost",
      method: "stellar",
      intent: "channel",
      request: {
        amount: PRICE,
        channel: channelContract,
        methodDetails: { cumulativeAmount: "0" },
      },
    }),
  );
}

let refusals = 0;

const server = http.createServer((req, res) => {
  if (req.url !== "/data" || req.method !== "GET") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  const authorization = req.headers.authorization;
  if (authorization) {
    refusals += 1;
    console.log(`[refuse] credential #${refusals} rejected with 402`);
  }

  // Unconditional 402, credential or not. A fresh challenge accompanies every
  // refusal so a retrying client is never rejected merely for reusing one.
  res.writeHead(402, {
    "content-type": "application/json",
    "WWW-Authenticate": challengeHeader(),
  });
  res.end(
    JSON.stringify({
      title: "Always Refusing",
      detail: "This fixture refuses every credential by design.",
      status: 402,
    }),
  );
});

server.listen(PORT, () => {
  console.log(`Refusing MPP channel fixture on http://localhost:${PORT}/data`);
  console.log(`Channel: ${channelContract}`);
  console.log("Every credential will be refused. Expect ERROR (setup), not FAIL.");
});
