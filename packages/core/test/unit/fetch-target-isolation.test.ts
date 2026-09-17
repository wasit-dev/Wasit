/**
 * Regression guard: a payment client must not decide how later checks read the
 * target.
 *
 * `Mppx.create` replaces `globalThis.fetch` with a wrapper bound to a single
 * payment method unless `polyfill: false` is passed. A charge-mode client left
 * behind by MPP-01 therefore used to make every later channel-mode 402 fail
 * with "No method found for challenges: stellar.channel. Available:
 * stellar.charge", reported as a defect in a target that was in fact
 * conformant. Only the first payment-mode check in a process produced a
 * trustworthy verdict, which matters most in the MCP server, where one process
 * serves many tool calls in a row.
 *
 * Opting out at every call site is necessary but not sufficient: one stale
 * build, one new dependency, or one future caller that forgets brings the leak
 * back silently. `fetchTarget` must observe the target through the underlying
 * fetch whatever a previous check installed on the global.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { Mppx, charge } from "@stellar/mpp/charge/client";
import { Keypair } from "@stellar/stellar-sdk";
import { Challenge } from "mppx";

import { fetchTarget } from "../../src/errors.js";

/** Any valid contract address works: nothing here reaches a chain. */
const CHANNEL_CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function channelChallengeHeader(): string {
  return Challenge.serialize(
    Challenge.from({
      id: "regression-channel-challenge",
      realm: "127.0.0.1",
      method: "stellar",
      intent: "channel",
      request: { amount: "100", channel: CHANNEL_CONTRACT },
    }),
  );
}

describe("fetchTarget survives a polyfilled global fetch", () => {
  let server: http.Server;
  let target: string;

  before(async () => {
    const header = channelChallengeHeader();
    server = http.createServer((_request, response) => {
      response.writeHead(402, {
        "content-type": "text/plain",
        "WWW-Authenticate": header,
      });
      response.end("payment required");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Challenge fixture did not bind to a TCP port.");
    }
    target = `http://127.0.0.1:${address.port}/data`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("reads a channel challenge after a charge client polyfilled the global", async () => {
    // `polyfill: true` is deliberate. The point is to reproduce the leak, not
    // to trust that every present and future caller opts out of it.
    Mppx.create({
      methods: [charge({ secretKey: Keypair.random().secret() })],
      polyfill: true,
    });

    try {
      // Control. This is what every channel check used to see. If it stops
      // throwing, mppx has changed and the assertion below no longer proves
      // anything, so the guard must be revisited rather than deleted.
      await assert.rejects(
        () => globalThis.fetch(target),
        /No method found for challenges: stellar\.channel/,
      );

      const response = await fetchTarget(target);
      assert.equal(response.status, 402);
    } finally {
      Mppx.restore();
    }
  });
});
