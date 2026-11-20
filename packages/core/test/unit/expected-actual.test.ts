/**
 * `expected` and `actual` on a FAIL (SOW 4.1 and 5.1, spec A4): for each FAIL, the
 * reason (`detail`), what the check expected, what the service sent, and the
 * fix. Both are short strings, set where the check knows them, and quote the
 * service, so they pass through the one sanitiser on their way out.
 *
 * `detail` and `hint` are not changed by this: existing consumers keep reading
 * the same strings.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { type CheckResult, checkStatus, toStructuredRun } from "../../src/check.js";
import { redactValue } from "../../src/report.js";
import { checkNetworkIdentifier, checkRequiredFields } from "../../src/x402/requirements.js";
import { runX402ReadChecks } from "../../src/x402/simulator.js";

const STELLAR_ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const STELLAR_PAY_TO = "GBNCC3VFT7PGUMGDQU5O35SXVWWTAHCO4LFFWLYFBLQCD56DNWYWM6ZS";

function option(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    amount: "10000",
    asset: STELLAR_ASSET,
    payTo: STELLAR_PAY_TO,
    maxTimeoutSeconds: 60,
    ...overrides,
  };
}

function challenge(accepts: unknown, version: unknown = 2): Record<string, unknown> {
  return { x402Version: version, accepts };
}

/** A service answering every request with `respond`. */
async function service(respond: (response: http.ServerResponse) => void) {
  const server = http.createServer((_request, response) => respond(response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/paid`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function header(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");
}

/** What the result must carry: a FAIL with both values, each a short one-line string. */
function assertExpectedActual(result: CheckResult | undefined, expected: RegExp, actual: RegExp): void {
  assert.ok(result !== undefined, "the check has a result");
  assert.equal(checkStatus(result), "FAIL", result.id);
  assert.equal(typeof result.expected, "string", `${result.id} has expected`);
  assert.equal(typeof result.actual, "string", `${result.id} has actual`);
  assert.match(result.expected ?? "", expected, `${result.id} expected`);
  assert.match(result.actual ?? "", actual, `${result.id} actual`);
  // One line each. The length is the sinks' to cut, after the secrets are removed: see redactValue below.
  for (const value of [result.expected ?? "", result.actual ?? ""]) assert.ok(!value.includes("\n"), `${result.id}: one line`);
}

describe("expected and actual on the FAILs of X402-01..03, against a service", () => {
  let wrongStatus: Awaited<ReturnType<typeof service>>;
  let noHeader: Awaited<ReturnType<typeof service>>;
  let undecodable: Awaited<ReturnType<typeof service>>;
  let empty: Awaited<ReturnType<typeof service>>;

  before(async () => {
    wrongStatus = await service((response) => {
      response.writeHead(200);
      response.end("free");
    });
    noHeader = await service((response) => {
      response.writeHead(402, { "content-type": "application/json" });
      response.end("{}");
    });
    undecodable = await service((response) => {
      response.writeHead(402, { "payment-required": header("this is not json at all, and it goes on") });
      response.end("{}");
    });
    empty = await service((response) => {
      response.writeHead(402, { "payment-required": header("") });
      response.end("{}");
    });
  });
  after(async () => {
    await Promise.all([wrongStatus.close(), noHeader.close(), undecodable.close(), empty.close()]);
  });

  it("X402-01: expects status 402 and says the status the service sent", async () => {
    const [first] = await runX402ReadChecks({ target: wrongStatus.url });
    assertExpectedActual(first, /402/, /200/);
    assert.equal(first?.detail, "Expected status 402, got 200.", "detail is unchanged");
  });

  it("X402-02: expects a PAYMENT-REQUIRED header and says none was there", async () => {
    const results = await runX402ReadChecks({ target: noHeader.url });
    assertExpectedActual(results.find((result) => result.id === "X402-02"), /PAYMENT-REQUIRED header/, /no PAYMENT-REQUIRED or X-Payment header/);
    assert.equal(
      results.find((result) => result.id === "X402-02")?.detail,
      "Neither PAYMENT-REQUIRED nor X-Payment header was present.",
      "detail is unchanged",
    );
  });

  it("X402-03: expects base64 JSON and quotes the start of what the header decoded to", async () => {
    const results = await runX402ReadChecks({ target: undecodable.url });
    assertExpectedActual(results.find((result) => result.id === "X402-03"), /base64.*JSON/i, /this is not json at all/);
    assert.match(results.find((result) => result.id === "X402-03")?.detail ?? "", /^Failed to decode\/parse: /, "detail is unchanged");
  });

  it("X402-03: says so when the header is empty", async () => {
    const results = await runX402ReadChecks({ target: empty.url });
    const third = results.find((result) => result.id === "X402-03");
    // An empty header is not a header at all to some stacks; either way the FAIL carries both values.
    if (third !== undefined && checkStatus(third) === "FAIL") assertExpectedActual(third, /JSON/, /empty|nothing|no value/i);
  });

  it("quotes a long header value whole, on one line: the sinks cut it, after the secrets are gone", async () => {
    const long = await service((response) => {
      response.writeHead(402, { "payment-required": header(`line one\nline two ${"x".repeat(3000)}`) });
      response.end("{}");
    });
    try {
      const third = (await runX402ReadChecks({ target: long.url })).find((result) => result.id === "X402-03");
      assertExpectedActual(third, /JSON/, /line one\\nline two xxx/);
    } finally {
      await long.close();
    }
  });
});

describe("expected and actual on the FAILs of X402-04", () => {
  it("an x402Version that is neither 1 nor 2", () => {
    assertExpectedActual(checkRequiredFields(challenge([option()], 3)), /x402Version 2/, /x402Version 3/);
    assertExpectedActual(checkRequiredFields({ accepts: [option()] }), /x402Version 2/, /no x402Version|undefined/);
  });

  it("no payment options: missing, empty or not a list", () => {
    assertExpectedActual(checkRequiredFields({ x402Version: 2 }), /at least one/, /accepts is missing/);
    assertExpectedActual(checkRequiredFields(challenge([])), /at least one/, /accepts is empty/);
  });

  it("missing fields: names the ones that are missing, in both", () => {
    const { asset: _asset, payTo: _payTo, ...rest } = option();
    const result = checkRequiredFields(challenge([rest]));
    assertExpectedActual(result, /asset, payTo/, /asset, payTo/);
    assert.match(result.expected ?? "", /present/);
    assert.match(result.actual ?? "", /missing/);
    assert.equal(result.detail, "Missing: asset, payTo.", "detail is unchanged");
  });

  it("a field of the wrong type: the type it needs and the value it had", () => {
    const result = checkRequiredFields(challenge([option({ amount: 10000 })]));
    assertExpectedActual(result, /amount.*string/, /amount.*number 10000/);
  });

  it("a v1 price field name in a v2 challenge: the name v2 requires and the one found", () => {
    const { amount: _amount, ...rest } = option();
    const result = checkRequiredFields(challenge([{ ...rest, maxAmountRequired: "10000" }]));
    assertExpectedActual(result, /`amount`/, /`maxAmountRequired`/);
  });

  it("several options: each problem is labelled with its option", () => {
    const { payTo: _payTo, ...rest } = option();
    const result = checkRequiredFields(challenge([option(), rest]));
    assertExpectedActual(result, /accepts\[1\]: payTo/, /accepts\[1\]: payTo/);
  });
});

describe("expected and actual on the FAIL of X402-05", () => {
  it("a name that is not CAIP-2: the shape needed and the value sent", () => {
    const result = checkNetworkIdentifier(challenge([option({ network: "base-sepolia" })]));
    assertExpectedActual(result, /CAIP-2/, /"base-sepolia"/);
    assert.match(result.detail, /is not a CAIP-2 identifier/, "detail is unchanged");
  });

  it("a Stellar network that does not exist: the two that do", () => {
    assertExpectedActual(checkNetworkIdentifier(challenge([option({ network: "stellar:mainnet" })])), /stellar:testnet or stellar:pubnet/, /"stellar:mainnet"/);
  });

  it("an eip155 id in hex: the base 10 shape", () => {
    assertExpectedActual(checkNetworkIdentifier(challenge([option({ network: "eip155:0x14a34" })])), /eip155:.*base 10/, /"eip155:0x14a34"/);
  });

  it("a solana reference that is not a genesis hash prefix", () => {
    assertExpectedActual(checkNetworkIdentifier(challenge([option({ network: "solana:devnet" })])), /solana:.*genesis hash/, /"solana:devnet"/);
  });

  it("several options: the one that is wrong is named", () => {
    const result = checkNetworkIdentifier(challenge([option(), option({ network: "base-sepolia" })]));
    assertExpectedActual(result, /accepts\[1\]/, /accepts\[1\].*"base-sepolia"/);
  });

  it("quotes a long network value whole: the sinks cut it", () => {
    const result = checkNetworkIdentifier(challenge([option({ network: `x${"y".repeat(500)}` })]));
    assertExpectedActual(result, /CAIP-2/, /yyy/);
  });
});

describe("a check that passes, skips or errors carries neither value", () => {
  it("has no expected and no actual", () => {
    for (const result of [checkRequiredFields(challenge([option()])), checkNetworkIdentifier(challenge([option()])), checkNetworkIdentifier(challenge([]))]) {
      assert.ok(!("expected" in result), result.id);
      assert.ok(!("actual" in result), result.id);
    }
  });
});

describe("toStructuredRun and expected and actual", () => {
  const failing: CheckResult = {
    id: "X402-01",
    name: "402 Response Status",
    pass: false,
    detail: "Expected status 402, got 200.",
    hint: "Answer an unpaid request with 402.",
    expected: "status 402",
    actual: "status 200",
  };

  it("carries both on a FAIL, and leaves every old field as it was", () => {
    const withValues = toStructuredRun([failing]).results[0]!;
    const { expected: _e, actual: _a, ...without } = failing;
    const old = toStructuredRun([without]).results[0]!;
    assert.equal(withValues.expected, "status 402");
    assert.equal(withValues.actual, "status 200");
    const { expected: _e2, actual: _a2, ...rest } = withValues;
    assert.deepEqual(rest, old, "id, name, status, detail, destructive, fix, docs: unchanged");
    assert.deepEqual(Object.keys(old).sort(), ["destructive", "detail", "docs", "fix", "id", "name", "status"]);
  });

  it("leaves the keys out when the check did not record them", () => {
    const run = toStructuredRun([{ id: "X402-01", name: "n", pass: false, detail: "d" }]);
    assert.ok(!("expected" in run.results[0]!));
    assert.ok(!("actual" in run.results[0]!));
  });

  it("carries them only on a FAIL: not on a pass, a skip or an error", () => {
    const run = toStructuredRun([
      { id: "A", name: "a", pass: true, detail: "d", expected: "x", actual: "y" },
      { id: "B", name: "b", pass: false, detail: "d", skipped: true, skipReason: "r", expected: "x", actual: "y" },
      { id: "C", name: "c", pass: false, detail: "d", error: { kind: "harness", message: "m" }, expected: "x", actual: "y" },
    ]);
    for (const result of run.results) {
      assert.ok(!("expected" in result), result.id);
      assert.ok(!("actual" in result), result.id);
    }
  });

  it("passes both through the sanitiser: control characters, a leading ::, a Stellar key", () => {
    const key = `S${"A".repeat(55)}`;
    const run = toStructuredRun([
      { ...failing, expected: "ok\u001b[2J\n::set-output name=x::1", actual: `a\u0007b ${key}\n##[warning]hi` },
    ]);
    const { expected, actual } = run.results[0]!;
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(`${expected}${actual}`.replace(/\n/g, "")));
    assert.ok(!/^\s*(::|##\[)/m.test(`${expected}\n${actual}`));
    assert.ok(!(actual ?? "").includes(key));
  });
});

