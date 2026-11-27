/**
 * `wasit init` reading the route (spec C2, C6, C7 row 4; W3-2 slice 3), in
 * process, against paywalls on 127.0.0.1: the official @stellar/mpp charge
 * server, hand-made x402 and MPP channel challenges, and routes that are not
 * paywalls. The file init writes is then run by `wasit run` (the round trip of
 * C6). Every key and address is made up; nothing leaves 127.0.0.1, nothing is
 * paid or signed.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";
import { Mppx, Store, charge } from "@stellar/mpp/charge/server";
import { Challenge } from "mppx";

import { executeInit, type InitCommandOptions } from "../../src/init-command.js";
import { executeRun } from "../../src/run.js";

const TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PUBNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const CHANNEL = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const PAY_TO = Keypair.random().publicKey();
const OTHER_PAY_TO = Keypair.random().publicKey();

function x402Header(accepts: Array<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: "http://127.0.0.1/paid" }, accepts })).toString("base64");
}

function option(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    amount: "10000",
    asset: TESTNET_USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
    ...overrides,
  };
}

function channelHeader(request: Record<string, unknown> = { amount: "100", channel: CHANNEL, methodDetails: { network: "stellar:testnet" } }): string {
  return Challenge.serialize(Challenge.from({ id: "init-channel", realm: "127.0.0.1", method: "stellar", intent: "channel", request }));
}

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

interface Site {
  readonly base: string;
  readonly received: Received[];
  readonly close: () => Promise<void>;
}

type Route = (request: http.IncomingMessage, response: http.ServerResponse) => void | Promise<void>;

/** A site on 127.0.0.1 with a handler per path; any other path answers 404. Records every request. */
async function site(routes: Record<string, Route>): Promise<Site> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf-8") });
      const route = routes[new URL(request.url ?? "/", "http://127.0.0.1").pathname];
      if (route === undefined) {
        response.writeHead(404);
        response.end();
        return;
      }
      void route(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const x402Route =
  (header: string): Route =>
  (_request, response) => {
    response.writeHead(402, { "payment-required": header, "content-type": "application/json" });
    response.end("{}");
  };

const statusRoute =
  (status: number): Route =>
  (_request, response) => {
    response.writeHead(status);
    response.end("ok");
  };

/** The official @stellar/mpp charge server: 0.001 USDC on testnet to PAY_TO. */
function chargeRoute(): Route {
  const mppx = Mppx.create({
    secretKey: "wasit-init-test-challenge-secret",
    methods: [charge({ recipient: PAY_TO, currency: TESTNET_USDC, network: "stellar:testnet", store: Store.memory() })],
  });
  const listener = Mppx.toNodeListener(mppx.charge({ amount: "0.001", currency: TESTNET_USDC, recipient: PAY_TO }));
  return async (request, response) => {
    const result = await listener(request, response);
    if (result.status !== 402) response.end("paid");
  };
}

let dir: string;
const sites: Site[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "wasit-init-read-"));
});

afterEach(async () => {
  await Promise.all(sites.splice(0).map((entry) => entry.close()));
  await rm(dir, { recursive: true, force: true });
});

async function serve(routes: Record<string, Route>): Promise<Site> {
  const entry = await site(routes);
  sites.push(entry);
  return entry;
}

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function init(flags: Partial<InitCommandOptions>, env: Record<string, string> = {}, readTimeoutMs?: number): Promise<Outcome> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await executeInit(
    { operatedByMe: true, rejectHeader: [], config: "wasit.config.json", force: false, read: true, ...flags },
    {
      env,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      cwd: dir,
      ...(readTimeoutMs === undefined ? {} : { readTimeoutMs }),
    },
  );
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

