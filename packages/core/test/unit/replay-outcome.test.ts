import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeReplayOutcome } from "../../src/mpp/channel.js";

// MPP-12 and MPP-14 fail on any status other than 402, but only a 2xx means the
// replay was honoured. `@stellar/mpp` built on mppx 0.10 refuses replays with
// HTTP 500, which must not be reported as a double-spend.
describe("replay outcome wording", () => {
  it("calls an honoured replay a double-spend", () => {
    for (const status of [200, 201, 204]) {
      assert.match(describeReplayOutcome(status), /^This is a double-spend\.$/);
    }
  });

  it("does not call a refused replay a double-spend", () => {
    for (const status of [400, 401, 409, 500, 503]) {
      const text = describeReplayOutcome(status);
      assert.match(text, /not a double-spend/);
      assert.match(text, /HTTP 402/);
    }
  });
});
