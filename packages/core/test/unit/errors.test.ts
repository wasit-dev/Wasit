import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CheckSetupError,
  ConfigurationError,
  MalformedResponseError,
  TargetUnreachableError,
  assertHttpUrl,
  classifyCheckError,
  fetchTarget,
} from "../../src/errors.js";

describe("assertHttpUrl", () => {
  it("accepts absolute http and https URLs", () => {
    assert.doesNotThrow(() => assertHttpUrl("http://localhost:3003/data"));
    assert.doesNotThrow(() => assertHttpUrl("https://api.example.com/paid"));
  });

  it("rejects a string that is not a URL at all", () => {
    assert.throws(() => assertHttpUrl("not a url"), ConfigurationError);
  });

  // Regression guard: "localhost:3003/data" parses cleanly as scheme
  // "localhost:", so a bare new URL() check lets it reach fetch, where it
  // resurfaces as a transport failure and is misreported as the target being
  // unreachable when the real fault is the operator's argument.
  it("rejects a bare host:port that parses as its own scheme", () => {
    assert.throws(() => assertHttpUrl("localhost:3003/data"), ConfigurationError);
  });

  it("rejects non-HTTP schemes", () => {
    assert.throws(() => assertHttpUrl("ftp://example.com/x"), ConfigurationError);
    assert.throws(() => assertHttpUrl("file:///etc/passwd"), ConfigurationError);
  });
});

describe("TargetUnreachableError", () => {
  // Node's fetch reports every transport failure as "TypeError: fetch failed"
  // and hangs the real error off .cause, which is where ECONNREFUSED and the
  // TLS codes actually live.
  it("lifts a transport code out of the cause chain", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
      code: "ECONNREFUSED",
    });
    const outer = Object.assign(new TypeError("fetch failed"), { cause: inner });
    const error = new TargetUnreachableError("http://localhost:9/x", outer);

    assert.equal(error.code, "ECONNREFUSED");
    assert.match(error.message, /ECONNREFUSED/);
    assert.match(error.message, /http:\/\/localhost:9\/x/);
  });

  it("leaves the code undefined when the chain carries none", () => {
    const error = new TargetUnreachableError("http://x.test/", new Error("boom"));
    assert.equal(error.code, undefined);
    assert.equal(error.message, "Could not connect to http://x.test/: boom");
  });

  it("terminates on a cyclic cause chain", () => {
    const first: { cause?: unknown } = {};
    first.cause = { cause: first };
    assert.doesNotThrow(() => new TargetUnreachableError("http://x.test/", first));
  });

  it("stringifies a reason that is not an Error", () => {
    const error = new TargetUnreachableError("http://x.test/", "socket hang up");
    assert.match(error.message, /socket hang up/);
  });

  it("keeps the original throw for diagnostics", () => {
    const reason = new Error("boom");
    assert.equal(new TargetUnreachableError("http://x.test/", reason).reason, reason);
  });
});

describe("classifyCheckError", () => {
  // A malformed response IS a verdict: the service answered, and what it
  // answered did not conform. Classifying it as an operational error would
  // report a real conformance defect as "we could not tell".
  it("treats a malformed response as a verdict, not an operational error", () => {
    const classified = classifyCheckError(new MalformedResponseError("no price field"));
    assert.deepEqual(classified, { kind: "malformed-response", message: "no price field" });
  });

  it("classifies an unreachable target and carries its transport code", () => {
    const inner = Object.assign(new Error("nope"), { code: "ENOTFOUND" });
    const classified = classifyCheckError(new TargetUnreachableError("http://x.test/", inner));

    assert.equal(classified.kind, "unreachable");
    assert.equal((classified as { code?: string }).code, "ENOTFOUND");
  });

  it("omits the code key entirely when there is no transport code", () => {
    const classified = classifyCheckError(
      new TargetUnreachableError("http://x.test/", new Error("nope")),
    );

    assert.equal(classified.kind, "unreachable");
    assert.ok(!("code" in classified));
  });

  it("classifies a configuration error", () => {
    assert.deepEqual(classifyCheckError(new ConfigurationError("bad url")), {
      kind: "configuration",
      message: "bad url",
    });
  });

  // A setup failure is not a verdict about the target. MPP channel checks must
  // first get a valid commitment accepted, and a channel another payer is using
  // refuses that the same way a broken target does, so the two must not share a
  // reporting shape.
  it("classifies a setup error as its own kind, not as a conformance failure", () => {
    assert.deepEqual(classifyCheckError(new CheckSetupError("cumulative moved")), {
      kind: "setup",
      message: "cumulative moved",
    });
  });

  it("falls back to harness for anything unrecognised", () => {
    assert.equal(classifyCheckError(new Error("unexpected")).kind, "harness");
    assert.deepEqual(classifyCheckError("a bare string"), {
      kind: "harness",
      message: "a bare string",
    });
  });
});

describe("fetchTarget", () => {
  it("rejects a bad URL before attempting any connection", async () => {
    await assert.rejects(() => fetchTarget("localhost:3003/data"), ConfigurationError);
  });

  // Port 9 is the discard port; nothing listens on it, so the connection is
  // refused on loopback without touching the network.
  it("wraps a refused connection as TargetUnreachableError", async () => {
    await assert.rejects(() => fetchTarget("http://127.0.0.1:9/nope"), TargetUnreachableError);
  });
});
