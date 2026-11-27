/**
 * The config writer of `wasit init` (spec C; init-skeleton-plan.md section 6):
 * data that is certain in, a `wasit.config.json` that `wasit run` accepts out.
 * operatedByMe true and a test network only; no defaults of its own; an
 * existing file is added to, never overwritten silently; nothing it writes is
 * refused by the validator, and a secret is never written.
 *
 * Pure: no file, no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfig, validateConfig } from "../../src/config.js";
import { ConfigWriteError, writeConfigText, type ConfigWriteInput } from "../../src/config-writer.js";

/** The example project's config, `dzakwannajmi/x402-example-paywall` `wasit.config.json` at `a77a8b3` (read 2026-11-24). */
const EXAMPLE = {
  version: 1,
  service: { start: "npm start", ready: { url: "http://127.0.0.1:4402/paid", timeoutSeconds: 30 } },
  defaultEnvironment: "local",
  environments: { local: { baseUrl: "http://127.0.0.1:4402", network: "stellar:testnet", operatedByMe: true } },
  endpoints: [
    {
      name: "quote-of-the-day",
      protocol: "x402",
      path: "/paid",
      method: "GET",
      reject: { headers: { "x-quote-lang": "xx" }, note: "a language the quote does not exist in must be refused" },
    },
  ],
};

const EXAMPLE_INPUT: ConfigWriteInput = {
  environment: { name: "local", baseUrl: "http://127.0.0.1:4402", network: "stellar:testnet", operatedByMe: true },
  endpoints: [
    {
      name: "quote-of-the-day",
      protocol: "x402",
      path: "/paid",
      method: "GET",
      reject: { headers: { "x-quote-lang": "xx" }, note: "a language the quote does not exist in must be refused" },
    },
  ],
  service: { start: "npm start", ready: { url: "http://127.0.0.1:4402/paid", timeoutSeconds: 30 } },
};

const CHAT: ConfigWriteInput["endpoints"][number] = { name: "chat", protocol: "mpp-charge", path: "/mpp/chat", method: "GET" };

function refusal(run: () => unknown): ConfigWriteError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ConfigWriteError, `not a ConfigWriteError: ${String(error)}`);
    return error;
  }
  assert.fail("expected the writer to refuse");
}

describe("writeConfigText: a new file", () => {
  it("writes the example project's config from the same answers, in a fixed key order, ending in one line break", () => {
    const { text, added, environmentAdded, serviceAdded } = writeConfigText(EXAMPLE_INPUT);
    assert.deepEqual(JSON.parse(text), EXAMPLE);
    assert.deepEqual(Object.keys(JSON.parse(text)), ["version", "service", "defaultEnvironment", "environments", "endpoints"]);
    assert.ok(text.endsWith("}\n") && !text.endsWith("\n\n"));
    assert.ok(!text.includes("\r"));
    assert.deepEqual(added, ["quote-of-the-day"]);
    assert.equal(environmentAdded, true);
    assert.equal(serviceAdded, true);
  });

  it("writes a file that wasit run's loader reads back as the same config", () => {
    const { text } = writeConfigText(EXAMPLE_INPUT);
    assert.deepEqual(parseConfig(text), validateConfig(EXAMPLE));
  });

  it("writes MPP endpoints and a channel, and a pin, as given", () => {
    const channel = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const payTo = "GDQ2NVWFGVLUCCGCFGWUWDA75EZ2KYNWUQAPEJKFQGMW5UOA7DAM5JD5";
    const asset = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
    const { text } = writeConfigText({
      environment: { name: "local", baseUrl: "http://127.0.0.1:3000", network: "stellar:testnet", operatedByMe: true, pinned: { payTo, asset } },
      endpoints: [CHAT, { name: "stream", protocol: "mpp-channel", path: "/mpp/stream", method: "GET", channel }],
    });
    const written = JSON.parse(text);
    assert.deepEqual(written.environments.local.pinned, { payTo, asset });
    assert.equal(written.endpoints[1].channel, channel);
    assert.equal(written.service, undefined, "no service block when none was given");
  });

  it("writes a body as a JSON value, and copies nothing it was not asked to write", () => {
    const input = {
      environment: { name: "local", baseUrl: "http://127.0.0.1:3000", network: "stellar:testnet", operatedByMe: true },
      endpoints: [
        // Fields the writer does not know, as a caller's mistake or a hostile object could add them.
        { name: "ask", protocol: "x402", path: "/ask", method: "POST", body: { question: "hi" }, allowDestructive: true, headers: { "x-lang": "en" } },
      ],
      mainnet: true,
    } as unknown as ConfigWriteInput;
    const written = JSON.parse(writeConfigText(input).text);
    assert.deepEqual(written.endpoints[0], { name: "ask", protocol: "x402", path: "/ask", method: "POST", body: { question: "hi" } });
    assert.equal(written.mainnet, undefined);
    assert.doesNotMatch(writeConfigText(input).text, /allowDestructive|mainnet|x-lang/);
  });
});

