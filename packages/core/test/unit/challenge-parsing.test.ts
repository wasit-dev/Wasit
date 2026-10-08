import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Challenge } from "mppx";

import { classifyCheckError } from "../../src/errors.js";
import { parseChargeChallenge } from "../../src/mpp/charge.js";
import { ChannelChallengeError, parseChannelChallenge } from "../../src/mpp/channel-credential.js";

/**
 * A decoded challenge carrying an arbitrary request object.
 *
 * Only `request` is read by either parser, so the rest of the SDK's challenge
 * shape is irrelevant here — and building it for real would mean standing up a
 * server, which is exactly what splitting these parsers out avoids.
 */
function challengeWith(request: unknown): Challenge.Challenge {
  return { request } as unknown as Challenge.Challenge;
}

// Larger than Number.MAX_SAFE_INTEGER (2^53 - 1). Amounts are i128 base units
// on-chain, so anything routed through a float silently loses precision here.
const BEYOND_SAFE_INTEGER = "9007199254740993";

describe("parseChannelChallenge", () => {
  it("reads the channel, the request price and the cumulative", () => {
    const parsed = parseChannelChallenge(
      challengeWith({
        channel: "CBCWCJDYIHAJVRWMSDKANFX43UBZWX3CZPWNFZ5QTGGZPVIWVXXDN7J6",
        amount: "40000",
        methodDetails: { cumulativeAmount: "120000" },
      }),
    );

    assert.equal(
      parsed.channelContract,
      "CBCWCJDYIHAJVRWMSDKANFX43UBZWX3CZPWNFZ5QTGGZPVIWVXXDN7J6",
    );
    assert.equal(parsed.requestedAmount, 40000n);
    assert.equal(parsed.cumulativeAmount, 120000n);
  });

  it("keeps the decoded challenge verbatim for later serialisation", () => {
    const challenge = challengeWith({ channel: "C1", amount: "1" });
    assert.equal(parseChannelChallenge(challenge).challenge, challenge);
  });

  // A channel that has taken no voucher yet reports no cumulative at all, and
  // the server's own starting cumulative is zero.
  it("reads a missing cumulative as zero", () => {
    const noDetails = challengeWith({ channel: "C1", amount: "1" });
    assert.equal(parseChannelChallenge(noDetails).cumulativeAmount, 0n);

    const emptyDetails = challengeWith({ channel: "C1", amount: "1", methodDetails: {} });
    assert.equal(parseChannelChallenge(emptyDetails).cumulativeAmount, 0n);
  });

  it("carries amounts beyond float precision without loss", () => {
    const parsed = parseChannelChallenge(
      challengeWith({
        channel: "C1",
        amount: BEYOND_SAFE_INTEGER,
        methodDetails: { cumulativeAmount: BEYOND_SAFE_INTEGER },
      }),
    );

    assert.equal(parsed.requestedAmount, BigInt(BEYOND_SAFE_INTEGER));
    assert.equal(parsed.cumulativeAmount, BigInt(BEYOND_SAFE_INTEGER));
    assert.notEqual(parsed.requestedAmount, BigInt(Number(BEYOND_SAFE_INTEGER)));
  });

  it("rejects a challenge with no request object", () => {
    assert.throws(() => parseChannelChallenge(challengeWith(undefined)), ChannelChallengeError);
    assert.throws(() => parseChannelChallenge(challengeWith(null)), ChannelChallengeError);
    assert.throws(() => parseChannelChallenge(challengeWith("not an object")), ChannelChallengeError);
  });

  it("rejects a request missing the channel or the amount", () => {
    assert.throws(() => parseChannelChallenge(challengeWith({ amount: "1" })), ChannelChallengeError);
    assert.throws(() => parseChannelChallenge(challengeWith({ channel: "C1" })), ChannelChallengeError);
  });

  it("rejects non-string channel and amount values", () => {
    assert.throws(
      () => parseChannelChallenge(challengeWith({ channel: "C1", amount: 1 })),
      ChannelChallengeError,
    );
    assert.throws(
      () => parseChannelChallenge(challengeWith({ channel: 1, amount: "1" })),
      ChannelChallengeError,
    );
  });

  it("rejects a non-numeric amount and names both values", () => {
    assert.throws(
      () => parseChannelChallenge(challengeWith({ channel: "C1", amount: "1.5" })),
      (error: unknown) => {
        assert.ok(error instanceof ChannelChallengeError);
        assert.match(error.message, /amount="1\.5"/);
        assert.match(error.message, /cumulativeAmount="0"/);
        return true;
      },
    );
  });

  it("rejects a non-numeric cumulative", () => {
    assert.throws(
      () =>
        parseChannelChallenge(
          challengeWith({
            channel: "C1",
            amount: "1",
            methodDetails: { cumulativeAmount: "many" },
          }),
        ),
      ChannelChallengeError,
    );
  });

  // ChannelChallengeError extends MalformedResponseError, so a bad challenge
  // is a verdict about the target rather than a harness bug.
  it("classifies every rejection as a malformed response", () => {
    let thrown: unknown;
    try {
      parseChannelChallenge(challengeWith({}));
    } catch (error) {
      thrown = error;
    }

    assert.equal(classifyCheckError(thrown).kind, "malformed-response");
  });
});

