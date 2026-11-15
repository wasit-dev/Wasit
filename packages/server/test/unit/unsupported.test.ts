/**
 * "Unsupported" seen from the MCP server (spec A3): an x402 v1 challenge is not
 * a FAIL, and the structured output says why each check was skipped.
 *
 * Starts the built server (`npm run build` first) through the SDK's own stdio
 * client, with an empty temporary directory as working directory and HOME. No
 * key is set; nothing leaves 127.0.0.1.
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

const SERVER = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

interface Structured {
  readonly outcome: string;
  readonly failed: number;
  readonly results: Array<{ id: string; status: string; skipKind?: string }>;
}

describe("the MCP server and an x402 v1 challenge", () => {
  let cwd: string;
  let server: http.Server;
  let url: string;

  before(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "wasit-unsupported-mcp-"));
    server = http.createServer((_request, response) => {
      response.writeHead(402, { "content-type": "application/json" });
      response.end(JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "stellar:testnet" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/paid`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(cwd, { recursive: true, force: true });
  });

  it("wasit_x402_test reports X402-02..05 as skipped with skipKind unsupported, and no FAIL", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd, env: { HOME: cwd }, stderr: "pipe" });
    const client = new Client({ name: "wasit-unsupported-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "wasit_x402_test", arguments: { target: url, readOnly: true } });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      const structured = result.structuredContent as Structured;
      assert.equal(structured.failed, 0);
      assert.equal(structured.results[0]?.id, "X402-01");
      assert.equal(structured.results[0]?.status, "PASS");
      for (const check of structured.results.slice(1)) {
        assert.equal(check.status, "SKIP", check.id);
        assert.equal(check.skipKind, "unsupported", check.id);
      }
    } finally {
      await client.close();
    }
  });
});
