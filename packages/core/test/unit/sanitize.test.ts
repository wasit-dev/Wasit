/**
 * The one sanitiser (spec A8 #6, A4, attack finding A-A07).
 *
 * What a service answers is data. These tests feed the sanitiser the things a
 * hostile 402 body could carry and hold it to: no control character reaches a
 * terminal, no `::` starts a line in a job log, nothing in a comment can mention
 * a user, link out, break the table or inject HTML, and a secret-shaped value
 * never survives.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MARKDOWN_VALUE_MAX, sanitizeForMarkdown, sanitizeText } from "../../src/sanitize.js";

/** A Stellar secret-shaped value built here, so no real key is ever in the repository. */
const FAKE_SECRET = `S${"A".repeat(55)}`;

/** The body of a hostile 402 response: Markdown, HTML, a mention, `::`, control characters. */
const HOSTILE_BODY = [
  "::error file=app.js,line=1::pwned",
  "  ::set-output name=x::y",
  "##[error]fake",
  "# Heading injected",
  "- list item",
  "[click me](https://evil.example/phish)",
  "![tracker](http://evil.example/pixel.png)",
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<!-- wasit-report -->",
  "ping @octocat and @some-org/team, mail a@b.example",
  "see https://evil.example/a?b=c and www.evil.example and #123 and other/repo#7",
  "red \u001b[31mtext\u001b[0m bell\u0007 nul\u0000 csi\u009b del\u007f",
  "| col | col |",
  "`code` *bold* _it_ ~~strike~~",
].join("\n");