async function run(flags: { readOnly?: boolean; dryRun?: boolean }): Promise<Outcome> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await executeRun(
    { config: path.join(dir, "wasit.config.json"), readOnly: flags.readOnly === true, dryRun: flags.dryRun === true, json: false, start: false },
    { env: { PATH: process.env["PATH"] ?? "" }, stdout: (line) => out.push(line), stderr: (line) => err.push(line), cwd: dir },
  );
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

const configFile = (): string => path.join(dir, "wasit.config.json");
const written = async (): Promise<Record<string, any>> => JSON.parse(await readFile(configFile(), "utf-8")) as Record<string, any>;

describe("wasit init: x402", () => {
  it("fills the network and the pin from the 402, sends one unpaid GET, and wasit run --read-only grades the file", async () => {
    const wall = await serve({ "/paid": x402Route(x402Header([option()])) });
    const { code, stdout, stderr } = await init({ url: `${wall.base}/paid` });
    assert.equal(code, 0, stderr);
    assert.equal(wall.received.length, 1);
    assert.equal(wall.received[0]?.method, "GET");
    assert.equal(wall.received[0]?.headers["payment-signature"], undefined);
    assert.equal(wall.received[0]?.headers["x-payment"], undefined);

    const config = await written();
    assert.deepEqual(config["environments"]["local"], {
      baseUrl: wall.base,
      network: "stellar:testnet",
      operatedByMe: true,
      pinned: { payTo: PAY_TO, asset: TESTNET_USDC },
    });
    assert.deepEqual(config["endpoints"], [{ name: "paid", protocol: "x402", path: "/paid", method: "GET" }]);

    assert.match(stdout, /^wasit init: wrote wasit\.config\.json: the environment local and the endpoint paid\.\nRead from your service:\n/);
    assert.ok(stdout.includes(`  one unpaid request: GET ${wall.base}/paid; nothing was paid or signed`));
    assert.ok(stdout.includes("  answer: 402 with a PAYMENT-REQUIRED header (x402)"));
    assert.ok(stdout.includes(`  offered: x402 on stellar:testnet: price 10000 base units ($0.001 in USDC), asset ${TESTNET_USDC}, payTo ${PAY_TO}`));
    assert.ok(stdout.includes("  written: protocol x402, network stellar:testnet"));
    assert.ok(stdout.includes(`  pinned: payTo ${PAY_TO}, asset ${TESTNET_USDC} (wasit run pays only these)`));
    assert.ok(!stdout.includes("network: stellar:testnet (default"), "the network was read, not defaulted");
    assert.ok(stdout.includes("  a request this route must refuse: X402-11 runs only with one"));
    assert.match(stdout, /\nNext: wasit run --read-only$/);

    const graded = await run({ readOnly: true });
    assert.equal(graded.code, 0, graded.stdout + graded.stderr);
  });

  it("sends the method, the body and the WASIT_HEADER_* headers wasit run sends, and prints no header value", async () => {
    const wall = await serve({ "/api/chat": x402Route(x402Header([option()])) });
    await writeFile(path.join(dir, "body.json"), '{ "prompt": "hello" }');
    const secret = "init-header-secret-value-0123456789";
    const { code, stdout } = await init({ url: `${wall.base}/api/chat`, method: "POST", bodyFile: "body.json" }, { WASIT_HEADER_X_API_KEY: secret });
    assert.equal(code, 0);
    assert.equal(wall.received[0]?.method, "POST");
    assert.equal(wall.received[0]?.body, '{"prompt":"hello"}');
    assert.equal(wall.received[0]?.headers["content-type"], "application/json");
    assert.equal(wall.received[0]?.headers["x-api-key"], secret);
    assert.ok(stdout.includes("with the WASIT_HEADER_* headers x-api-key (values not shown)"), stdout);
    assert.ok(!stdout.includes(secret));
    assert.equal((await written())["endpoints"][0]["headers"], undefined);
  });

  it("chooses the test network beside mainnet, and says what it left out", async () => {
    const wall = await serve({ "/paid": x402Route(x402Header([option({ network: "stellar:pubnet", asset: PUBNET_USDC }), option()])) });
    const { code, stdout } = await init({ url: `${wall.base}/paid` });
    assert.equal(code, 0);
    assert.ok(stdout.includes(`  also offered, not written: x402 on stellar:pubnet: price 10000 base units ($0.001 in USDC), asset ${PUBNET_USDC}`));
    assert.equal((await written())["environments"]["local"]["network"], "stellar:testnet");
  });

  it("writes no pin when the options disagree on the asset, and says so", async () => {
    const wall = await serve({
      "/paid": x402Route(x402Header([option(), option({ asset: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA" })])),
    });
    const { code, stdout } = await init({ url: `${wall.base}/paid` });
    assert.equal(code, 0);
    assert.ok(stdout.includes("  no pin: the route offers more than one receiving address or asset on stellar:testnet"));
    assert.equal((await written())["environments"]["local"]["pinned"], undefined);
  });

  it("writes an x402 v1 route for the read run to explain, on the default network, and says why", async () => {
    const wall = await serve({
      "/paid": (_request, response) => {
        response.writeHead(402, { "content-type": "application/json" });
        response.end(JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "stellar-testnet" }] }));
      },
    });
    const { code, stdout } = await init({ url: `${wall.base}/paid` });
    assert.equal(code, 0);
    assert.ok(stdout.includes("  answer: 402 with an x402 v1 challenge in the body. Wasit grades x402 v2 only"));
    assert.ok(stdout.includes("  network: stellar:testnet (default; init does not read the network from an x402 v1 challenge)"));
    const graded = await run({ readOnly: true });
    assert.equal(graded.code, 2);
    assert.match(graded.stdout, /unsupported/i);
  });

  it("writes the path a redirect inside the origin leads to", async () => {
    const wall = await serve({
      "/paid": (_request, response) => {
        response.writeHead(308, { location: "/v2/paid" });
        response.end();
      },
      "/v2/paid": x402Route(x402Header([option()])),
    });
    const { code, stdout } = await init({ url: `${wall.base}/paid` });
    assert.equal(code, 0);
    assert.ok(stdout.includes("  the route redirected once inside its origin, to /v2/paid: init wrote that path"));
    assert.equal((await written())["endpoints"][0]["path"], "/v2/paid");
  });

  it("writes the path a redirect leads to for an x402 v1 route too", async () => {
    const wall = await serve({
      "/old": (_request, response) => {
        response.writeHead(301, { location: "/v1/old" });
        response.end();
      },
      "/v1/old": (_request, response) => {
        response.writeHead(402, { "content-type": "application/json" });
        response.end(JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "stellar-testnet" }] }));
      },
    });
    const { code } = await init({ url: `${wall.base}/old` });
    assert.equal(code, 0);
    assert.equal((await written())["endpoints"][0]["path"], "/v1/old");
  });

  it("prints the service's values sanitised: no control character, no workflow command at a line start", async () => {
    const hostile = option({ payTo: `${PAY_TO}\n::error::owned`, amount: "1\u001b[2J" });
    const wall = await serve({ "/paid": x402Route(x402Header([hostile])) });
    const { code, stdout } = await init({ url: `${wall.base}/paid` });
    assert.equal(code, 0);
    assert.ok(!stdout.includes("\u001b"));
    assert.ok(!/^\s*::/m.test(stdout), stdout);
    // Not an address: no pin is written from it.
    assert.equal((await written())["environments"]["local"]["pinned"], undefined);
  });

  it("pins no key-shaped value the service puts in its challenge, and prints none", async () => {
    const key = Keypair.random().secret();
    const wall = await serve({ "/paid": x402Route(x402Header([option({ payTo: key })])) });
    const { code, stdout, stderr } = await init({ url: `${wall.base}/paid` }, { MPP_PAYER_SECRET: key });
    assert.equal(code, 0, stderr);
    assert.ok(stdout.includes("  no pin: the challenge's receiving address or asset is shaped like a Stellar secret key"), stdout);
    assert.ok(!stdout.includes(key) && !stderr.includes(key));
    assert.ok(!(await readFile(configFile(), "utf-8")).includes(key));
  });

  it("writes nothing when the challenge carries the value of one of the user's secret variables", async () => {
    const hex = "ab".repeat(32);
    const wall = await serve({ "/paid": x402Route(x402Header([option({ asset: hex })])) });
    const { code, stdout, stderr } = await init({ url: `${wall.base}/paid` }, { COMMITMENT_SECRET_HEX: hex });
    assert.equal(code, 2);
    assert.match(stderr, /would write the value of a variable Wasit keeps secret .* or from the route's challenge\. Nothing was written\./);
    assert.ok(!stdout.includes(hex) && !stderr.includes(hex));
    assert.ok(!existsSync(configFile()));
  });
});

