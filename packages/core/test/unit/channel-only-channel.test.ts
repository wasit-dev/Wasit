/**
 * The channel checks with `onlyChannel` (what `wasit run` passes from the
 * config's `channel`): a commitment is signed for that channel only. A fresh
 * challenge that names another channel gets no signature, checked at the
 * signature itself, so a service cannot switch channels between challenges.
 *
 * The target is a hand-made channel challenge on 127.0.0.1; the RPC is an https
 * address on 127.0.0.1 that counts connections and drops each one (signing a
 * commitment simulates `prepare_commitment` through it, so a connection is a
 * signature being prepared). Nothing leaves 127.0.0.1 and no key holds funds.
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Networks, StrKey } from "@stellar/stellar-sdk";
import { Challenge } from "mppx";

import { CheckSetupError } from "../../src/errors.js";
import { setRpcIdentityTransportForTesting } from "../../src/guard/rpc-identity.js";
import {
  runMppChannelCommitmentReplayCheck,
  runMppChannelOrderingCheck,
  runMppChannelReplayCheck,
  type MppChannelCheckOptions,
} from "../../src/mpp/channel.js";
import { buildChannelCredential, parseChannelChallenge } from "../../src/mpp/channel-credential.js";
import { runMppChannelSuite } from "../../src/mpp/suite.js";

const CONFIGURED = StrKey.encodeContract(randomBytes(32));
const OTHER = StrKey.encodeContract(randomBytes(32));
const SEED = randomBytes(32).toString("hex");

/** A target whose every challenge names `channel`, counting the requests that carry a credential. */
async function channelTarget(channel: string) {
  const header = Challenge.serialize(
    Challenge.from({
      id: "only-channel",
      realm: "127.0.0.1",
      method: "stellar",
      intent: "channel",
      request: { amount: "100", channel, methodDetails: { network: "stellar:testnet" } },
    }),
  );
  let credentials = 0;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization) credentials += 1;
    res.writeHead(402, { "WWW-Authenticate": header });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/stream`,
    credentials: () => credentials,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function countingRpc() {
  let calls = 0;
  const server = net.createServer((socket) => {
    calls += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `https://127.0.0.1:${port}`,
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const REFUSAL = new RegExp(
  `The route's challenge names the channel "${OTHER}", and this run signs commitments for its configured channel ` +
    `${CONFIGURED} only\\. Nothing was signed\\.`,
);

describe("buildChannelCredential with onlyChannel", () => {
  it("refuses a challenge for another channel before anything is prepared or signed", async () => {
    const rpc = await countingRpc();
    try {
      const challenge = parseChannelChallenge({ request: { channel: OTHER, amount: "100" } } as never);
      const error = await buildChannelCredential({
        challenge,
        amount: 100n,
        commitmentSecretHex: SEED,
        network: "stellar:testnet",
        rpcUrl: rpc.url,
        onlyChannel: CONFIGURED,
      }).then(
        () => assert.fail("expected a refusal"),
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof CheckSetupError, String(error));
      assert.match((error as Error).message, REFUSAL);
      assert.equal(rpc.calls(), 0);
    } finally {
      await rpc.close();
    }
  });

  it("goes on to prepare the commitment for the configured channel", async () => {
    const rpc = await countingRpc();
    try {
      const challenge = parseChannelChallenge({ request: { channel: CONFIGURED, amount: "100" } } as never);
      const error = await buildChannelCredential({
        challenge,
        amount: 100n,
        commitmentSecretHex: SEED,
        network: "stellar:testnet",
        rpcUrl: rpc.url,
        onlyChannel: CONFIGURED,
      }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      // The RPC stand-in answers nothing, so preparing fails; what matters is that it was reached.
      assert.doesNotMatch(String((error as Error | undefined)?.message), REFUSAL);
      assert.ok(rpc.calls() > 0, "the commitment was never prepared");
    } finally {
      await rpc.close();
    }
  });
});

describe("the channel checks with onlyChannel", () => {
  let target: Awaited<ReturnType<typeof channelTarget>>;
  let rpc: Awaited<ReturnType<typeof countingRpc>>;
  beforeEach(async () => {
    target = await channelTarget(OTHER);
    rpc = await countingRpc();
    setRpcIdentityTransportForTesting(async () => ({ passphrase: Networks.TESTNET }));
  });
  afterEach(async () => {
    setRpcIdentityTransportForTesting(undefined);
    await target.close();
    await rpc.close();
  });

  for (const [id, run] of [
    ["MPP-11", runMppChannelOrderingCheck],
    ["MPP-12", runMppChannelReplayCheck],
    ["MPP-14", runMppChannelCommitmentReplayCheck],
  ] as const) {
    it(`${id} signs nothing for a route whose challenge names another channel: no verdict`, async () => {
      const options: MppChannelCheckOptions = {
        target: target.url,
        commitmentSecretHex: SEED,
        network: "stellar:testnet",
        rpcUrl: rpc.url,
        onlyChannel: CONFIGURED,
      };
      const [result] = await run(options);
      assert.equal(result?.id, id);
      assert.equal(result?.pass, false);
      assert.equal(result?.error?.kind, "setup", result?.detail);
      assert.match(result?.detail ?? "", REFUSAL);
      assert.equal(rpc.calls(), 0);
      assert.equal(target.credentials(), 0);
    });
  }

  it("the suite (as wasit run calls it) reports the mismatch in MPP-10 and signs nothing in MPP-11, 12 and 14", async () => {
    const results = await runMppChannelSuite({
      target: target.url,
      commitmentSecretHex: SEED,
      network: "stellar:testnet",
      rpcUrl: rpc.url,
      channelOverride: CONFIGURED,
      onlyChannel: CONFIGURED,
    });
    assert.match(results.find((result) => result.id === "MPP-10")?.detail ?? "", /Channel mismatch/);
    for (const id of ["MPP-11", "MPP-12", "MPP-14"]) {
      const result = results.find((entry) => entry.id === id);
      assert.equal(result?.error?.kind, "setup", `${id}: ${result?.detail}`);
      assert.match(result?.detail ?? "", REFUSAL);
    }
    assert.equal(rpc.calls(), 0);
    assert.equal(target.credentials(), 0);
  });

  it("without onlyChannel the checks still sign for the channel the challenge names (wasit mpp-channel)", async () => {
    const [result] = await runMppChannelReplayCheck({
      target: target.url,
      commitmentSecretHex: SEED,
      network: "stellar:testnet",
      rpcUrl: rpc.url,
    });
    assert.doesNotMatch(result?.detail ?? "", REFUSAL);
    assert.ok(rpc.calls() > 0, "the commitment was never prepared");
  });
});
