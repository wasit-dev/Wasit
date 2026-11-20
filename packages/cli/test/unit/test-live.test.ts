/**
 * `wasit test` drawn live, for a person at a terminal (`liveX402Test`), driven
 * with a stream, an environment and stand-in checks.
 *
 * What it is held to: every text a service
 * chose reaches the screen only through the sanitiser, so the only escape
 * sequences are Wasit's own colours; no secret of the environment is printed;
 * and no line starts with a GitHub workflow command, also where the output is
 * wrapped in the middle of a service's text (colour is on in CI with
 * FORCE_COLOR).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";
import type { CheckResult, runX402PaymentChecks, runX402ReadChecks } from "@wasit-dev/core";

import { liveX402Test } from "../../src/test-live.js";

const SGR = /\u001b\[[0-9;]*m/g;

/** A stream that keeps what is written; not a TTY, 80 columns. */
function stream(): { isTTY: boolean; columns: number; text: string; write(chunk: string): boolean } {
  return {
    isTTY: false,
    columns: 80,
    text: "",
    write(chunk: string) {
      this.text += chunk;
      return true;
    },
  };
}

type ReadChecks = typeof runX402ReadChecks;
type PaymentChecks = typeof runX402PaymentChecks;

/** Stand-in checks that report `results` through `onResult`, as the real ones do. */
function emitting(results: CheckResult[]): ReadChecks & PaymentChecks {
  return (async (options: { onResult?: (result: CheckResult) => void }) => {
    for (const result of results) options.onResult?.(result);
    return [...results];
  }) as unknown as ReadChecks & PaymentChecks;
}

/** The lines as the runner reads them: colours out, the indent trimmed. */
function runnerLines(text: string): string[] {
  return text.split("\n").map((line) => line.replace(SGR, "").trimStart());
}

describe("wasit test, live (liveX402Test)", () => {
  const payerKey = Keypair.random().secret();
  const headerSecret = "header-secret-value-5f1e";
  const env = { STELLAR_PRIVATE_KEY: payerKey, WASIT_HEADER_X_API_KEY: headerSecret };

  // Text a service chose, with escape sequences, a bell, both secrets, and a
  // workflow command placed at every point where a line may wrap.
  const hostile = (n: number): string =>
    `\u001b]0;title\u0007\u001b[2J\u001b[31mred ${headerSecret} ${payerKey} ${"w ".repeat(n).trim()} ::add-mask::visible ##[group]planted`;
  const readResults: CheckResult[] = [
    { id: "X402-01", name: "402 Response Status\u001b[2Kx", pass: true, detail: hostile(1) },
  ];
  const paymentResults: CheckResult[] = Array.from({ length: 40 }, (_, n) => ({
    id: "X402-06",
    name: "Signature Resubmit Accepted",
    pass: false,
    detail: hostile(n + 1),
    hint: hostile(n + 2),
  }));

  async function run(opts: Record<string, unknown>): Promise<{ text: string; code: number; paid: boolean }> {
    const out = stream();
    let paid = false;
    const payment = emitting(paymentResults);
    const code = await liveX402Test(
      { network: "stellar:testnet", target: "http://127.0.0.1:9/paid\u001b[2J\u0007", ...opts },
      { method: "post" },
      {
        stream: out,
        env,
        readChecks: emitting(readResults),
        paymentChecks: ((options: Parameters<PaymentChecks>[0]) => {
          paid = true;
          return payment(options);
        }) as PaymentChecks,
      },
    );
    return { text: out.text, code, paid };
  }

  it("prints only Wasit's own colour codes: the target, a check's name and every detail and fix are sanitised", async () => {
    const { text, paid } = await run({});
    assert.equal(paid, true, "the payment checks ran");
    assert.ok(text.includes("\u001b["), "the output is coloured");
    assert.ok(!text.replace(SGR, "").includes("\u001b"), "an escape sequence that is not a colour reached the output");
    assert.ok(!text.includes("\u0007"), "a bell reached the output");
  });

  it("prints no secret of the environment", async () => {
    const { text } = await run({});
    assert.ok(!text.includes(payerKey), "the payer key was printed");
    assert.ok(!text.includes(headerSecret), "a header value was printed");
    assert.match(text, /\[redacted\]/);
  });

  it("starts no line with a workflow command, where the output wraps in the middle of a service's text too", async () => {
    const { text } = await run({});
    assert.ok(text.includes("::add-mask::visible"), "the probe text is in the output, in the middle of a line or broken");
    for (const line of runnerLines(text)) {
      assert.ok(!line.startsWith("::") && !line.startsWith("##["), `a line starts with a workflow command: ${JSON.stringify(line)}`);
    }
  });

  it("keeps the exit code of the plain output, and runs no payment check with --read-only", async () => {
    assert.equal((await run({})).code, 1);
    const readOnly = await run({ readOnly: true });
    assert.equal(readOnly.paid, false);
    assert.match(readOnly.text, /--read-only set: the payment checks were not run\./);
  });
});