describe("wasit init: MPP", () => {
  it("reads the official charge server's challenge: mpp-charge, its pin, and the dry run plans it", async () => {
    const wall = await serve({ "/mpp/chat": chargeRoute() });
    const { code, stdout, stderr } = await init({ url: `${wall.base}/mpp/chat` });
    assert.equal(code, 0, stderr);
    const config = await written();
    assert.deepEqual(config["endpoints"], [{ name: "chat", protocol: "mpp-charge", path: "/mpp/chat", method: "GET" }]);
    assert.deepEqual(config["environments"]["local"]["pinned"], { payTo: PAY_TO, asset: TESTNET_USDC });
    assert.ok(stdout.includes("  answer: 402 with a WWW-Authenticate challenge (MPP)"));
    assert.ok(stdout.includes(`  offered: MPP charge on stellar:testnet: price 10000 base units ($0.001 in USDC), currency ${TESTNET_USDC}, recipient ${PAY_TO}`), stdout);
    assert.match(stdout, /\nNext: wasit run --dry-run\n {2}\(MPP has no read-only checks/);

    const plan = await run({ dryRun: true });
    assert.equal(plan.code, 0, plan.stdout + plan.stderr);
    assert.match(plan.stdout, /MPP-01/);
  });

  it("reads a channel challenge: mpp-channel and its channel, no pin", async () => {
    const wall = await serve({
      "/stream": (_request, response) => {
        response.writeHead(402, { "www-authenticate": channelHeader() });
        response.end();
      },
    });
    const { code, stdout, stderr } = await init({ url: `${wall.base}/stream` });
    assert.equal(code, 0, stderr);
    const config = await written();
    assert.deepEqual(config["endpoints"], [{ name: "stream", protocol: "mpp-channel", path: "/stream", method: "GET", channel: CHANNEL }]);
    assert.equal(config["environments"]["local"]["pinned"], undefined);
    assert.ok(stdout.includes(`  channel: ${CHANNEL}`));
    assert.ok(stdout.includes("  the channel's on-chain terms (expect: token, from, to, refundWaitingPeriod), which its challenge does not carry"));

    const plan = await run({ dryRun: true });
    assert.equal(plan.code, 0, plan.stdout + plan.stderr);
  });

  it("x402 and MPP on one route: it does not choose; --protocol does", async () => {
    const both: Route = async (request, response) => {
      response.setHeader("payment-required", x402Header([option()]));
      await chargeRoute()(request, response);
    };
    const wall = await serve({ "/both": both });
    const refused = await init({ url: `${wall.base}/both` });
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /more than one way to pay on a test network: x402 on stellar:testnet; MPP charge on stellar:testnet/);
    assert.match(refused.stderr, /\n {2}offered: x402 on stellar:testnet/);
    assert.ok(!existsSync(configFile()));

    const chosen = await init({ url: `${wall.base}/both`, protocol: "mpp-charge" });
    assert.equal(chosen.code, 0, chosen.stderr);
    assert.ok(chosen.stdout.includes("  protocol: mpp-charge"));
    assert.ok(chosen.stdout.includes("  also offered, not written: x402 on stellar:testnet"));
    assert.equal((await written())["endpoints"][0]["protocol"], "mpp-charge");
  });

  it("refuses an MPP route read with another method than GET, and a reject case on MPP", async () => {
    const wall = await serve({ "/mpp/chat": chargeRoute() });
    const post = await init({ url: `${wall.base}/mpp/chat`, method: "POST" });
    assert.equal(post.code, 2);
    assert.match(post.stderr, /sends an MPP endpoint a plain GET in this version: this route was read with POST/);
    const reject = await init({ url: `${wall.base}/mpp/chat`, rejectHeader: ["x-lang: xx"] });
    assert.equal(reject.code, 2);
    assert.match(reject.stderr, /are for x402 \(X402-11\)/);
    assert.ok(!existsSync(configFile()));
  });

  it("says that wasit run sends an MPP endpoint nothing while a WASIT_HEADER_* variable is set", async () => {
    const wall = await serve({ "/mpp/chat": chargeRoute() });
    const { code, stdout } = await init({ url: `${wall.base}/mpp/chat` }, { WASIT_HEADER_X_API_KEY: "value-0123456789" });
    assert.equal(code, 0);
    assert.ok(stdout.includes("while a WASIT_HEADER_* variable is set, it sends this endpoint nothing"));
  });
});