describe("sanitizeText (terminal, job log, report text)", () => {
  it("strips C0 control characters except newline and tab", () => {
    assert.equal(sanitizeText("a\u0000b\u0007c\u001bd\u000be\u000cf\rg"), "abcdefg");
    assert.equal(sanitizeText("line1\nline2\tcol"), "line1\nline2\tcol");
  });

  it("strips C1 control characters and DEL", () => {
    for (let code = 0x80; code <= 0x9f; code += 1) {
      assert.equal(sanitizeText(`a${String.fromCharCode(code)}b`), "ab", `U+${code.toString(16)}`);
    }
    assert.equal(sanitizeText("a\u007fb"), "ab");
  });

  it("turns an escape sequence into inert text", () => {
    assert.equal(sanitizeText("\u001b[2J\u001b[31mred"), "[2J[31mred");
  });

  it("strips bidirectional override characters", () => {
    assert.equal(sanitizeText("a\u202eb\u202ac\u2066d\u2069e"), "abcde");
  });

  it("keeps ordinary text, accents, CJK and emoji", () => {
    const text = "Réponse 402: 価格 10000 😀\nnext line";
    assert.equal(sanitizeText(text), text);
  });

  it("breaks a leading `::` on every line, also after whitespace or a stripped control character", () => {
    assert.equal(sanitizeText("::error::x"), ": :error::x");
    assert.equal(sanitizeText("ok\n::warning::x\nok"), "ok\n: :warning::x\nok");
    assert.equal(sanitizeText("  ::notice::x"), "  : :notice::x");
    assert.equal(sanitizeText("\t::notice::x"), "\t: :notice::x");
    assert.equal(sanitizeText("\u0000::error::x"), ": :error::x");
    assert.equal(sanitizeText("::stop-commands::token"), ": :stop-commands::token");
    // Not at the start of a line: nothing to break.
    assert.equal(sanitizeText("a ::b"), "a ::b");
  });

  it("breaks it after any Unicode whitespace a runner may trim before it", () => {
    for (const space of ["\u00a0", "\u3000", "\u2003", "\u1680", "\ufeff", " \t \u00a0"]) {
      assert.equal(sanitizeText(`${space}::error::x`), `${space}: :error::x`, JSON.stringify(space));
    }
  });

  it("breaks a leading `##[` as well (defensive, the older command form)", () => {
    assert.equal(sanitizeText("##[error]x"), "# #[error]x");
    assert.equal(sanitizeText("a ##[b"), "a ##[b");
  });

  it("leaves no line of a hostile body that a runner would read as a command", () => {
    const out = sanitizeText(HOSTILE_BODY);
    for (const line of out.split("\n")) {
      assert.equal(/^\s*(::|##\[)/.test(line), false, JSON.stringify(line));
    }
    assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(out), false);
  });

  it("is idempotent", () => {
    for (const input of [HOSTILE_BODY, "::a::b\n::c", "plain", "", "\u0000::\u0000::"]) {
      const once = sanitizeText(input);
      assert.equal(sanitizeText(once), once, JSON.stringify(input));
    }
  });

  it("masks a Stellar-secret-shaped value, also inside a longer word and across a stripped control", () => {
    assert.equal(sanitizeText(`key ${FAKE_SECRET} end`).includes(FAKE_SECRET), false);
    assert.equal(sanitizeText(`x${FAKE_SECRET}y`).includes(FAKE_SECRET), false);
    assert.equal(sanitizeText(`${FAKE_SECRET.slice(0, 20)}\u0000${FAKE_SECRET.slice(20)}`).includes(FAKE_SECRET), false);
    assert.match(sanitizeText(`key ${FAKE_SECRET}`), /\[redacted\]/);
  });

  it("does not mask a public key, a contract address or a 64-hex transaction hash", () => {
    const publicKey = `G${"B".repeat(55)}`;
    const contract = `C${"C".repeat(55)}`;
    const hash = "ab".repeat(32);
    const text = `${publicKey} ${contract} ${hash}`;
    assert.equal(sanitizeText(text), text);
  });

  it("redacts each given secret literal, also one that a control character was hiding", () => {
    const secret = "s3cr3t-header-value";
    assert.equal(sanitizeText(`got ${secret} back`, { redact: [secret] }), "got [redacted] back");
    assert.equal(sanitizeText("got s3cr3t-\u0000header-value back", { redact: [secret] }), "got [redacted] back");
    assert.equal(sanitizeText(`${secret} and ${secret}`, { redact: [secret] }), "[redacted] and [redacted]");
  });

  it("ignores an empty or very short redact entry rather than blanking the text", () => {
    assert.equal(sanitizeText("hello abc", { redact: ["", "l", "abc"] }), "hello abc");
  });

  it("treats a redact entry as a literal, not a pattern", () => {
    assert.equal(sanitizeText("x a.*b y axxb", { redact: ["a.*b"] }), "x [redacted] y axxb");
  });
});

describe("sanitizeForMarkdown (comment and job summary)", () => {
  const out = sanitizeForMarkdown(HOSTILE_BODY, { maxLength: 100_000 });

  it("emits one line: no newline can start a heading, list, quote or table row", () => {
    assert.equal(out.includes("\n"), false);
    assert.equal(out.includes("\r"), false);
  });

  it("leaves no raw HTML: no angle bracket, and the comment marker is inert", () => {
    assert.equal(/[<>]/.test(out), false);
    assert.equal(out.includes("<!--"), false);
    assert.match(out, /&lt;script&gt;/);
  });

  it("leaves no clickable link: URLs and issue references are removed, brackets and parentheses escaped", () => {
    assert.equal(/https?:\/\//.test(out), false);
    assert.equal(out.includes("evil.example"), false);
    assert.equal(out.includes("www."), false);
    assert.equal(/#\d/.test(out), false);
    // Every bracket and parenthesis is escaped, so no [text](target) can form.
    assert.equal(/(^|[^\\])[[\]()]/.test(out), false);
    assert.match(out, /\\\[link removed\\\]/);
  });

  it("leaves no mention", () => {
    assert.equal(/@[A-Za-z0-9_]/.test(out), false);
    assert.match(out, /\\\[at\\\]octocat/);
  });

  it("escapes the Markdown that could still format a cell", () => {
    assert.equal(/(^|[^\\])[`*_~|]/.test(out), false);
    assert.equal(/^[#>+=-]/.test(out), false);
  });

  it("has no control characters and no line a runner would read as a command", () => {
    assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(out), false);
    assert.equal(out.startsWith("::"), false);
  });

  it("escapes a value that starts like a heading, a list item or a numbered list", () => {
    assert.equal(sanitizeForMarkdown("# title"), "\\# title");
    assert.equal(sanitizeForMarkdown("- item"), "\\- item");
    assert.equal(sanitizeForMarkdown("+ item"), "\\+ item");
    assert.equal(sanitizeForMarkdown("1. item"), "1\\. item");
    assert.equal(sanitizeForMarkdown("> quote"), "&gt; quote");
  });

  it("keeps ordinary prose readable", () => {
    assert.equal(sanitizeForMarkdown("Expected status 402, got 200."), "Expected status 402, got 200.");
    assert.equal(sanitizeForMarkdown("accepts[0]: Missing: payTo."), "accepts\\[0\\]: Missing: payTo.");
  });

  it("removes links of any scheme with an authority, and www hosts", () => {
    for (const link of ["http://a.example/x", "https://a.example", "ftp://a.example/x", "javascript://x/%0aalert(1)", "www.a.example/x", "HTTPS://A.EXAMPLE"]) {
      const result = sanitizeForMarkdown(`see ${link} now`);
      assert.match(result, /see \\?\[link removed\\?\] now/, link);
    }
  });

  it("truncates to 300 characters by default, ellipsis included, before escaping", () => {
    assert.equal(MARKDOWN_VALUE_MAX, 300);
    const long = sanitizeForMarkdown("a".repeat(1000));
    assert.equal([...long].length, 300);
    assert.equal(long.endsWith("…"), true);
    assert.equal(sanitizeForMarkdown("a".repeat(300)), "a".repeat(300));
  });

  it("honours another limit and never cuts a character in half", () => {
    const emoji = sanitizeForMarkdown("😀".repeat(500));
    assert.equal([...emoji].length, 300);
    // encodeURIComponent throws on a lone surrogate, so this fails on a character cut in half.
    assert.doesNotThrow(() => encodeURIComponent(emoji));
    assert.equal([...sanitizeForMarkdown("abcdefghij", { maxLength: 5 })].length, 5);
  });

  it("hides a secret that straddles the cut: values are masked before the cut, never after (review of S1)", () => {
    // 295 characters, then a secret that would be cut after "cana" if the cut came first.
    const text = `${"x".repeat(295)}canary-header-value tail`;
    const result = sanitizeForMarkdown(text, { redact: ["canary-header-value"] });
    assert.equal(result.includes("cana"), false, "no start of the secret is left");
    // The cut is the value's length before escaping (the limit is held by the tests above), so only the secret is asserted here.
  });

  it("does not let truncation expose half a link or a half escape", () => {
    const text = `${"x".repeat(285)} https://evil.example/aaaaaaaaaaaa`;
    const result = sanitizeForMarkdown(text);
    assert.equal(result.includes("evil"), false);
    assert.equal(/\\$/.test(result), false);
  });

  it("masks a secret-shaped value and a given secret literal", () => {
    const result = sanitizeForMarkdown(`${FAKE_SECRET} and hush-hush-value`, { redact: ["hush-hush-value"] });
    assert.equal(result.includes(FAKE_SECRET), false);
    assert.equal(result.includes("hush-hush-value"), false);
  });

  it("returns the empty string for empty input", () => {
    assert.equal(sanitizeForMarkdown(""), "");
    assert.equal(sanitizeForMarkdown("\u0000\u0001"), "");
  });
});
