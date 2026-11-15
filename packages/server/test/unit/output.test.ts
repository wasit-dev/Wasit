/**
 * What the MCP server hands an agent (spec A8 #6, A8 #3). Text a service sent
 * reaches the agent through the check details, so both channels go through the
 * one sanitiser; and a service that was never graded is `no-verdict`, never
 * `conformant`, for an agent as for a shell.
 *
 * Starts the built server (`npm run build` first) through the SDK's own stdio
 * client, with an empty temporary directory as working directory and HOME. No
 * key is set; nothing leaves 127.0.0.1. The environment holds one made-up
 * header value, to see that it never comes back.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runX402ReadChecks } from "@wasit-dev/core";

const SERVER = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

interface Structured {
  readonly outcome: string;
  readonly results: Array<{ id: string; status: string; detail: string; expected?: string; actual?: string; fix?: string }>;
}

async function callTool(cwd: string, url: string, env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd,
    env: { HOME: cwd, ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "wasit-output-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "wasit_x402_test", arguments: { target: url, readOnly: true } });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const content = result.content as Array<{ type: string; text: string }>;
    return { text: content.map((part) => part.text).join("\n"), structured: result.structuredContent as Structured };
  } finally {
    await client.close();
  }
}

/** Starts a service on loopback; `headers` and `body` are what it answers 402 with. */
async function service(headers: Record<string, string>, body: string) {
  const server = http.createServer((_request, response) => {
    response.writeHead(402, { "content-type": "application/json", ...headers });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/paid`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("the MCP server and text a service sent", () => {
  let cwd: string;
  before(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "wasit-output-mcp-"));
  });
  after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("strips control characters and breaks a leading :: in both channels", async () => {
    const hostile = Buffer.from("\u001b[2J\n::set-output name=pwn::1\nnot json").toString("base64");
    const target = await service({ "PAYMENT-REQUIRED": hostile }, "{}");
    try {
      // The precondition: the raw detail really does carry both, so the test proves the sanitiser.
      const raw = (await runX402ReadChecks({ target: target.url })).map((result) => result.detail).join("\n");
      assert.ok(raw.includes("\u001b"), "the raw detail carries an escape character");
      assert.ok(/^::/m.test(raw), "the raw detail has a line that starts with ::");

      const { text, structured } = await callTool(cwd, target.url);
      assert.match(text, /X402-03/);
      assert.ok(!CONTROL.test(text.replace(/\n/g, "")), "no control character in the text channel");
      assert.ok(!/^\s*(::|##\[)/m.test(text), "no line starts a workflow command in the text channel");
      const details = structured.results.map((result) => result.detail).join("\n");
      assert.ok(!CONTROL.test(details.replace(/\n/g, "")), "no control character in the structured channel");
      assert.ok(!/^\s*(::|##\[)/m.test(details), "no line starts a workflow command in the structured channel");
    } finally {
      await target.close();
    }
  });

  it("never returns a header value held in the server's own environment, even when the service echoes it", async () => {
    const canary = "canary-header-value-7f3a";
    // X402-05 quotes the network the service advertised, so the service can send a value back.
    const echoed = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: canary, amount: "1", asset: "a", payTo: "b", maxTimeoutSeconds: 60 }],
      }),
    ).toString("base64");
    const target = await service({ "PAYMENT-REQUIRED": echoed }, "{}");
    try {
      const raw = (await runX402ReadChecks({ target: target.url })).map((result) => result.detail).join("\n");
      assert.ok(raw.includes(canary), "the raw detail quotes the value the service sent");
      const { text, structured } = await callTool(cwd, target.url, { WASIT_HEADER_X_API_KEY: canary });
      assert.ok(!text.includes(canary));
      assert.ok(!JSON.stringify(structured).includes(canary));
    } finally {
      await target.close();
    }
  });
});

describe("the MCP server and the expected and actual value of a FAIL", () => {
  let cwd: string;
  before(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "wasit-output-mcp-ea-"));
  });
  after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("returns both in the structured channel next to the old fields, which are unchanged", async () => {
    // A service that does not answer 402 at all.
    const free = http.createServer((_request, response) => {
      response.writeHead(200);
      response.end("free");
    });
    await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(free.address() as { port: number }).port}/paid`;
    try {
      const { structured } = await callTool(cwd, url);
      const first = structured.results[0]!;
      assert.equal(first.id, "X402-01");
      assert.equal(first.status, "FAIL");
      assert.equal(first.expected, "status 402");
      assert.equal(first.actual, "status 200");
      assert.equal(first.detail, "Expected status 402, got 200.", "detail is unchanged");
      assert.ok(typeof first.fix === "string" && first.fix.length > 0, "fix is unchanged");
    } finally {
      free.closeAllConnections();
      await new Promise<void>((resolve) => free.close(() => resolve()));
    }
  });
});

describe("the MCP server and an x402 v1 challenge", () => {
  let cwd: string;
  before(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "wasit-output-mcp-v1-"));
  });
  after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("says no-verdict, not conformant: a service that was never graded", async () => {
    const target = await service({}, JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "stellar:testnet" }] }));
    try {
      const { text, structured } = await callTool(cwd, target.url);
      assert.equal(structured.outcome, "no-verdict");
      assert.equal(structured.results[0]?.status, "PASS");
      assert.match(text, /No verdict: Wasit could not grade this service/, "the prose channel says it too");
    } finally {
      await target.close();
    }
  });
});