describe("parseChargeChallenge", () => {
  it("reads the advertised amount, currency and recipient", () => {
    const parsed = parseChargeChallenge(
      challengeWith({
        amount: "10000",
        currency: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        recipient: "GALVZ57VAY6BE33WYPJMUJ27PFAUDRQ6ATTVMIIF4STTGQTXDBEIBXUI",
      }),
    );

    assert.equal(parsed.amount, 10000n);
    assert.equal(parsed.currency, "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
    assert.equal(parsed.recipient, "GALVZ57VAY6BE33WYPJMUJ27PFAUDRQ6ATTVMIIF4STTGQTXDBEIBXUI");
  });

  it("carries amounts beyond float precision without loss", () => {
    const parsed = parseChargeChallenge(
      challengeWith({ amount: BEYOND_SAFE_INTEGER, currency: "C1", recipient: "G1" }),
    );

    assert.equal(parsed.amount, BigInt(BEYOND_SAFE_INTEGER));
    assert.notEqual(parsed.amount, BigInt(Number(BEYOND_SAFE_INTEGER)));
  });

  it("rejects a challenge with no request object", () => {
    assert.throws(() => parseChargeChallenge(challengeWith(undefined)), /no request object/);
  });

  // The network the SDK's client would sign for: the challenge's own, or
  // testnet when it names none (resolveNetworkId in @stellar/mpp 0.7.1).
  it("reads the network the SDK would sign for", () => {
    const terms = { amount: "1", currency: "C1", recipient: "G1" };
    assert.equal(parseChargeChallenge(challengeWith(terms)).network, "stellar:testnet");
    assert.equal(parseChargeChallenge(challengeWith({ ...terms, methodDetails: {} })).network, "stellar:testnet");
    assert.equal(
      parseChargeChallenge(challengeWith({ ...terms, methodDetails: { network: "stellar:pubnet" } })).network,
      "stellar:pubnet",
    );
  });

  it("rejects a network that is not a Stellar CAIP-2 identifier", () => {
    const terms = { amount: "1", currency: "C1", recipient: "G1" };
    for (const network of ["stellar:mainnet", "eip155:8453", 7]) {
      assert.throws(
        () => parseChargeChallenge(challengeWith({ ...terms, methodDetails: { network } })),
        /names network .*"stellar:testnet" or "stellar:pubnet"/,
        String(network),
      );
    }
  });

  // An operator fixing one field at a time needs the whole list, not the first
  // thing that happened to be checked.
  it("names every missing field, not just the first", () => {
    assert.throws(
      () => parseChargeChallenge(challengeWith({ amount: "1" })),
      /missing currency, recipient/,
    );
    assert.throws(
      () => parseChargeChallenge(challengeWith({})),
      /missing amount, currency, recipient/,
    );
  });

  it("treats a blank field as missing", () => {
    assert.throws(
      () => parseChargeChallenge(challengeWith({ amount: "1", currency: "C1", recipient: "" })),
      /missing recipient/,
    );
  });

  it("explains that a non-numeric amount must be base units", () => {
    assert.throws(
      () => parseChargeChallenge(challengeWith({ amount: "0.001", currency: "C1", recipient: "G1" })),
      /non-numeric amount \("0\.001"\)[\s\S]*base units/,
    );
  });

  it("classifies every rejection as a malformed response", () => {
    let thrown: unknown;
    try {
      parseChargeChallenge(challengeWith({}));
    } catch (error) {
      thrown = error;
    }

    assert.equal(classifyCheckError(thrown).kind, "malformed-response");
  });
});
