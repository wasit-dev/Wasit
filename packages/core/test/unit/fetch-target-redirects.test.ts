/**
 * The redirect rule for the read-only tier (spec A8 #5, attack finding A-A06).
 *
 * `fetch` follows a redirect to any host. Without a rule, a route that redirects
 * to another origin would draw Wasit's request there: Wasit would probe a host
 * the builder never declared as theirs (rule 7). The rule: a redirect to another
 * origin is reported and gives no verdict, and a redirect inside the declared
 * origin is followed once.
 *
 * Servers here are in-process and listen on loopback; nothing leaves the machine.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";

import { ConfigurationError, RedirectRefusedError, classifyCheckError, fetchTarget } from "../../src/errors.js";
import { runX402ReadChecks } from "../../src/x402/simulator.js";

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly headers: http.IncomingHttpHeaders;
}

interface Site {
  readonly origin: string;
  readonly seen: Seen[];
  readonly close: () => Promise<void>;
}

const open: Site[] = [];

/** Starts a loopback server; `handle` answers each request and the site records what it got. */
async function site(handle: (request: http.IncomingMessage, response: http.ServerResponse, origin: string) => void): Promise<Site> {
  const seen: Seen[] = [];
  let origin = "";
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body: Buffer.concat(chunks).toString("utf-8"),
        headers: request.headers,
      });
      handle(request, response, origin);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const created: Site = {
    origin,
    seen,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
  open.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((created) => created.close()));
});

const SAME_ORIGIN = { redirects: "same-origin" } as const;

async function refusal(promise: Promise<unknown>): Promise<RedirectRefusedError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RedirectRefusedError, `expected a RedirectRefusedError, got ${String(error)}`);
    return error;
  }
  return assert.fail("expected the redirect to be refused");
}