describe("redactValue and the length of expected and actual", () => {
  const SECRET = "canary-header-value-7f3a-0123456789";
  const failing = (actual: string, expected = "status 402"): CheckResult => ({
    id: "X402-05",
    name: "Network Identifier Valid",
    pass: false,
    detail: "d",
    expected,
    actual,
  });

  it("cuts expected and actual to 200 characters, with an ellipsis, and nothing else", () => {
    const run = redactValue(toStructuredRun([failing("y".repeat(1000), "e".repeat(1000))]), []);
    const [result] = run.results;
    assert.equal(Array.from(result!.actual ?? "").length, 200);
    assert.equal(Array.from(result!.expected ?? "").length, 200);
    assert.ok((result!.actual ?? "").endsWith("…"));
    assert.equal(result!.detail, "d");
  });

  it("removes a secret before it cuts: one that straddles the cut leaves no start of itself", () => {
    // 190 characters, then the secret: a cut at 200 first would keep its first 10.
    const run = redactValue(toStructuredRun([failing(`"${"a".repeat(189)}${SECRET} and more after it"`)]), [SECRET]);
    const actual = run.results[0]!.actual ?? "";
    assert.ok(!actual.includes(SECRET));
    assert.ok(!actual.includes("canary"), "no start of it either");
    assert.ok(actual.includes("[redacted"), "the mask is there, itself cut by the limit");
  });

  it("does the same for a report or a run with no secrets to remove", () => {
    const run = redactValue(toStructuredRun([failing("z".repeat(500))]), []);
    assert.equal(Array.from(run.results[0]!.actual ?? "").length, 200);
  });
});
