/**
 * The coloured, live text output (Najmi, 2026-11-19), in Wasit's own look: a
 * header, two blocks of checks, each line with a mark and a badge that agree
 * (✓ PASS on green, ✗ FAIL on red, ○ SKIP on yellow, ! ERROR on magenta),
 * each check's duration, a spinner line saying what the check in flight is
 * doing, and the verdict, the counts and the run's duration at the end.
 *
 * What must not change: output a program reads. A pipe, CI, NO_COLOR and
 * --json get the plain text, byte for byte; a service's text is sanitised
 * before it is coloured, so the only escape sequences on screen are Wasit's own;
 * and the spinner line never wraps, since a wrapped line cannot be rewritten.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";
import { type CheckResult, errored, sanitizeText, skipped } from "@wasit-dev/core";

import { LiveReport } from "../../src/live.js";
import { report } from "../../src/output.js";
import { colorEnabled, liveEnabled, spread, styler, truncate, visibleLength, wrap } from "../../src/style.js";
import { startPaywall, type Paywall } from "./run-helpers.js";

const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const SECRET = "canary-secret-value-91c2";
const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const SGR = /\u001b\[[0-9;]*m/g;

const pass: CheckResult = { id: "X402-01", name: "402 Response Status", pass: true, detail: "Server responded with 402 as required." };
const fail: CheckResult = {
  id: "X402-08",
  name: "Payment Replay Rejected",
  pass: false,
  detail: `The same payment was accepted again (HTTP 200). ${SECRET}`,
};
const skip = skipped("X402-11", "Rejected Request Not Settled", "no request the service must refuse is configured.");
const error = errored("X402-06", "Signature Resubmit Accepted", new Error("Stellar simulation failed"));
const hostile: CheckResult = {
  id: "X402-04",
  name: "Required Fields Present",
  pass: false,
  detail: "bad \u001b]0;title\u0007 body \u001b[2J\u001b[31mred::set-output name=x::1",
};

/** A stream that records what is written, as a terminal of `columns` would get it. */
function terminal(columns = 80, isTTY = true) {
  const writes: string[] = [];
  return { stream: { isTTY, columns, write: (chunk: string) => writes.push(chunk) }, writes, text: () => writes.join("") };
}

const clean = (text: string) => sanitizeText(text, { redact: [SECRET] });
const plainText = (text: string) => text.replace(SGR, "");

describe("when colour is on", () => {
  it("is off for a pipe, NO_COLOR, CI, GitHub Actions and a dumb terminal; FORCE_COLOR turns it on", () => {
    assert.equal(colorEnabled({ isTTY: true }, {}), true);
    assert.equal(colorEnabled({ isTTY: false }, {}), false);
    assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: "1" }), false);
    assert.equal(colorEnabled({ isTTY: true }, { CI: "true" }), false);
    assert.equal(colorEnabled({ isTTY: true }, { GITHUB_ACTIONS: "true" }), false);
    assert.equal(colorEnabled({ isTTY: true }, { TERM: "dumb" }), false);
    assert.equal(colorEnabled({ isTTY: false }, { FORCE_COLOR: "1" }), true);
    assert.equal(colorEnabled({ isTTY: false }, { FORCE_COLOR: "0" }), false);
    assert.equal(colorEnabled({ isTTY: true }, { FORCE_COLOR: "1", NO_COLOR: "1" }), false, "NO_COLOR wins");
  });

  it("rewrites lines in place only on a real terminal, never in a pipe or CI, even with FORCE_COLOR", () => {
    assert.equal(liveEnabled({ isTTY: true }, {}), true);
    assert.equal(liveEnabled({ isTTY: false }, { FORCE_COLOR: "1" }), false);
    assert.equal(liveEnabled({ isTTY: true }, { FORCE_COLOR: "1", CI: "true" }), false);
  });
});

describe("the line layout", () => {
  it("puts the right part flush with the width, whatever the colours", () => {
    const style = styler(true);
    const line = spread(`   ${style.paint("✓", "success")} ${style.paint("X402-01", "bold")}  402 Response Status`, style.paint("8ms", "muted"), 79);
    assert.equal(visibleLength(line), 79);
  });

  it("wraps text under an indent and cuts a long line with an ellipsis", () => {
    const lines = wrap("one two three four five six seven eight nine ten eleven twelve", 30, "     ");
    assert.ok(lines.length > 1);
    for (const line of lines) assert.ok(line.startsWith("     ") && line.length <= 30, line);
    assert.equal(truncate("abcdefgh", 5), "abcd…");
  });
});