describe("fetchTarget with redirects: same-origin", () => {
  it("returns a response that is not a redirect, untouched", async () => {
    const a = await site((_request, response) => { response.writeHead(402); response.end("pay"); });
    const response = await fetchTarget(`${a.origin}/paid`, undefined, SAME_ORIGIN);
    assert.equal(response.status, 402);
    assert.equal(await response.text(), "pay");
  });

  it("follows a redirect inside the origin, once", async () => {
    const a = await site((request, response) => {
      if (request.url === "/old") { response.writeHead(302, { location: "/new" }); response.end(); return; }
      response.writeHead(402); response.end("pay");
    });
    const response = await fetchTarget(`${a.origin}/old`, undefined, SAME_ORIGIN);
    assert.equal(response.status, 402);
    assert.deepEqual(a.seen.map((s) => s.path), ["/old", "/new"]);
  });

  it("follows an absolute Location that keeps the origin", async () => {
    const a = await site((request, response, origin) => {
      if (request.url === "/old") { response.writeHead(301, { location: `${origin}/new?x=1` }); response.end(); return; }
      response.writeHead(402); response.end();
    });
    const response = await fetchTarget(`${a.origin}/old`, undefined, SAME_ORIGIN);
    assert.equal(response.status, 402);
    assert.deepEqual(a.seen.map((s) => s.path), ["/old", "/new?x=1"]);
  });

  it("refuses the second redirect: one is followed, not a chain", async () => {
    const a = await site((request, response) => {
      const next: Record<string, string> = { "/a": "/b", "/b": "/c" };
      const to = next[request.url ?? ""];
      if (to) { response.writeHead(302, { location: to }); response.end(); return; }
      response.writeHead(402); response.end();
    });
    const error = await refusal(fetchTarget(`${a.origin}/a`, undefined, SAME_ORIGIN));
    assert.match(error.message, /more than one redirect/);
    assert.deepEqual(a.seen.map((s) => s.path), ["/a", "/b"]);
  });

  it("refuses a redirect to another origin, reports it, and never connects there", async () => {
    const b = await site((_request, response) => { response.writeHead(402); response.end("elsewhere"); });
    const a = await site((_request, response) => { response.writeHead(302, { location: `${b.origin}/x?token=hunter2#frag` }); response.end(); });
    const error = await refusal(fetchTarget(`${a.origin}/paid`, undefined, SAME_ORIGIN));
    assert.match(error.message, new RegExp(`redirects to ${b.origin.replace(/\./g, "\\.")}`));
    assert.match(error.message, /did not follow/);
    // Only the origin is named: not the path, the query or the fragment.
    assert.equal(error.message.includes("hunter2"), false);
    assert.equal(error.message.includes("/x"), false);
    assert.equal(b.seen.length, 0, "a request reached the other origin");
  });

  it("treats a different port, host name, scheme or userinfo as another origin", async () => {
    const a = await site((request, response, origin) => {
      const port = origin.split(":")[2];
      const targets: Record<string, string> = {
        "/host": `http://localhost:${port}/x`,
        "/scheme": `https://127.0.0.1:${port}/x`,
        "/port": `http://127.0.0.1:1/x`,
        "/userinfo": `http://user:pass@127.0.0.1:${port}/x`,
        "/mixed-case": `HTTP://127.0.0.1:${port}/ok`,
      };
      if (request.url === "/ok") { response.writeHead(402); response.end(); return; }
      response.writeHead(302, { location: targets[request.url ?? ""] ?? "/ok" });
      response.end();
    });
    for (const path of ["/host", "/scheme", "/port"]) {
      await refusal(fetchTarget(`${a.origin}${path}`, undefined, SAME_ORIGIN));
    }
    // userinfo does not change the origin, but a request is never sent to a Location that carries credentials.
    const error = await refusal(fetchTarget(`${a.origin}/userinfo`, undefined, SAME_ORIGIN));
    assert.equal(error.message.includes("pass"), false);
    // The scheme and host are case-insensitive: the same origin is followed.
    assert.equal((await fetchTarget(`${a.origin}/mixed-case`, undefined, SAME_ORIGIN)).status, 402);
  });

  it("refuses a Location that is not an http(s) URL, or not a URL at all", async () => {
    const a = await site((request, response) => {
      const locations: Record<string, string> = {
        "/file": "file:///etc/passwd",
        "/js": "javascript:alert(1)",
        "/ftp": "ftp://127.0.0.1/x",
        "/data": "data:text/plain,hello",
        "/broken": "http://",
        "/empty-host": "http:///x",
      };
      response.writeHead(302, { location: locations[request.url ?? ""] ?? "/" });
      response.end();
    });
    for (const path of ["/file", "/js", "/ftp", "/data", "/broken", "/empty-host"]) {
      const error = await refusal(fetchTarget(`${a.origin}${path}`, undefined, SAME_ORIGIN));
      assert.equal(error.message.includes("passwd"), false, path);
      assert.equal(error.message.includes("alert"), false, path);
    }
    assert.equal(a.seen.length, 6);
  });

  it("returns a 3xx without a Location as it is, so the check can report the status", async () => {
    const a = await site((_request, response) => { response.writeHead(302); response.end(); });
    const response = await fetchTarget(`${a.origin}/x`, undefined, SAME_ORIGIN);
    assert.equal(response.status, 302);
  });

  it("returns a 304 or 300 as it is: they are not redirects to follow", async () => {
    const a = await site((request, response) => {
      response.writeHead(request.url === "/304" ? 304 : 300, { location: "/elsewhere" });
      response.end();
    });
    assert.equal((await fetchTarget(`${a.origin}/304`, undefined, SAME_ORIGIN)).status, 304);
    assert.equal((await fetchTarget(`${a.origin}/300`, undefined, SAME_ORIGIN)).status, 300);
    assert.equal(a.seen.length, 2);
  });

  it("keeps the method, body and headers on a 307 or 308", async () => {
    const a = await site((request, response) => {
      if (request.url === "/old") { response.writeHead(307, { location: "/new" }); response.end(); return; }
      response.writeHead(402); response.end();
    });
    await fetchTarget(`${a.origin}/old`, {
      method: "POST",
      body: '{"text":"hi"}',
      headers: { "content-type": "application/json", "x-tenant": "demo" },
    }, SAME_ORIGIN);
    const [first, second] = a.seen;
    assert.equal(second?.method, "POST");
    assert.equal(second?.body, '{"text":"hi"}');
    assert.equal(second?.headers["x-tenant"], "demo");
    assert.equal(second?.headers["content-type"], "application/json");
    assert.equal(first?.body, '{"text":"hi"}');
  });

  it("turns a POST into a GET without body or content headers on a 301, 302 or 303", async () => {
    for (const status of [301, 302, 303]) {
      const a = await site((request, response) => {
        if (request.url === "/old") { response.writeHead(status, { location: "/new" }); response.end(); return; }
        response.writeHead(402); response.end();
      });
      await fetchTarget(`${a.origin}/old`, {
        method: "POST",
        body: '{"text":"hi"}',
        headers: { "content-type": "application/json", "x-tenant": "demo" },
      }, SAME_ORIGIN);
      const second = a.seen[1];
      assert.equal(second?.method, "GET", String(status));
      assert.equal(second?.body, "", String(status));
      assert.equal(second?.headers["content-type"], undefined, String(status));
      assert.equal(second?.headers["x-tenant"], "demo", String(status));
    }
  });

  it("keeps a PUT on a 302 (only a POST becomes a GET), and always a HEAD", async () => {
    const a = await site((request, response) => {
      if (request.url === "/old") { response.writeHead(302, { location: "/new" }); response.end(); return; }
      response.writeHead(402); response.end();
    });
    await fetchTarget(`${a.origin}/old`, { method: "PUT", body: "x" }, SAME_ORIGIN);
    assert.equal(a.seen[1]?.method, "PUT");
    await fetchTarget(`${a.origin}/old`, { method: "HEAD" }, SAME_ORIGIN);
    assert.equal(a.seen[3]?.method, "HEAD");
  });

  it("still reports an unreachable host as unreachable", async () => {
    await assert.rejects(fetchTarget("http://127.0.0.1:1/x", undefined, SAME_ORIGIN), /Could not connect/);
  });
});