describe("wasit init: a route that is not a paywall it can read (exit 2, nothing written)", () => {
  async function refused(routes: Record<string, Route>, message: RegExp, flags: Partial<InitCommandOptions> = {}): Promise<Outcome> {
    const wall = await serve(routes);
    const outcome = await init({ url: `${wall.base}/paid`, ...flags });
    assert.equal(outcome.code, 2, outcome.stdout);
    assert.equal(outcome.stdout, "");
    assert.match(outcome.stderr, message);
    assert.ok(!existsSync(configFile()));
    return outcome;
  }

  it("200: the paywall is not switched on", async () => {
    const { stderr } = await refused({ "/paid": statusRoute(200) }, /The paywall is not switched on: the route answered 200 without asking for payment\./);
    assert.match(stderr, /run this again with --no-read\.$/);
  });

  for (const status of [500, 503]) {
    it(`${status}: not switched on or misconfigured, with the hint of CDP 6.1`, async () => {
      await refused({ "/paid": statusRoute(status) }, new RegExp(`answered ${status} instead of 402\\. A missing payee or facilitator setting often answers this way`));
    });
  }

  it("404: the path or the method", async () => {
    await refused({}, /The route answered 404, not 402: check the path, and the method \(--method\)\./);
  });

  it("a 402 with nothing to read", async () => {
    await refused({ "/paid": statusRoute(402) }, /answered 402, and init could not read how it asks to be paid:\n {2}The 402 carries no PAYMENT-REQUIRED header/);
  });

  it("mainnet only: not written in this version", async () => {
    await refused(
      { "/paid": x402Route(x402Header([option({ network: "stellar:pubnet", asset: PUBNET_USDC })])) },
      /asks to be paid on stellar:pubnet \(mainnet\).*init writes test networks only in this version/,
    );
  });

  it("an environment that pins another address than the route pays", async () => {
    const wall = await serve({ "/paid": x402Route(x402Header([option({ payTo: OTHER_PAY_TO })])) });
    const pinned = {
      version: 1,
      environments: { local: { baseUrl: wall.base, network: "stellar:testnet", operatedByMe: true, pinned: { payTo: PAY_TO, asset: TESTNET_USDC } } },
      endpoints: [{ name: "a", protocol: "x402", path: "/a" }],
    };
    await writeFile(configFile(), JSON.stringify(pinned));
    const { code, stderr } = await init({ url: `${wall.base}/paid` });
    assert.equal(code, 2);
    assert.ok(stderr.includes(`pins payTo "${PAY_TO}"`) && stderr.includes(`paid to "${OTHER_PAY_TO}"`), stderr);
    assert.deepEqual(JSON.parse(await readFile(configFile(), "utf-8")), pinned);
  });

  it("a redirect to another origin: not followed, nothing sent there", async () => {
    const elsewhere = await serve({ "/paid": x402Route(x402Header([option()])) });
    await refused(
      {
        "/paid": (_request, response) => {
          response.writeHead(302, { location: `${elsewhere.base}/paid` });
          response.end();
        },
      },
      /which is not the origin .* this run was pointed at\. Wasit did not follow it\./,
    );
    assert.equal(elsewhere.received.length, 0);
  });

  it("a route that does not answer in time, and one nothing listens on", async () => {
    const wall = await serve({ "/paid": () => undefined });
    const late = await init({ url: `${wall.base}/paid` }, {}, 200);
    assert.equal(late.code, 2);
    assert.match(late.stderr, /got no answer\. It did not answer within 0\.2 s\. Start the service and run this again\. .*--no-read/);
    const closed = await site({});
    await closed.close();
    const none = await init({ url: `${closed.base}/paid` });
    assert.equal(none.code, 2);
    assert.match(none.stderr, /got no answer\. Could not connect to .*ECONNREFUSED/);
    assert.ok(!existsSync(configFile()));
  });
});

