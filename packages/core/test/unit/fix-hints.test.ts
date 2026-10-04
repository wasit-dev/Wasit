/**
 * Fix hints: every failure says what to change.
 *
 * A FAIL used to say only what was wrong. Builders new to x402 then had to
 * read the spec to work out the fix. Each FAIL now carries guidance: the
 * result's own `hint` for the cause it found, or its catalogue entry's `fix`
 * as a fallback, plus the docs page. Nothing that is not a FAIL gets any,
 * so a skip or a no-verdict never reads as a defect to fix.
 *
 * Also covers X402-04 checking every field its version requires.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";

import { CHECK_CATALOGUE } from "../../src/catalogue.js";
import { fixFor, toStructuredRun, type CheckResult } from "../../src/check.js";
import { checkNetworkIdentifier, checkRequiredFields } from "../../src/x402/requirements.js";
import {
  readSettlementReference,
  runX402ReadChecks,
  signatureRejectionVerdict,
} from "../../src/x402/simulator.js";

function v2Option(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    amount: "10000",
    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    payTo: "GBNCC3VFT7PGUMGDQU5O35SXVWWTAHCO4LFFWLYFBLQCD56DNWYWM6ZS",
    maxTimeoutSeconds: 60,
    ...overrides,
  };
}

function v2(...accepts: unknown[]): Record<string, unknown> {
  return { x402Version: 2, resource: { url: "http://127.0.0.1/paid" }, accepts };
}

describe("X402-04 checks every field its version requires", () => {
  for (const field of ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds"]) {
    it(`fails a v2 option without ${field}`, () => {
      const result = checkRequiredFields(v2(v2Option({ [field]: undefined })));
      assert.equal(result.pass, false);
      assert.equal(result.detail, `Missing: ${field}.`);
      assert.match(result.hint ?? "", new RegExp(`Add \`${field}\``));
    });
  }

  it("holds a v1 option to the v1 list, including resource and description", () => {
    const v1Option = {
      scheme: "exact",
      network: "stellar:testnet",
      maxAmountRequired: "10000",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      payTo: "GBNCC3VFT7PGUMGDQU5O35SXVWWTAHCO4LFFWLYFBLQCD56DNWYWM6ZS",
      resource: "http://127.0.0.1/paid",
      description: "test",
      maxTimeoutSeconds: 60,
    };
    assert.equal(checkRequiredFields({ x402Version: 1, accepts: [v1Option] }).pass, true);
    const without = checkRequiredFields({
      x402Version: 1,
      accepts: [{ ...v1Option, resource: undefined, description: undefined }],
    });
    assert.equal(without.detail, "Missing: resource, description.");
  });

  it("does not ask a v2 option for v1-only fields", () => {
    assert.equal(checkRequiredFields(v2(v2Option())).pass, true);
  });

  it("reports a field of the wrong type as such, not as missing", () => {
    const result = checkRequiredFields(v2(v2Option({ amount: 10000 })));
    assert.equal(result.pass, false);
    assert.equal(result.detail, "Wrong type: amount must be a string (got number 10000).");
    assert.match(result.hint ?? "", /strings for amounts/);
  });

  // A zero or negative timeout leaves the client no time to pay.
  for (const value of [0, -5, "60", Number.POSITIVE_INFINITY]) {
    it(`rejects maxTimeoutSeconds ${String(value)}`, () => {
      const result = checkRequiredFields(v2(v2Option({ maxTimeoutSeconds: value })));
      assert.equal(result.pass, false);
      assert.match(result.detail, /maxTimeoutSeconds must be a positive number of seconds/);
    });
  }

  it("points a hand-built challenge at the SDK when fields are missing", () => {
    const result = checkRequiredFields(v2(v2Option({ maxTimeoutSeconds: undefined })));
    assert.match(result.hint ?? "", /official x402 server SDK fills every required field/);
  });

  it("says each fix once across options", () => {
    const result = checkRequiredFields(
      v2(v2Option({ payTo: undefined }), v2Option({ payTo: undefined })),
    );
    const hint = result.hint ?? "";
    assert.equal(hint.split("Add `payTo`").length - 1, 1);
  });

  it("tells a v2 challenge with the v1 price name to rename it", () => {
    const result = checkRequiredFields(v2(v2Option({ amount: undefined, maxAmountRequired: "1" })));
    assert.match(result.hint ?? "", /Rename `maxAmountRequired` to `amount`/);
  });

  it("guides an unknown version and an empty accepts", () => {
    assert.match(checkRequiredFields({ x402Version: 3 }).hint ?? "", /x402Version` to 2/);
    assert.match(checkRequiredFields(v2()).hint ?? "", /at least one payment option/);
  });
});

describe("X402-05 hints", () => {
  it("converts a hex eip155 chain id to base 10", () => {
    const result = checkNetworkIdentifier(v2(v2Option({ network: "eip155:0x14a34" })));
    assert.equal(result.pass, false);
    assert.equal(result.hint, "Write the chain id in base 10: eip155:84532.");
  });

  it("names CAIP-2 examples for a plain name", () => {
    const result = checkNetworkIdentifier(v2(v2Option({ network: "base-sepolia" })));
    assert.match(result.hint ?? "", /CAIP-2 id.*eip155:84532 \(Base Sepolia\)/);
  });

  it("names the two Stellar networks", () => {
    const result = checkNetworkIdentifier(v2(v2Option({ network: "stellar:mainnet" })));
    assert.equal(result.hint, "Use stellar:testnet or stellar:pubnet.");
  });

  it("names the Solana genesis-hash form", () => {
    const result = checkNetworkIdentifier(v2(v2Option({ network: "solana:devnet" })));
    assert.match(result.hint ?? "", /getGenesisHash/);
  });

  it("says each fix once across options", () => {
    const result = checkNetworkIdentifier(
      v2(v2Option({ network: "stellar:mainnet" }), v2Option({ network: "stellar:main" })),
    );
    assert.equal(result.hint, "Use stellar:testnet or stellar:pubnet.");
  });

  it("gives a passing check no hint", () => {
    assert.equal(checkNetworkIdentifier(v2(v2Option())).hint, undefined);
  });
});

/** Answers every request with `status`, an optional header and body. */
async function answer(
  status: number,
  headers: Record<string, string> = {},
  body = "",
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(status, headers);
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/paid`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function byId(results: CheckResult[]): Record<string, CheckResult> {
  return Object.fromEntries(results.map((result) => [result.id, result]));
}

describe("X402-01 to X402-03 hints", () => {
  for (const [status, pattern] of [
    [200, /served HTTP 200 without payment/],
    [401, /402, not 401/],
    [403, /402, not 403/],
    [404, /wrong path or method/],
    [500, /Answer an unpaid request with 402/],
  ] as const) {
    it(`X402-01 explains a ${status}`, async () => {
      const target = await answer(status);
      try {
        const results = byId(await runX402ReadChecks({ target: target.url }));
        assert.equal(results["X402-01"]?.pass, false);
        assert.match(results["X402-01"]?.hint ?? "", pattern);
      } finally {
        await target.close();
      }
    });
  }

  it("X402-02 asks for the PAYMENT-REQUIRED header", async () => {
    const target = await answer(402, {}, "payment required");
    try {
      const results = byId(await runX402ReadChecks({ target: target.url }));
      assert.match(results["X402-02"]?.hint ?? "", /PAYMENT-REQUIRED response header/);
    } finally {
      await target.close();
    }
  });

  it("X402-02 moves a v1 body challenge to v2", async () => {
    const body = JSON.stringify({ x402Version: 1, accepts: [] });
    const target = await answer(402, { "content-type": "application/json" }, body);
    try {
      const results = byId(await runX402ReadChecks({ target: target.url }));
      assert.match(results["X402-02"]?.hint ?? "", /Move to x402 v2/);
    } finally {
      await target.close();
    }
  });

  it("X402-03 explains an undecodable header", async () => {
    const target = await answer(402, { "payment-required": "{not base64 json" });
    try {
      const results = byId(await runX402ReadChecks({ target: target.url }));
      assert.equal(results["X402-03"]?.pass, false);
      assert.match(results["X402-03"]?.hint ?? "", /Base64-encode the JSON PaymentRequired/);
    } finally {
      await target.close();
    }
  });

  it("a passing check carries no hint", async () => {
    const header = Buffer.from(JSON.stringify(v2(v2Option()))).toString("base64");
    const target = await answer(402, { "payment-required": header });
    try {
      for (const result of await runX402ReadChecks({ target: target.url })) {
        assert.equal(result.pass, true, result.id);
        assert.equal(result.hint, undefined, result.id);
      }
    } finally {
      await target.close();
    }
  });
});

describe("X402-06 and X402-07 hints", () => {
  it("asks for PAYMENT-RESPONSE when it is missing", () => {
    const read = readSettlementReference(200, () => {
      throw new Error("Payment response header not found");
    });
    assert.ok("failure" in read);
    assert.match(
      "hint" in read ? read.hint : "",
      /settle result base64-encoded in a PAYMENT-RESPONSE header/,
    );
  });

  it("asks for a successful settlement hash when the reference is not one", () => {
    const read = readSettlementReference(200, () => ({ success: false, transaction: "" }));
    assert.match("hint" in read ? read.hint : "", /success: true/);
  });

  it("tells a target that accepted a forged signature to verify", () => {
    const verdict = signatureRejectionVerdict(200);
    assert.equal(verdict.pass, false);
    assert.match(verdict.hint ?? "", /verify step/);
  });

  it("gives a correct rejection no hint", () => {
    const verdict = signatureRejectionVerdict(402);
    assert.equal(verdict.pass, true);
    assert.equal(verdict.hint, undefined);
  });
});

describe("fixFor", () => {
  it("prefers the result's own hint, and links the docs page", () => {
    const guidance = fixFor({ id: "X402-05", name: "n", pass: false, detail: "d", hint: "do this" });
    assert.deepEqual(guidance, { fix: "do this", docs: "https://usewasit.dev/docs/checks/x402" });
  });

  it("falls back to the catalogue fix, per protocol page", () => {
    const mpp = CHECK_CATALOGUE.find((entry) => entry.id === "MPP-11")!;
    assert.deepEqual(fixFor({ id: "MPP-11", name: "n", pass: false, detail: "d" }), {
      fix: mpp.fix,
      docs: "https://usewasit.dev/docs/checks/mpp-channel-mode",
    });
    assert.equal(
      fixFor({ id: "MPP-01", name: "n", pass: false, detail: "d" })?.docs,
      "https://usewasit.dev/docs/checks/mpp-charge-mode",
    );
  });

  // Enforces that every check can explain its own failure: there is no
  // catalogued check whose FAIL comes without something to act on.
  it("guides a failure of every catalogued check", () => {
    for (const entry of CHECK_CATALOGUE) {
      assert.ok(entry.fix.length > 0, entry.id);
      assert.ok(fixFor({ id: entry.id, name: entry.name, pass: false, detail: "d" }), entry.id);
    }
  });

  it("gives nothing for a pass, a skip or a no-verdict", () => {
    assert.equal(fixFor({ id: "X402-01", name: "n", pass: true, detail: "d", hint: "x" }), undefined);
    assert.equal(
      fixFor({ id: "X402-01", name: "n", pass: false, detail: "d", skipped: true, skipReason: "r" }),
      undefined,
    );
    assert.equal(
      fixFor({
        id: "X402-01",
        name: "n",
        pass: false,
        detail: "d",
        error: { kind: "unreachable", message: "m" },
      }),
      undefined,
    );
  });
});

describe("structured output carries the guidance", () => {
  it("adds fix and docs to a FAIL only", () => {
    const run = toStructuredRun([
      { id: "X402-01", name: "a", pass: true, detail: "ok" },
      { id: "X402-04", name: "b", pass: false, detail: "Missing: asset.", hint: "Add `asset`." },
    ]);
    assert.equal("fix" in run.results[0]!, false);
    assert.equal("docs" in run.results[0]!, false);
    assert.equal(run.results[1]!.fix, "Add `asset`.");
    assert.equal(run.results[1]!.docs, "https://usewasit.dev/docs/checks/x402");
  });
});