describe("fetchTarget by default (the calls that carry a payment)", () => {
  it("still follows a redirect to another origin, as before this change", async () => {
    const b = await site((_request, response) => { response.writeHead(402); response.end("elsewhere"); });
    const a = await site((_request, response) => { response.writeHead(302, { location: `${b.origin}/x` }); response.end(); });
    const response = await fetchTarget(`${a.origin}/paid`);
    assert.equal(response.status, 402);
    assert.equal(await response.text(), "elsewhere");
    assert.equal(b.seen.length, 1);
  });
});

describe("RedirectRefusedError", () => {
  it("is a configuration error: no verdict about the target", async () => {
    const b = await site((_request, response) => { response.writeHead(402); response.end(); });
    const a = await site((_request, response) => { response.writeHead(302, { location: b.origin }); response.end(); });
    const error = await refusal(fetchTarget(`${a.origin}/x`, undefined, SAME_ORIGIN));
    assert.ok(error instanceof ConfigurationError);
    assert.equal(classifyCheckError(error).kind, "configuration");
  });
});

describe("runX402ReadChecks and a redirect", () => {
  const challenge = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepts: [{
        scheme: "exact",
        network: "stellar:testnet",
        amount: "10000",
        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        payTo: "GBNCC3VFT7PGUMGDQU5O35SXVWWTAHCO4LFFWLYFBLQCD56DNWYWM6ZS",
        maxTimeoutSeconds: 60,
      }],
    }),
  ).toString("base64");

  it("gives no verdict for a route that redirects to another origin, and sends nothing there", async () => {
    const b = await site((_request, response) => { response.writeHead(402, { "payment-required": challenge }); response.end(); });
    const a = await site((_request, response) => { response.writeHead(302, { location: `${b.origin}/paid` }); response.end(); });
    const results = await runX402ReadChecks({ target: `${a.origin}/paid` });
    assert.equal(results[0]?.id, "X402-01");
    assert.equal(results[0]?.error?.kind, "configuration");
    assert.match(results[0]?.detail ?? "", /redirects to/);
    assert.equal(results.filter((result) => result.pass).length, 0);
    assert.equal(results.slice(1).every((result) => result.skipped === true), true);
    assert.equal(b.seen.length, 0, "a request reached the other origin");
  });

  it("grades the route a same-origin redirect leads to", async () => {
    const a = await site((request, response) => {
      if (request.url === "/old") { response.writeHead(307, { location: "/paid" }); response.end(); return; }
      response.writeHead(402, { "payment-required": challenge }); response.end();
    });
    const results = await runX402ReadChecks({ target: `${a.origin}/old` });
    assert.deepEqual(results.map((result) => [result.id, result.pass]), [
      ["X402-01", true], ["X402-02", true], ["X402-03", true], ["X402-04", true], ["X402-05", true],
    ]);
  });
});