describe("wasit init: nothing is sent before every flag is checked", () => {
  const cases: Array<[string, Partial<InitCommandOptions>]> = [
    ["not operated by me", { operatedByMe: false }],
    ["a mainnet --network", { network: "stellar:pubnet" }],
    ["an unknown --protocol", { protocol: "lightning" }],
    ["a bad --name", { name: "-x" }],
    ["--ready-url without --start", { readyUrl: "http://127.0.0.1:1/" }],
    ["a missing body file", { method: "POST", bodyFile: "absent.json" }],
  ];
  for (const [label, flags] of cases) {
    it(label, async () => {
      const wall = await serve({ "/paid": x402Route(x402Header([option()])) });
      const { code } = await init({ url: `${wall.base}/paid`, ...flags });
      assert.equal(code, 2);
      assert.equal(wall.received.length, 0, `${label}: the route was asked`);
    });
  }

  it("a config that is not valid", async () => {
    await writeFile(configFile(), "{ not json");
    const wall = await serve({ "/paid": x402Route(x402Header([option()])) });
    const { code, stderr } = await init({ url: `${wall.base}/paid` });
    assert.equal(code, 2);
    assert.match(stderr, /Nothing was sent and nothing was written\.$/);
    assert.equal(wall.received.length, 0);
  });

  it("--no-read with an MPP protocol", async () => {
    const wall = await serve({ "/paid": chargeRoute() });
    const { code, stderr } = await init({ url: `${wall.base}/paid`, read: false, protocol: "mpp-charge" });
    assert.equal(code, 2);
    assert.match(stderr, /Without reading the route \(--no-read\), init writes x402 only/);
    assert.equal(wall.received.length, 0);
  });
});

