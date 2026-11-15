/**
 * A request that carries a payment never follows a redirect (D-032, D-022c).
 *
 * `fetch` follows a redirect and keeps a custom header such as
 * `PAYMENT-SIGNATURE` on the way, so a route that redirects a paid request
 * would deliver the signed payment to a second URL: another host, or a second
 * handler of the same service, which can settle it while the check grades the
 * first. The rule: the unpaid challenge a payment check reads may follow one
 * redirect inside the origin, when the request keeps its method; the payment
 * then goes to the URL that challenge came from, with redirects refused. A
 * redirect answer to a paid request is no verdict, and the payment is not sent
 * again. MPP pays at the URL it reads, so every MPP request refuses a redirect.
 *
 * Offline: in-process servers on loopback, a throwaway EVM key (EIP-3009
 * signing needs no RPC), and a stand-in RPC for the balance X402-06 reads.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";
import { charge as chargeClient } from "@stellar/mpp/charge/client";
import { Mppx, Store, charge } from "@stellar/mpp/charge/server";
import { generatePrivateKey } from "viem/accounts";

import {
  RedirectRefusedError,
  classifyCheckError,
  fetchPaymentChallenge,
  fetchTarget,
  fetchWithoutRedirects,
} from "../../src/errors.js";
import { payCharge } from "../../src/mpp/charge.js";
import { runX402PaymentChecks } from "../../src/x402/simulator.js";

const NETWORK = "eip155:84532";

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly paid: boolean;
}

interface Site {
  readonly origin: string;
  readonly seen: Seen[];
  readonly close: () => Promise<void>;
}

const open: Site[] = [];

async function site(
  handle: (request: http.IncomingMessage, response: http.ServerResponse, origin: string) => void,
): Promise<Site> {
  const seen: Seen[] = [];
  let origin = "";
  const server = http.createServer((request, response) => {
    request.on("data", () => undefined);
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        path: request.url ?? "",
        paid:
          typeof request.headers["payment-signature"] === "string" ||
          typeof request.headers["authorization"] === "string",
      });
      handle(request, response, origin);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const created: Site = {
    origin,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  open.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((created) => created.close()));
});

async function refusal(promise: Promise<unknown>): Promise<RedirectRefusedError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RedirectRefusedError, `expected a RedirectRefusedError, got ${String(error)}`);
    return error;
  }
  return assert.fail("expected the redirect to be refused");
}

const CHALLENGE = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    resource: { url: "http://127.0.0.1/paid" },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        amount: "10000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
  }),
).toString("base64");

function isPaid(request: http.IncomingMessage): boolean {
  return typeof request.headers["payment-signature"] === "string";
}

/** A JSON-RPC stand-in: `eth_chainId` is Base Sepolia's, `eth_call` (the balance X402-06 reads) is plenty. */
async function rpcStandIn(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      const result =
        method === "eth_chainId" ? "0x14a34" : method === "eth_call" ? `0x${(10n ** 12n).toString(16).padStart(64, "0")}` : undefined;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          result === undefined
            ? { jsonrpc: "2.0", id, error: { code: -32601, message: "not in this stand-in" } }
            : { jsonrpc: "2.0", id, result },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe("fetchTarget by default: a redirect is never followed", () => {
  it("refuses a redirect inside the origin and sends nothing to the Location", async () => {
    const a = await site((request, response) => {
      if (request.url === "/paid") {
        response.writeHead(307, { location: "/elsewhere" });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end();
    });
    const error = await refusal(fetchTarget(`${a.origin}/paid`, { headers: { "payment-signature": "signed" } }));
    assert.match(error.message, /307/);
    assert.match(error.message, /does not follow a redirect/);
    assert.deepEqual(a.seen.map((s) => s.path), ["/paid"]);
  });

  it("refuses a redirect to another origin, names only its origin, and never connects there", async () => {
    const b = await site((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    const a = await site((_request, response) => {
      response.writeHead(302, { location: `${b.origin}/x?token=hunter2` });
      response.end();
    });
    const error = await refusal(fetchTarget(`${a.origin}/paid`));
    assert.match(error.message, new RegExp(b.origin.replace(/\./g, "\\.")));
    assert.equal(error.message.includes("hunter2"), false);
    assert.equal(b.seen.length, 0, "a request reached the other origin");
  });

  it("returns an answer that is not a redirect untouched, a 3xx without Location included", async () => {
    const a = await site((request, response) => {
      response.writeHead(request.url === "/bare" ? 302 : 402);
      response.end("body");
    });
    assert.equal((await fetchTarget(`${a.origin}/x`)).status, 402);
    assert.equal((await fetchTarget(`${a.origin}/bare`)).status, 302);
  });

  it("is a configuration error: no verdict about the target", async () => {
    const a = await site((_request, response) => {
      response.writeHead(308, { location: "/y" });
      response.end();
    });
    const error = await refusal(fetchTarget(`${a.origin}/x`));
    assert.equal(classifyCheckError(error).kind, "configuration");
  });
});

describe("fetchPaymentChallenge: the challenge a payment is signed for, and where to pay", () => {
  it("returns the target itself when it answers directly", async () => {
    const a = await site((_request, response) => {
      response.writeHead(402);
      response.end();
    });
    const { response, url } = await fetchPaymentChallenge(`${a.origin}/paid`, undefined);
    assert.equal(response.status, 402);
    assert.equal(url, `${a.origin}/paid`);
  });

  it("follows one redirect inside the origin and returns the URL it led to", async () => {
    const a = await site((request, response) => {
      if (request.url === "/old") {
        response.writeHead(308, { location: "/paid?x=1" });
        response.end();
        return;
      }
      response.writeHead(402);
      response.end();
    });
    const { response, url } = await fetchPaymentChallenge(`${a.origin}/old`, { method: "POST", body: "{}" });
    assert.equal(response.status, 402);
    assert.equal(url, `${a.origin}/paid?x=1`);
    assert.deepEqual(a.seen.map((s) => [s.method, s.path]), [["POST", "/old"], ["POST", "/paid?x=1"]]);
  });

  it("refuses a redirect that turns the request into a GET: the payment would go with another request", async () => {
    for (const status of [301, 302, 303]) {
      const a = await site((request, response) => {
        if (request.url === "/old") {
          response.writeHead(status, { location: "/paid" });
          response.end();
          return;
        }
        response.writeHead(402);
        response.end();
      });
      const error = await refusal(fetchPaymentChallenge(`${a.origin}/old`, { method: "POST", body: "{}" }));
      assert.match(error.message, /GET/, String(status));
      assert.deepEqual(a.seen.map((s) => s.path), ["/old"], String(status));
    }
  });

  it("refuses a redirect to another origin and a second redirect", async () => {
    const b = await site((_request, response) => {
      response.writeHead(402);
      response.end();
    });
    const a = await site((request, response) => {
      const to: Record<string, string> = { "/away": `${b.origin}/paid`, "/one": "/two", "/two": "/three" };
      const location = to[request.url ?? ""];
      if (location !== undefined) {
        response.writeHead(307, { location });
        response.end();
        return;
      }
      response.writeHead(402);
      response.end();
    });
    await refusal(fetchPaymentChallenge(`${a.origin}/away`, undefined));
    assert.equal(b.seen.length, 0);
    await refusal(fetchPaymentChallenge(`${a.origin}/one`, undefined));
  });
});

describe("fetchWithoutRedirects (the fetch MPP pays through)", () => {
  it("refuses a redirect for a string, a URL and a Request, and sends nothing to the Location", async () => {
    const a = await site((request, response) => {
      if (request.url === "/paid") {
        response.writeHead(302, { location: "/elsewhere" });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end();
    });
    await refusal(fetchWithoutRedirects(`${a.origin}/paid`, { headers: { authorization: "Payment x" } }));
    await refusal(fetchWithoutRedirects(new URL(`${a.origin}/paid`)));
    await refusal(fetchWithoutRedirects(new Request(`${a.origin}/paid`)));
    assert.deepEqual(a.seen.map((s) => s.path), ["/paid", "/paid", "/paid"]);
  });

  it("returns a direct answer", async () => {
    const a = await site((_request, response) => {
      response.writeHead(402);
      response.end();
    });
    assert.equal((await fetchWithoutRedirects(`${a.origin}/paid`)).status, 402);
  });
});

describe("runX402PaymentChecks and a redirect", () => {
  it("gives X402-06 no verdict when the paid request is redirected, and the payment reaches no second URL", async () => {
    const b = await site((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    const a = await site((request, response) => {
      if (!isPaid(request)) {
        response.writeHead(402, { "payment-required": CHALLENGE });
        response.end();
        return;
      }
      response.writeHead(307, { location: request.url === "/same" ? "/handler-two" : `${b.origin}/paid` });
      response.end();
    });
    const node = await rpcStandIn();
    try {
      for (const path of ["/same", "/away"]) {
        const results = await runX402PaymentChecks({
          target: `${a.origin}${path}`,
          network: NETWORK,
          payerSecretKey: generatePrivateKey(),
          rpcUrl: node.url,
        });
        const honest = results.find((result) => result.id === "X402-06");
        assert.equal(honest?.pass, false, path);
        assert.equal(honest?.error?.kind, "configuration", path);
        assert.match(honest?.detail ?? "", /redirect/, path);
        for (const result of results.filter((r) => r.id !== "X402-06")) {
          assert.notEqual(result.pass, true, `${path} ${result.id}`);
        }
      }
      assert.equal(b.seen.length, 0, "the payment reached another origin");
      assert.equal(
        a.seen.filter((s) => s.path === "/handler-two").length,
        0,
        "the payment reached a second handler of the same service",
      );
    } finally {
      await node.close();
    }
  });

  it("pays at the URL a same-origin redirect of the challenge led to, never at the first URL", async () => {
    const a = await site((request, response) => {
      if (request.url === "/old") {
        response.writeHead(307, { location: "/paid" });
        response.end();
        return;
      }
      if (!isPaid(request)) {
        response.writeHead(402, { "payment-required": CHALLENGE });
        response.end();
        return;
      }
      response.writeHead(402);
      response.end();
    });
    const node = await rpcStandIn();
    try {
      await runX402PaymentChecks({
        target: `${a.origin}/old`,
        network: NETWORK,
        payerSecretKey: generatePrivateKey(),
        rpcUrl: node.url,
      });
      const paid = a.seen.filter((s) => s.paid);
      assert.ok(paid.length > 0, "no payment was sent");
      assert.deepEqual([...new Set(paid.map((s) => s.path))], ["/paid"]);
    } finally {
      await node.close();
    }
  });
});

describe("payCharge (MPP-01) and a redirect", () => {
  const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

  /** The official @stellar/mpp charge server for a 0.001 USDC resource on testnet. */
  function officialCharge(): http.RequestListener {
    const recipient = Keypair.random().publicKey();
    const mppx = Mppx.create({
      secretKey: "wasit-unit-test-challenge-secret",
      methods: [charge({ recipient, currency: USDC_SAC, network: "stellar:testnet", store: Store.memory() })],
    });
    return async (req, res) => {
      const result = await Mppx.toNodeListener(mppx.charge({ amount: "0.001", currency: USDC_SAC, recipient }))(req, res);
      if (result.status !== 402) res.end("paid");
    };
  }

  function countingMethod(): { method: ReturnType<typeof chargeClient>; signed: () => number } {
    let signed = 0;
    const sdk = chargeClient({ secretKey: Keypair.random().secret() });
    const method = {
      ...sdk,
      createCredential: async () => {
        signed += 1;
        return "wasit-unit-test-credential";
      },
    } as typeof sdk;
    return { method, signed: () => signed };
  }

  it("does not follow a redirect of the paid request, and the credential reaches no second URL", async () => {
    const official = officialCharge();
    const a = await site((request, response) => {
      if (request.url === "/elsewhere") {
        response.writeHead(200);
        response.end();
        return;
      }
      if (typeof request.headers.authorization === "string") {
        response.writeHead(307, { location: "/elsewhere" });
        response.end();
        return;
      }
      void official(request, response);
    });
    const { method, signed } = countingMethod();
    await refusal(payCharge(`${a.origin}/paid`, "stellar:testnet", method));
    assert.equal(signed(), 1);
    assert.equal(a.seen.filter((s) => s.path === "/elsewhere").length, 0);
  });

  it("refuses a route that redirects before the challenge, and signs nothing", async () => {
    const a = await site((_request, response) => {
      response.writeHead(302, { location: "/paid-here" });
      response.end();
    });
    const { method, signed } = countingMethod();
    await refusal(payCharge(`${a.origin}/paid`, "stellar:testnet", method));
    assert.equal(signed(), 0);
    assert.deepEqual(a.seen.map((s) => s.path), ["/paid"]);
  });
});