describe("writeConfigText: what it refuses, writing nothing", () => {
  it("an environment whose operatedByMe is not literally true", () => {
    for (const operatedByMe of [false, "true", 1, undefined]) {
      const input = { ...EXAMPLE_INPUT, environment: { ...EXAMPLE_INPUT.environment, operatedByMe } } as unknown as ConfigWriteInput;
      assert.match(refusal(() => writeConfigText(input)).message, /only for a service you operate/);
    }
  });

  it("Stellar mainnet, and a network that is not on Wasit's list", () => {
    const pubnet = { ...EXAMPLE_INPUT, environment: { ...EXAMPLE_INPUT.environment, network: "stellar:pubnet" } };
    assert.match(refusal(() => writeConfigText(pubnet)).message, /is Stellar mainnet: init writes test networks only/);
    for (const network of ["eip155:1", "stellar:futurenet", "not a network"]) {
      const other = { ...EXAMPLE_INPUT, environment: { ...EXAMPLE_INPUT.environment, network } };
      assert.match(refusal(() => writeConfigText(other)).message, /not on Wasit's list of test networks/);
    }
  });

  it("no endpoint, and an endpoint name given twice", () => {
    assert.match(refusal(() => writeConfigText({ ...EXAMPLE_INPUT, endpoints: [] })).message, /at least one endpoint/);
    assert.match(refusal(() => writeConfigText({ ...EXAMPLE_INPUT, endpoints: [CHAT, CHAT] })).message, /"chat" is given twice/);
  });

  it("anything the loader refuses: a bad path, a bad method, a secret in a body, a credential-like reject header", () => {
    const bad: ConfigWriteInput["endpoints"] = [
      { ...CHAT, path: "chat" },
      { ...CHAT, method: "FETCH" },
      { ...CHAT, method: "POST", body: { key: `S${"A".repeat(55)}` } },
      { name: "paid", protocol: "x402", path: "/paid", method: "GET", reject: { headers: { authorization: "Bearer x" } } },
    ];
    for (const endpoint of bad) {
      const error = refusal(() => writeConfigText({ ...EXAMPLE_INPUT, endpoints: [endpoint] }));
      assert.match(error.message, /does not accept, so it writes nothing/);
      assert.doesNotMatch(error.message, /S{1}A{55}/, "the secret is not echoed");
    }
  });
});

describe("writeConfigText: adding to an existing file", () => {
  const existing = `${JSON.stringify(EXAMPLE, null, 2)}\n`;

  it("appends the new endpoint, keeps the file's own endpoints and service, and says what it added", () => {
    const { text, added, environmentAdded, serviceAdded } = writeConfigText(
      { environment: EXAMPLE_INPUT.environment, endpoints: [CHAT] },
      { existing },
    );
    const written = JSON.parse(text);
    assert.deepEqual(written.endpoints.map((endpoint: { name: string }) => endpoint.name), ["quote-of-the-day", "chat"]);
    assert.deepEqual(written.endpoints[0], EXAMPLE.endpoints[0]);
    assert.deepEqual(written.service, EXAMPLE.service);
    assert.deepEqual(added, ["chat"]);
    assert.equal(environmentAdded, false);
    assert.equal(serviceAdded, false);
  });

  it("keeps the file's keys as they are: no defaults filled in, $schema kept", () => {
    const bare = JSON.stringify({
      $schema: "https://usewasit.dev/schema/wasit.config.json",
      version: 1,
      environments: { local: { baseUrl: "http://127.0.0.1:4402", operatedByMe: true } },
      endpoints: [{ name: "paid", protocol: "x402", path: "/paid" }],
    });
    const written = JSON.parse(writeConfigText({ environment: EXAMPLE_INPUT.environment, endpoints: [CHAT] }, { existing: bare }).text);
    assert.deepEqual(written.endpoints[0], { name: "paid", protocol: "x402", path: "/paid" }, "no method or headers added");
    assert.equal(written.$schema, "https://usewasit.dev/schema/wasit.config.json");
    assert.deepEqual(Object.keys(written.environments.local), ["baseUrl", "operatedByMe"], "the network default is not written in");
  });

  it("an endpoint the file already has exactly as given, in the same environment: unchanged, nothing to write", () => {
    const result = writeConfigText({ ...EXAMPLE_INPUT, service: undefined }, { existing });
    assert.deepEqual(result.unchanged, ["quote-of-the-day"]);
    assert.deepEqual(result.added, []);
    assert.equal(result.environmentAdded, false);
    assert.equal(result.changed, false);
    assert.deepEqual(JSON.parse(result.text), EXAMPLE, "the endpoint is not added a second time");
  });

  it("the same, with the same service given again: still nothing to write", () => {
    const result = writeConfigText(EXAMPLE_INPUT, { existing });
    assert.equal(result.serviceAdded, false);
    assert.equal(result.changed, false);
  });

  it("compares as the loader reads: a method left out is GET, any case; an object's keys in any order", () => {
    const file = JSON.stringify({
      version: 1,
      environments: { local: { baseUrl: "http://127.0.0.1:4402", operatedByMe: true } },
      endpoints: [
        { name: "paid", protocol: "x402", path: "/paid" },
        { protocol: "x402", name: "ask", path: "/ask", method: "post", body: { b: [1, 2], a: "x" } },
      ],
    });
    const result = writeConfigText(
      {
        environment: EXAMPLE_INPUT.environment,
        endpoints: [
          { name: "paid", protocol: "x402", path: "/paid", method: "GET" },
          { name: "ask", protocol: "x402", path: "/ask", method: "POST", body: { a: "x", b: [1, 2] } },
        ],
      },
      { existing: file },
    );
    assert.deepEqual(result.unchanged, ["paid", "ask"]);
    assert.equal(result.changed, false);
  });

  it("keeps the builder's own headers and expect: init never writes them, so they do not make the route another one", () => {
    const channel = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const stream = { name: "stream", protocol: "mpp-channel", path: "/mpp/stream", method: "GET", channel } as const;
    const file = `${JSON.stringify({
      version: 1,
      environments: { local: { baseUrl: "http://127.0.0.1:3000", network: "stellar:testnet", operatedByMe: true } },
      endpoints: [{ ...stream, headers: { "x-lang": "en" }, expect: { refundWaitingPeriod: 10 } }],
    })}\n`;
    const environment = { name: "local", baseUrl: "http://127.0.0.1:3000", network: "stellar:testnet", operatedByMe: true } as const;
    const result = writeConfigText({ environment, endpoints: [stream] }, { existing: file });
    assert.deepEqual(result.unchanged, ["stream"]);
    assert.equal(result.changed, false);
    assert.deepEqual(JSON.parse(result.text).endpoints[0].expect, { refundWaitingPeriod: 10 });
  });

  it("refuses the same name with another value, and names which (never its value)", () => {
    const base = EXAMPLE_INPUT.endpoints[0]!;
    const cases: Array<[ConfigWriteInput["endpoints"][number], RegExp]> = [
      [{ ...base, path: "/other" }, /whose path differs, and init does not overwrite it/],
      [{ ...base, method: "POST", body: { q: 1 } }, /whose method and body differ, and/],
      [{ ...base, reject: { headers: { "x-quote-lang": "zz" } } }, /whose reject differs, and/],
      [{ ...base, protocol: "mpp-charge", path: "/other", reject: undefined }, /whose protocol, path and reject differ, and/],
    ];
    for (const [endpoint, pattern] of cases) {
      const error = refusal(() => writeConfigText({ environment: EXAMPLE_INPUT.environment, endpoints: [endpoint] }, { existing }));
      assert.match(error.message, /already has an endpoint named "quote-of-the-day" whose /);
      assert.match(error.message, pattern);
      assert.match(error.message, /--force/);
      assert.doesNotMatch(error.message, /zz|\/other/, "values are not echoed");
    }
  });

  it("refuses an array in another order: a body is the same only item for item", () => {
    const file = JSON.stringify({
      version: 1,
      environments: { local: { baseUrl: "http://127.0.0.1:4402", operatedByMe: true } },
      endpoints: [{ name: "ask", protocol: "x402", path: "/ask", method: "POST", body: { ids: [1, 2] } }],
    });
    const error = refusal(() =>
      writeConfigText(
        { environment: EXAMPLE_INPUT.environment, endpoints: [{ name: "ask", protocol: "x402", path: "/ask", method: "POST", body: { ids: [2, 1] } }] },
        { existing: file },
      ),
    );
    assert.match(error.message, /whose body differs/);
  });

  it("refuses another channel, and a body with one more key", () => {
    const channel = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const other = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
    const environment = { name: "local", baseUrl: "http://127.0.0.1:3000", network: "stellar:testnet", operatedByMe: true } as const;
    const file = JSON.stringify({
      version: 1,
      environments: { local: { baseUrl: "http://127.0.0.1:3000", network: "stellar:testnet", operatedByMe: true } },
      endpoints: [
        { name: "stream", protocol: "mpp-channel", path: "/mpp/stream", method: "GET", channel },
        { name: "ask", protocol: "x402", path: "/ask", method: "POST", body: { a: 1 } },
      ],
    });
    const stream = { name: "stream", protocol: "mpp-channel", path: "/mpp/stream", method: "GET", channel: other } as const;
    assert.match(refusal(() => writeConfigText({ environment, endpoints: [stream] }, { existing: file })).message, /"stream" whose channel differs/);
    const ask = { name: "ask", protocol: "x402", path: "/ask", method: "POST", body: { a: 1, b: 2 } } as const;
    assert.match(refusal(() => writeConfigText({ environment, endpoints: [ask] }, { existing: file })).message, /"ask" whose body differs/);
  });

  it("the route as given with a start command the file does not have yet: the service is added, so the file changes", () => {
    const withoutService = `${JSON.stringify({ ...EXAMPLE, service: undefined }, null, 2)}\n`;
    const result = writeConfigText(EXAMPLE_INPUT, { existing: withoutService });
    assert.deepEqual(result.unchanged, ["quote-of-the-day"]);
    assert.equal(result.serviceAdded, true);
    assert.equal(result.changed, true);
    assert.deepEqual(JSON.parse(result.text).service, EXAMPLE.service);
    assert.equal(JSON.parse(result.text).endpoints.length, 1);
  });

  it("refuses an endpoint the file has, given again with a new environment: not added twice, not left silently", () => {
    const sepolia = { name: "sepolia", baseUrl: "http://127.0.0.1:5000", network: "eip155:84532", operatedByMe: true } as const;
    const error = refusal(() => writeConfigText({ environment: sepolia, endpoints: EXAMPLE_INPUT.endpoints }, { existing }));
    assert.match(error.message, /already has an endpoint named "quote-of-the-day", and init does not add it again with the new environment "sepolia"/);
  });

  it("one endpoint unchanged and one new: only the new one is appended", () => {
    const result = writeConfigText({ environment: EXAMPLE_INPUT.environment, endpoints: [EXAMPLE_INPUT.endpoints[0]!, CHAT] }, { existing });
    assert.deepEqual(result.unchanged, ["quote-of-the-day"]);
    assert.deepEqual(result.added, ["chat"]);
    assert.equal(result.changed, true);
    assert.deepEqual(JSON.parse(result.text).endpoints.map((endpoint: { name: string }) => endpoint.name), ["quote-of-the-day", "chat"]);
  });

  it("refuses an environment of the same name with another URL, network or pin", () => {
    for (const environment of [
      { ...EXAMPLE_INPUT.environment, baseUrl: "http://127.0.0.1:9999" },
      { ...EXAMPLE_INPUT.environment, network: "eip155:84532" },
      { ...EXAMPLE_INPUT.environment, pinned: { payTo: "GDQ2NVWFGVLUCCGCFGWUWDA75EZ2KYNWUQAPEJKFQGMW5UOA7DAM5JD5", asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" } },
    ]) {
      assert.match(refusal(() => writeConfigText({ environment, endpoints: [CHAT] }, { existing })).message, /already has an environment named "local"/);
    }
  });

  it("adds a second environment, and keeps the one the file ran before as the default", () => {
    const single = JSON.stringify({ ...EXAMPLE, defaultEnvironment: undefined });
    const written = JSON.parse(
      writeConfigText(
        { environment: { name: "sepolia", baseUrl: "http://127.0.0.1:5000", network: "eip155:84532", operatedByMe: true }, endpoints: [CHAT] },
        { existing: single },
      ).text,
    );
    assert.deepEqual(Object.keys(written.environments), ["local", "sepolia"]);
    assert.equal(written.defaultEnvironment, "local");
  });

  it("refuses a different start command, and adds one when the file has none", () => {
    const other = { start: "node server.js", ready: { url: "http://127.0.0.1:4402/paid", timeoutSeconds: 30 } };
    assert.match(
      refusal(() => writeConfigText({ environment: EXAMPLE_INPUT.environment, endpoints: [CHAT], service: other }, { existing })).message,
      /already says how to start the service/,
    );
    const noService = JSON.stringify({ ...EXAMPLE, service: undefined });
    const result = writeConfigText({ environment: EXAMPLE_INPUT.environment, endpoints: [CHAT], service: other }, { existing: noService });
    assert.deepEqual(JSON.parse(result.text).service, other);
    assert.equal(result.serviceAdded, true);
  });

  it("leaves a file that is not a valid config as it is, and says so without quoting it", () => {
    for (const broken of ["{ not json", JSON.stringify({ version: 2 }), JSON.stringify({ ...EXAMPLE, endpoints: [{ name: "x" }] })]) {
      const error = refusal(() => writeConfigText({ environment: EXAMPLE_INPUT.environment, endpoints: [CHAT] }, { existing: broken }));
      assert.match(error.message, /not valid, so init does not change it/);
      assert.doesNotMatch(error.message, /not json/);
    }
  });

  it("starts from nothing with replace", () => {
    const { text, environmentAdded } = writeConfigText(EXAMPLE_INPUT, { existing: "{ not json", replace: true });
    assert.deepEqual(JSON.parse(text), EXAMPLE);
    assert.equal(environmentAdded, true);
  });

  it("reads a file that starts with a byte order mark", () => {
    const { text } = writeConfigText({ environment: EXAMPLE_INPUT.environment, endpoints: [CHAT] }, { existing: `﻿${existing}` });
    assert.equal(JSON.parse(text).endpoints.length, 2);
    assert.ok(!text.startsWith("﻿"));
  });
});