describe("wasit init: a query named like a credential is never written (the config is committed)", () => {
  for (const name of ["api_key", "apiKey", "authKey", "key", "access_token", "X-Amz-Signature", "sig", "client_secret", "password"]) {
    it(`--url with ?${name}=: refused before anything is sent, the value never printed`, async () => {
      const wall = await serve({ "/paid": x402Route(x402Header([option()])) });
      const { code, stdout, stderr } = await init({ url: `${wall.base}/paid?${name}=made-up-value-0001&page=2` });
      assert.equal(code, 2);
      assert.equal(wall.received.length, 0, "the route was asked");
      assert.ok(!existsSync(configFile()), "a config was written");
      assert.ok(stderr.includes(`--url carries the query parameter "${name}", which is named like a credential`), stderr);
      assert.ok(!`${stdout}${stderr}`.includes("made-up-value-0001"), "the value was printed");
    });
  }

  it("--url with a query that names no credential is written as before", async () => {
    const wall = await serve({ "/paid": x402Route(x402Header([option()])) });
    const { code } = await init({ url: `${wall.base}/paid?keyword=weather&page=2` });
    assert.equal(code, 0);
    assert.equal((await written())["endpoints"][0]["path"], "/paid?keyword=weather&page=2");
  });

  it("a redirect inside the origin to a query named like a credential: refused, nothing written, the value never printed", async () => {
    const wall = await serve({
      "/hop": (_request, response) => {
        response.writeHead(302, { location: "/paid?access_token=made-up-token-0001" });
        response.end();
      },
      "/paid": x402Route(x402Header([option()])),
    });
    const { code, stdout, stderr } = await init({ url: `${wall.base}/hop` });
    assert.equal(code, 2);
    assert.ok(!existsSync(configFile()), "a config was written");
    assert.match(stderr, /redirected once inside its origin, to a URL whose query carries the parameter "access_token", which is named like a credential/);
    assert.ok(!`${stdout}${stderr}`.includes("made-up-token-0001"), "the value was printed");
  });
});