describe("LiveReport", () => {
  it("draws a spinner line saying what the check is doing, then replaces it with ✓, the check and its time", async () => {
    const t = terminal();
    let now = 1000;
    const live = new LiveReport({ stream: t.stream, live: true, clean, now: () => now, tickMs: 5 });
    live.running("X402-06", "Signature Resubmit Accepted");
    now = 1400;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const drawn = t.writes.filter((chunk) => SPINNER.test(chunk));
    assert.ok(drawn.length >= 2, "the spinner was not redrawn");
    assert.match(plainText(drawn.at(-1) ?? ""), /X402-06 {2}paying once, then reading the transfer on chain +400ms$/);
    now = 7820;
    live.result({ ...pass, id: "X402-06", name: "Signature Resubmit Accepted" });
    const text = t.text();
    assert.match(text, /\r\u001b\[2K/, "the spinner line was not cleared");
    assert.match(plainText(text), /✓ X402-06 {2}Signature Resubmit Accepted +6\.82s {2} PASS \n/);
  });

  it("never draws a spinner line wider than the terminal, so it never wraps", () => {
    for (const columns of [30, 50, 80, 200]) {
      const t = terminal(columns);
      const live = new LiveReport({ stream: t.stream, live: true, clean });
      live.running("X402-10", "Expired Authorization Rejected");
      live.result(pass);
      const spinnerLines = t.writes.filter((chunk) => chunk.startsWith("\r\u001b[2K") && SPINNER.test(chunk));
      assert.ok(spinnerLines.length >= 1, `${columns}: no spinner line`);
      for (const chunk of spinnerLines) {
        assert.ok(!chunk.includes("\n"), `${columns}: a spinner line holds a newline`);
        assert.ok(visibleLength(chunk.replace("\r\u001b[2K", "")) < columns, `${columns}: ${JSON.stringify(plainText(chunk))}`);
      }
    }
  });

  it("marks and badges each status alike: ✓ PASS, ✗ FAIL, ○ SKIP, ! ERROR", () => {
    const t = terminal();
    const live = new LiveReport({ stream: t.stream, live: true, clean });
    live.result(pass);
    live.result(fail);
    live.running("X402-11", "Rejected Request Not Settled");
    live.result(skip);
    live.result(error);
    const text = t.text();
    assert.match(text, /\u001b\[30;42m PASS /, "PASS in black on green");
    assert.match(text, /\u001b\[1;97;41m FAIL /, "FAIL in white on red");
    assert.match(text, /\u001b\[30;43m SKIP /, "SKIP in black on yellow");
    assert.match(text, /\u001b\[1;97;45m ERROR /, "ERROR in white on magenta");
    assert.match(text, /\u001b\[32m✓/);
    assert.match(text, /\u001b\[31m✗/);
    assert.match(text, /\u001b\[33m○/);
    assert.match(text, /\u001b\[95m!/);
    const plain = plainText(text);
    assert.match(plain, /✓ X402-01 {2}402 Response Status +PASS \n/);
    assert.match(plain, /✗ X402-08 {2}Payment Replay Rejected +FAIL \n/, "a FAIL is marked ✗, like its badge");
    assert.match(plain, /○ X402-11 {2}Rejected Request Not Settled +SKIP \n/, "a skipped check carries no time");
    assert.match(plain, /! X402-06 {2}Signature Resubmit Accepted +ERROR \n/, "a check that could not run: !");
    assert.ok(!/✓ X402-08/.test(plain), "a FAIL is never marked ✓");
    assert.match(plain, /\n {5}fix {2}/);
  });

  it("gives a skip's reason once when the skips that follow it have the same reason", () => {
    const t = terminal();
    const live = new LiveReport({ stream: t.stream, live: false, clean });
    const reason = "the target was never reached, so it issued no challenge to inspect.";
    for (const [id, name] of [["X402-02", "Payment Header Present"], ["X402-03", "Header Payload Decodable"], ["X402-04", "Required Fields Present"]]) {
      live.result(skipped(id!, name!, reason));
    }
    live.result(skipped("X402-05", "Network Identifier Valid", "another reason entirely."));
    const plain = plainText(t.text());
    assert.equal(plain.split("the target was never reached").length - 1, 1, plain);
    for (const id of ["X402-02", "X402-03", "X402-04", "X402-05"]) assert.match(plain, new RegExp(`○ ${id} `));
    assert.match(plain, /another reason entirely/);
  });

  it("uses the exact brand colours when the terminal shows 24-bit colour", () => {
    const t = terminal();
    const live = new LiveReport({ stream: t.stream, live: false, clean, truecolor: true });
    live.result(pass);
    assert.match(t.text(), /\u001b\[38;2;40;200;64m✓/, "the site's green, #28c840");
    assert.match(t.text(), /\u001b\[1;38;2;0;0;0;48;2;40;200;64m PASS /, "PASS in exact black on the site's green");
  });

  it("writes badge ink that stays black or white when bold: never a bold colour of the 16, which some terminals draw bright", () => {
    for (const depth of [16, 256, 24] as const) {
      const t = terminal();
      const live = new LiveReport({ stream: t.stream, live: false, clean, depth });
      for (const result of [pass, fail, skip, error]) live.result(result);
      live.finish([pass], "conformant", []);
      assert.ok(!/\u001b\[1;3[0-7];/.test(t.text()), `${depth}: a bold 16-colour ink`);
      assert.ok(!/\u001b\[1;30m|\u001b\[1;30;/.test(t.text()), `${depth}: bold black`);
    }
    const t = terminal();
    new LiveReport({ stream: t.stream, live: false, clean, depth: 256 }).result(pass);
    assert.match(t.text(), /\u001b\[1;38;5;16;48;5;41m PASS /, "256 colours: exact black on green");
  });

  it("ends with the verdict, the counts and the run's duration, and the notes of the plain output", () => {
    const t = terminal();
    let now = 0;
    const live = new LiveReport({ stream: t.stream, live: false, clean, now: () => now });
    now = 45_650;
    live.finish([pass, fail, skip, error], "non-conformant", ["No verdict: a note."]);
    const plain = plainText(t.text());
    assert.match(plain, / NOT CONFORMANT  {2}1 passed · 1 failed · 1 could not run · 1 skipped · 45\.65s/);
    assert.match(plain, /note {2}No verdict: a note\./);
    const ok = terminal();
    new LiveReport({ stream: ok.stream, live: false, clean }).finish([pass], "conformant", []);
    assert.match(plainText(ok.text()), / CONFORMANT  {2}1 passed · \d+ms/);
    assert.match(ok.text(), /\u001b\[30;42m CONFORMANT /);
    const narrow = terminal(40);
    new LiveReport({ stream: narrow.stream, live: false, clean }).finish([pass, fail, skip, error], "no-verdict", []);
    for (const line of plainText(narrow.text()).split("\n")) assert.ok(line.length < 40, `the closing line runs over: ${JSON.stringify(line)}`);
  });

  it("writes no cursor movement and no spinner when it is not live", () => {
    const t = terminal(80, false);
    const live = new LiveReport({ stream: t.stream, live: false, clean });
    live.running("X402-06", "Signature Resubmit Accepted");
    live.progress("reading the chain");
    live.result(pass);
    assert.ok(!t.text().includes("\u001b[2K"));
    assert.ok(!SPINNER.test(t.text()));
  });

  it("sanitises a service's text before colouring it: Wasit's own colour codes are the only escapes, and no secret", () => {
    const t = terminal();
    const live = new LiveReport({ stream: t.stream, live: true, clean, truecolor: true });
    live.running("X402-04", "Required Fields Present");
    live.progress(`progress ${SECRET} \u001b]8;;http://x\u0007`);
    live.result(hostile);
    live.result(fail);
    const text = t.text();
    assert.ok(!text.includes("\u0007"), "a BEL reached the terminal");
    // The sanitiser drops the escape characters; a printable leftover such as "]0;title" is plain text.
    assert.ok(!text.includes("\u001b]"), "an OSC sequence reached the terminal");
    assert.ok(!text.includes("\u001b[2J"), "a screen clear reached the terminal");
    for (const sequence of text.match(/\u001b[^a-zA-Z]*[a-zA-Z]/g) ?? []) {
      assert.match(sequence, /^\u001b\[[0-9;]*[mK]$/, JSON.stringify(sequence));
    }
    assert.ok(!text.includes(SECRET), "a secret reached the terminal");
    for (const line of plainText(text).replace(/\r\u001b\[2K/g, "").split("\n")) assert.ok(!/^\s*(::|##\[)/.test(line), line);
  });
});

describe("report, with colours", () => {
  function render(style?: ReturnType<typeof styler>) {
    const lines: string[] = [];
    const code = report([pass, fail, skip], false, { emit: (line) => lines.push(line), secrets: [SECRET], ...(style ? { style } : {}) });
    return { code, text: lines.join("\n") };
  }

  it("is the plain text, unchanged, when colour is off", () => {
    assert.deepEqual(render(styler(false)), render());
    assert.match(render().text, /^PASS {2}X402-01 {2}402 Response Status$/m);
  });

  it("marks the same checks, and keeps the exit code", () => {
    const plain = render();
    const coloured = render(styler(true));
    assert.equal(coloured.code, plain.code);
    assert.match(plainText(coloured.text), /✗ X402-08 {2}Payment Replay Rejected +FAIL /);
    assert.ok(!coloured.text.includes(SECRET));
  });
});

describe("wasit test, as the built binary", () => {
  let paywall: Paywall;
  let cwd: string;
  before(async () => {
    paywall = await startPaywall();
    cwd = await mkdtemp(path.join(tmpdir(), "wasit-live-"));
  });
  after(async () => {
    await paywall.close();
    await rm(cwd, { recursive: true, force: true });
  });

  function wasit(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env["PATH"] ?? "", HOME: cwd, ...env } });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (out += chunk));
      child.on("close", (code) => resolve({ code, out }));
    });
  }

  const read = () => ["test", "--target", `${paywall.base}/paid`, "--read-only"];

  it("is in Wasit's look with FORCE_COLOR: header, blocks, marks, verdict and duration; same exit code; no cursor movement", async () => {
    const plain = await wasit(read(), { NO_COLOR: "1" });
    const coloured = await wasit(read(), { FORCE_COLOR: "1" });
    assert.equal(coloured.code, plain.code);
    const text = plainText(coloured.out);
    assert.match(text, /◆ wasit 0\.8\.0-beta\.1 · x402 conformance/);
    assert.match(text, /^ challenge · no payment$/m);
    assert.match(text, /✓ X402-01 {2}402 Response Status .*PASS /);
    assert.match(text, / CONFORMANT  {2}5 passed · \d/);
    assert.match(coloured.out, /\u001b\[32m✓/);
    assert.match(coloured.out, /\u001b\[30;42m PASS /);
    const term256 = await wasit(read(), { FORCE_COLOR: "1", TERM: "xterm-256color" });
    assert.match(term256.out, /\u001b\[1;38;5;16;48;5;41m PASS /);
    assert.ok(!coloured.out.includes("\u001b[2K"), "a pipe got cursor movement");
    const truecolor = await wasit(read(), { FORCE_COLOR: "1", COLORTERM: "truecolor" });
    assert.match(truecolor.out, /\u001b\[38;2;40;200;64m✓/);
  });

  it("is the plain text with NO_COLOR, in CI, and in a pipe", async () => {
    const envs: Array<Record<string, string>> = [{ NO_COLOR: "1", FORCE_COLOR: "1" }, { CI: "true" }, {}];
    for (const env of envs) {
      const result = await wasit(read(), env);
      assert.ok(!result.out.includes("\u001b["), JSON.stringify(env));
      assert.match(result.out, /^PASS {2}X402-01 {2}402 Response Status$/m, JSON.stringify(env));
      assert.match(result.out, /^5 passed\.$/m, JSON.stringify(env));
    }
  });

  it("on a network that is not a test network, says the payment checks are refused, not that funds move", async () => {
    const result = await wasit(["test", "--target", `${paywall.base}/paid`, "--network", "stellar:pubnet"], {
      FORCE_COLOR: "1",
      STELLAR_PRIVATE_KEY: Keypair.random().secret(),
    });
    const text = plainText(result.out);
    assert.match(text, /^ payment · stellar:pubnet · not a test network: refused$/m);
    assert.ok(!/funds move|settles a real payment/.test(text), "a mainnet run was told that money moves");
    assert.match(text, /! PREFLIGHT .*ERROR /);
    assert.match(text, /Nothing\s+was\s+sent\s+and\s+nothing\s+was\s+signed\./);
  });

  it("keeps --json plain JSON, even with FORCE_COLOR", async () => {
    const result = await wasit([...read(), "--json"], { FORCE_COLOR: "1" });
    assert.ok(!result.out.includes("\u001b["));
    const start = result.out.indexOf("{");
    assert.doesNotThrow(() => JSON.parse(result.out.slice(start)));
  });
});