describe("wasit init: adding a route that was read to an existing config", () => {
  it("adds to an environment without a pin, and says it adds none", async () => {
    const wall = await serve({ "/a": x402Route(x402Header([option()])), "/b": x402Route(x402Header([option()])) });
    assert.equal((await init({ url: `${wall.base}/a`, read: false })).code, 0);
    const { code, stdout } = await init({ url: `${wall.base}/b` });
    assert.equal(code, 0);
    assert.ok(stdout.includes("  no pin added: the environment local is in the config without one, and init does not change it"));
    assert.equal((await written())["environments"]["local"]["pinned"], undefined);
  });

  it("adds a channel route to a pinned environment, which keeps its pin", async () => {
    const wall = await serve({
      "/paid": x402Route(x402Header([option()])),
      "/stream": (_request, response) => {
        response.writeHead(402, { "www-authenticate": channelHeader() });
        response.end();
      },
    });
    assert.equal((await init({ url: `${wall.base}/paid` })).code, 0);
    const { code, stdout, stderr } = await init({ url: `${wall.base}/stream` });
    assert.equal(code, 0, stderr);
    assert.ok(stdout.includes(`  pin: the environment's own (payTo ${PAY_TO}, asset ${TESTNET_USDC})`));
    const config = await written();
    assert.deepEqual(config["environments"]["local"]["pinned"], { payTo: PAY_TO, asset: TESTNET_USDC });
    assert.deepEqual(
      config["endpoints"].map((endpoint: { protocol: string }) => endpoint.protocol),
      ["x402", "mpp-channel"],
    );
  });

  it("chooses the environment's network among the ones the route offers", async () => {
    await writeFile(
      configFile(),
      JSON.stringify({
        version: 1,
        environments: { local: { baseUrl: "http://127.0.0.1:1", network: "eip155:84532", operatedByMe: true } },
        endpoints: [{ name: "a", protocol: "x402", path: "/a" }],
      }),
    );
    const base = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const wall = await serve({ "/paid": x402Route(x402Header([option(), option({ network: "eip155:84532", asset: base, payTo: "0x1111111111111111111111111111111111111111" })])) });
    const config = JSON.parse(await readFile(configFile(), "utf-8")) as Record<string, any>;
    config["environments"]["local"]["baseUrl"] = wall.base;
    await writeFile(configFile(), JSON.stringify(config));
    const { code, stdout, stderr } = await init({ url: `${wall.base}/paid` });
    assert.equal(code, 0, stderr);
    assert.ok(stdout.includes("  written: protocol x402, network eip155:84532"));
  });
});
