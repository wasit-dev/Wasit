/**
 * `wasit.config.json`: the schema and the loader (spec A1, A8 #5, #7, #9).
 *
 * The file is committed, so a pull request can change it, and Wasit reads it
 * for every run. Refusals come first here: an unknown key, a secret, the
 * mainnet opt-in, a path that leaves the declared origin, a header that is a
 * credential. Every refusal names the key and never echoes a value, so a
 * secret that was put in the file by mistake does not come back through the
 * error message.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ConfigurationError, classifyCheckError } from "../../src/errors.js";
import {
  CONFIG_VERSION,
  ConfigError,
  describeRun,
  headerEnvName,
  headersFromEnv,
  joinTarget,
  parseConfig,
  readConfigFile,
  resolveRun,
  validateConfig,
} from "../../src/config.js";

const FIXTURE = new URL("../fixtures/wasit.config.json", import.meta.url);

/** A Stellar secret-shaped value built here, so no real key is ever in the repository. */
const FAKE_SECRET = `S${"B".repeat(55)}`;
const PUBLIC_KEY = "GBNCC3VFT7PGUMGDQU5O35SXVWWTAHCO4LFFWLYFBLQCD56DNWYWM6ZS";
const CONTRACT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

type Json = Record<string, any>;

/** A fresh copy of the fixture, as a plain object a test can break. */
async function fixture(): Promise<Json> {
  const { readFileSync } = await import("node:fs");
  return JSON.parse(readFileSync(FIXTURE, "utf-8")) as Json;
}

/** The text of the error `validateConfig` throws for `value`, or a failed assertion. */
function refusal(value: unknown): ConfigError {
  try {
    validateConfig(value);
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected a ConfigError, got ${String(error)}`);
    return error;
  }
  return assert.fail("expected the config to be refused");
}

/** Mutates a copy of the fixture and asserts the result is refused, naming `path` and saying `says`. */
async function refusesWith(mutate: (config: Json) => void, path: string, says?: RegExp): Promise<ConfigError> {
  const config = await fixture();
  mutate(config);
  const error = refusal(config);
  assert.ok(error.issues.some((issue) => issue.path === path), `no issue for ${path}: ${JSON.stringify(error.issues)}`);
  if (says !== undefined) {
    const issue = error.issues.find((candidate) => candidate.path === path);
    assert.match(issue?.message ?? "", says);
  }
  assert.ok(error.message.includes(path), error.message);
  return error;
}

describe("the fixture config", () => {
  it("loads, and says version 1", async () => {
    const config = validateConfig(await fixture());
    assert.equal(CONFIG_VERSION, 1);
    assert.equal(config.version, 1);
    assert.deepEqual(Object.keys(config.environments), ["local", "staging", "mainnet"]);
    assert.deepEqual(config.endpoints.map((endpoint) => endpoint.name), ["weather", "summarize", "raw", "chat", "stream"]);
  });

  it("applies the defaults: GET, no headers, not operated by me until it says so", async () => {
    const config = validateConfig({
      version: 1,
      environments: { e: { baseUrl: "http://127.0.0.1:3000" } },
      endpoints: [{ name: "a", protocol: "x402", path: "/a" }],
    });
    assert.equal(config.environments["e"]?.network, "stellar:testnet");
    assert.equal(config.environments["e"]?.operatedByMe, false);
    assert.equal(config.endpoints[0]?.method, "GET");
    assert.deepEqual(config.endpoints[0]?.headers, {});
  });

  it("parses from text and from a file", () => {
    const text = JSON.stringify({
      version: 1,
      environments: { e: { baseUrl: "http://127.0.0.1:3000" } },
      endpoints: [{ name: "a", protocol: "x402", path: "/a" }],
    });
    assert.equal(parseConfig(text).endpoints.length, 1);
    assert.equal(parseConfig(`﻿${text}`).endpoints.length, 1, "a byte order mark is ignored");
    assert.equal(readConfigFile(FIXTURE.pathname).endpoints.length, 5);
  });
});

describe("a config that cannot be read", () => {
  it("refuses text that is not JSON, with a line and column and none of the text", () => {
    const error = (() => {
      try {
        parseConfig(`{\n  "version": 1,\n  "x": ${FAKE_SECRET}\n}`);
      } catch (caught) {
        return caught as ConfigError;
      }
      return assert.fail("expected a refusal");
    })();
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /not valid JSON/);
    assert.match(error.message, /line \d+, column \d+/);
    assert.equal(error.message.includes(FAKE_SECRET), false);
  });

  it("refuses a JSON value that is not an object", () => {
    for (const text of ["[]", "null", "1", '"x"']) {
      assert.throws(() => parseConfig(text), (error: unknown) => error instanceof ConfigError && /JSON object/.test(error.message), text);
    }
  });

  it("refuses a missing file and a file that is too large, without echoing contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "wasit-config-"));
    assert.throws(() => readConfigFile(join(dir, "missing.json")), (error: unknown) => error instanceof ConfigError && /cannot read/.test(error.message));
    const big = join(dir, "big.json");
    writeFileSync(big, `{"version":1,"pad":"${"x".repeat(300_000)}"}`);
    assert.throws(() => readConfigFile(big), (error: unknown) => error instanceof ConfigError && /larger than/.test(error.message));
  });

  it("is a configuration error: no verdict about any service", async () => {
    const error = refusal({});
    assert.ok(error instanceof ConfigurationError);
    assert.equal(classifyCheckError(error).kind, "configuration");
  });
});

describe("version", () => {
  it("must be present and exactly 1", async () => {
    for (const version of [undefined, 0, 2, "1", 1.5, null, true, [1]]) {
      const config = await fixture();
      if (version === undefined) delete config["version"];
      else config["version"] = version;
      const error = refusal(config);
      assert.ok(error.issues.some((issue) => issue.path === "version"), String(version));
    }
  });

  it("names a version it does not know without echoing anything but a number", async () => {
    const error = await refusesWith((config) => { config["version"] = 2; }, "version", /only version 1/);
    assert.match(error.message, /version 2/);
    const text = await refusesWith((config) => { config["version"] = `2${FAKE_SECRET}`; }, "version");
    assert.equal(text.message.includes(FAKE_SECRET), false);
  });
});

describe("unknown keys", () => {
  it("refuses an unknown top-level key, naming it", async () => {
    await refusesWith((config) => { config["telemetry"] = true; }, "telemetry", /unknown key/);
  });

  it("refuses an unknown key at every level, naming its path", async () => {
    await refusesWith((config) => { config["service"]["restart"] = "x"; }, "service.restart", /unknown key/);
    await refusesWith((config) => { config["service"]["ready"]["retries"] = 3; }, "service.ready.retries", /unknown key/);
    await refusesWith((config) => { config["environments"]["local"]["region"] = "x"; }, "environments.local.region", /unknown key/);
    await refusesWith((config) => { config["environments"]["staging"]["pinned"]["memo"] = "x"; }, "environments.staging.pinned.memo", /unknown key/);
    await refusesWith((config) => { config["endpoints"][1]["retries"] = 3; }, "endpoints[1].retries", /unknown key/);
    await refusesWith((config) => { config["endpoints"][1]["reject"]["status"] = 400; }, "endpoints[1].reject.status", /unknown key/);
    await refusesWith((config) => { config["endpoints"][4]["expect"]["amount"] = "1"; }, "endpoints[4].expect.amount", /unknown key/);
  });

  it("names a misspelt key rather than silently dropping the setting", async () => {
    await refusesWith((config) => { config["environments"]["local"]["operatedbyme"] = true; }, "environments.local.operatedbyme", /unknown key/);
    await refusesWith((config) => { config["endpoints"][0]["paths"] = "/x"; }, "endpoints[0].paths", /unknown key/);
  });

  it("reports every problem it finds, not only the first", async () => {
    const config = await fixture();
    config["extra1"] = 1;
    config["extra2"] = 2;
    const error = refusal(config);
    assert.deepEqual(error.issues.map((issue) => issue.path).sort(), ["extra1", "extra2"]);
  });

  it("does not let a key that is a prototype property through", async () => {
    const config = JSON.parse('{"version":1,"__proto__":{"polluted":true},"environments":{"e":{"baseUrl":"http://127.0.0.1:1"}},"endpoints":[{"name":"a","protocol":"x402","path":"/a"}]}');
    const error = refusal(config);
    assert.ok(error.issues.some((issue) => issue.path === "__proto__"));
    assert.equal(({} as Json)["polluted"], undefined);
  });
});

describe("forbidden keys: never in the file", () => {
  const SECRET_NAMES = [
    "secret", "privateKey", "payerKey", "payerSecret", "password", "mnemonic", "seed", "apiKey", "token", "commitmentKey",
    "STELLAR_PRIVATE_KEY", "EVM_PRIVATE_KEY", "SVM_PRIVATE_KEY", "MPP_PAYER_SECRET", "COMMITMENT_SECRET_HEX", "WASIT_MAINNET_PAYER_SECRET",
  ];
  const OPT_IN_NAMES = ["mainnet", "mainnetOptIn", "allowMainnet", "optIn", "mainnet-opt-in", "pubnet"];
  const DESTRUCTIVE_NAMES = ["allowDestructive", "destructive", "destructiveChannel", "mpp13", "MPP-13", "closeChannel", "allowClose"];
  const CAP_NAMES = ["maxPaymentUsd", "maxPayment", "maxPerPayment", "perPaymentCap", "paymentCap", "paymentLimit", "maxAmount", "spendLimit", "cap"];

  /** Where a forbidden key is tried: the top level, an environment, an endpoint, the pin, the service. */
  const PLACES: ReadonlyArray<[string, (config: Json, key: string) => void, (key: string) => string]> = [
    ["the top level", (config, key) => { config[key] = true; }, (key) => key],
    ["an environment", (config, key) => { config["environments"]["local"][key] = true; }, (key) => `environments.local.${key}`],
    ["an endpoint", (config, key) => { config["endpoints"][0][key] = true; }, (key) => `endpoints[0].${key}`],
    ["the pin", (config, key) => { config["environments"]["staging"]["pinned"][key] = true; }, (key) => `environments.staging.pinned.${key}`],
    ["the service block", (config, key) => { config["service"][key] = true; }, (key) => `service.${key}`],
  ];

  for (const [group, names, says] of [
    ["a secret or a secret variable name", SECRET_NAMES, /secrets? (never|are never)/i],
    ["the mainnet opt-in", OPT_IN_NAMES, /mainnet opt-in/i],
    ["allowDestructive or MPP-13", DESTRUCTIVE_NAMES, /MPP-13/],
    ["a per-payment cap", CAP_NAMES, /per-payment cap/i],
  ] as const) {
    it(`refuses ${group}, at every level, with its own reason`, async () => {
      for (const name of names) {
        for (const [place, set, pathOf] of PLACES) {
          await refusesWith((config) => set(config, name), pathOf(name), says).catch((error: unknown) => {
            throw new Error(`${name} in ${place}: ${String(error)}`);
          });
        }
      }
    });
  }

  it("does not mistake an environment named mainnet for the opt-in: the name is data, not a key", async () => {
    const config = validateConfig(await fixture());
    assert.equal(config.environments["mainnet"]?.network, "stellar:pubnet");
  });

  it("allows the one cap setting, maxRunUsd, between 0 (exclusive) and 5", async () => {
    for (const value of [0.01, 1, 2.5, 5]) {
      const config = await fixture();
      config["environments"]["local"]["maxRunUsd"] = value;
      assert.equal(validateConfig(config).environments["local"]?.maxRunUsd, value);
    }
  });

  it("refuses maxRunUsd above 5, at or below 0, and anything that is not a finite number", async () => {
    for (const value of [5.01, 6, 100, 0, -1, "2", null, true, [], {}]) {
      await refusesWith((config) => { config["environments"]["local"]["maxRunUsd"] = value; }, "environments.local.maxRunUsd", /above 0 and at most 5/);
    }
  });
});

describe("secret-shaped values", () => {
  it("refuses a Stellar secret key anywhere in the file, naming the path and never the value", async () => {
    const places: ReadonlyArray<[(config: Json) => void, string]> = [
      [(config) => { config["service"]["start"] = `node server.js --key ${FAKE_SECRET}`; }, "service.start"],
      [(config) => { config["environments"]["local"]["baseUrl"] = `http://127.0.0.1:3000/${FAKE_SECRET}`; }, "environments.local.baseUrl"],
      [(config) => { config["environments"]["local"]["network"] = FAKE_SECRET; }, "environments.local.network"],
      [(config) => { config["endpoints"][1]["body"] = { text: FAKE_SECRET }; }, "endpoints[1].body.text"],
      [(config) => { config["endpoints"][1]["body"] = [FAKE_SECRET]; }, "endpoints[1].body[0]"],
      [(config) => { config["endpoints"][2]["body"] = `raw ${FAKE_SECRET}`; }, "endpoints[2].body"],
      [(config) => { config["endpoints"][1]["headers"]["x-note"] = FAKE_SECRET; }, "endpoints[1].headers.x-note"],
      [(config) => { config["endpoints"][1]["reject"]["note"] = FAKE_SECRET; }, "endpoints[1].reject.note"],
    ];
    for (const [mutate, path] of places) {
      const error = await refusesWith(mutate, path, /Stellar secret key/);
      assert.equal(error.message.includes(FAKE_SECRET), false, path);
      assert.equal(JSON.stringify(error.issues).includes(FAKE_SECRET), false, path);
    }
  });

  it("does not take a public key, a contract address or a transaction hash for a secret", async () => {
    const config = await fixture();
    config["endpoints"][1]["body"] = { account: PUBLIC_KEY, contract: CONTRACT, tx: "ab".repeat(32) };
    assert.doesNotThrow(() => validateConfig(config));
  });

  it("echoes no value of any refusal: a canary in every refused field stays out of the message", async () => {
    const canary = "canary-value-31337";
    const mutations: Array<(config: Json) => void> = [
      (config) => { config["environments"]["local"]["baseUrl"] = `ftp://${canary}`; },
      (config) => { config["environments"]["local"]["baseUrl"] = `http://${canary}:${canary}@127.0.0.1`; },
      (config) => { config["environments"]["local"]["network"] = canary; },
      (config) => { config["environments"]["local"]["rpcUrl"] = `https://user:${canary}@rpc.example.com`; },
      (config) => { config["environments"]["local"]["rpcUrl"] = `https://rpc.example.com/?key=${canary}`; },
      (config) => { config["environments"]["staging"]["pinned"]["payTo"] = `bad ${canary}`; },
      (config) => { config["endpoints"][0]["path"] = `//${canary}.example/x`; },
      (config) => { config["endpoints"][0]["path"] = canary; },
      (config) => { config["endpoints"][0]["method"] = canary; },
      (config) => { config["endpoints"][0]["protocol"] = canary; },
      (config) => { config["endpoints"][0]["name"] = `bad name ${canary}`; },
      (config) => { config["endpoints"][1]["headers"]["authorization"] = `Bearer ${canary}`; },
      (config) => { config["endpoints"][1]["headers"]["x-api-key"] = canary; },
      (config) => { config["service"]["ready"]["url"] = `http://${canary}.example/`; },
      (config) => { config["service"]["start"] = `${canary}\n${canary}`; },
      (config) => { config["extra"] = canary; },
      (config) => { config["environments"]["local"]["privateKey"] = canary; },
      (config) => { config["defaultEnvironment"] = canary; },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const config = await fixture();
      mutate(config);
      const error = refusal(config);
      assert.equal(error.message.includes(canary), false, `mutation ${index}: ${error.message}`);
    }
  });
});

describe("environments", () => {
  it("needs at least one environment, with a plain name", async () => {
    await refusesWith((config) => { config["environments"] = {}; }, "environments", /at least one/);
    await refusesWith((config) => { delete config["environments"]; }, "environments");
    await refusesWith((config) => { config["environments"]["bad name"] = { baseUrl: "http://127.0.0.1:1" }; }, "environments.bad name", /letters, digits/);
    await refusesWith((config) => { config["environments"]["__proto__x"] = { baseUrl: "http://127.0.0.1:1" }; }, "environments.__proto__x", /letters, digits/);
  });

  it("holds baseUrl to an http(s) URL with no credentials, query or fragment", async () => {
    for (const bad of [
      "ftp://127.0.0.1", "file:///etc/passwd", "javascript:alert(1)", "127.0.0.1:3000", "localhost:3000/x", "not a url", "",
      "http://user@127.0.0.1:3000", "http://user:pass@127.0.0.1:3000", "http://:pass@127.0.0.1:3000",
      "http://127.0.0.1:3000/?key=1", "http://127.0.0.1:3000/#frag", "http:///", 5, null,
    ]) {
      await refusesWith((config) => { config["environments"]["local"]["baseUrl"] = bad; }, "environments.local.baseUrl");
    }
  });

  it("states why a baseUrl with credentials is refused, without printing the URL", async () => {
    const error = await refusesWith(
      (config) => { config["environments"]["local"]["baseUrl"] = "http://alice:hunter2@127.0.0.1:3000"; },
      "environments.local.baseUrl",
      /credentials/,
    );
    assert.equal(error.message.includes("hunter2"), false);
    assert.equal(error.message.includes("alice"), false);
  });

  it("checks the network is a CAIP-2 id, so a typo is caught before any run", async () => {
    for (const bad of ["stellar-testnet", "stellar:mainnet", "eip155:0x14a34", "Stellar:testnet", "", 5]) {
      await refusesWith((config) => { config["environments"]["local"]["network"] = bad; }, "environments.local.network");
    }
    for (const good of ["stellar:testnet", "stellar:pubnet", "eip155:84532", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "ach:us"]) {
      const config = await fixture();
      config["environments"]["local"]["network"] = good;
      assert.equal(validateConfig(config).environments["local"]?.network, good);
    }
  });

  it("takes operatedByMe only as a boolean", async () => {
    for (const bad of ["true", 1, "yes", null, {}]) {
      await refusesWith((config) => { config["environments"]["local"]["operatedByMe"] = bad; }, "environments.local.operatedByMe", /true or false/);
    }
  });

  it("takes a pin only as payTo and asset, both present and plain", async () => {
    await refusesWith((config) => { delete config["environments"]["staging"]["pinned"]["asset"]; }, "environments.staging.pinned.asset");
    await refusesWith((config) => { delete config["environments"]["staging"]["pinned"]["payTo"]; }, "environments.staging.pinned.payTo");
    await refusesWith((config) => { config["environments"]["staging"]["pinned"]["payTo"] = ""; }, "environments.staging.pinned.payTo");
    await refusesWith((config) => { config["environments"]["staging"]["pinned"]["payTo"] = "G has spaces"; }, "environments.staging.pinned.payTo");
    await refusesWith((config) => { config["environments"]["staging"]["pinned"] = "G..."; }, "environments.staging.pinned");
    const config = validateConfig(await fixture());
    assert.deepEqual(config.environments["staging"]?.pinned, { payTo: PUBLIC_KEY, asset: CONTRACT });
  });

  it("names a defaultEnvironment that does not exist", async () => {
    await refusesWith((config) => { config["defaultEnvironment"] = "nowhere"; }, "defaultEnvironment", /not one of the environments/);
  });

  it("takes an rpcUrl with no credentials and no query, and keeps it as given", async () => {
    for (const bad of ["ftp://rpc.example.com", "rpc.example.com", "https://user:key@rpc.example.com", "https://rpc.example.com/?apikey=1", "https://rpc.example.com/#x", 3]) {
      await refusesWith((config) => { config["environments"]["staging"]["rpcUrl"] = bad; }, "environments.staging.rpcUrl");
    }
    assert.equal(validateConfig(await fixture()).environments["staging"]?.rpcUrl, "https://rpc.example.com/soroban");
  });
});

describe("service", () => {
  it("takes a single-line start command and a loopback ready URL", async () => {
    const config = validateConfig(await fixture());
    assert.equal(config.service?.start, "npm start");
    assert.deepEqual(config.service?.ready, { url: "http://127.0.0.1:3000/", timeoutSeconds: 60 });
  });

  it("refuses a start command with a newline or a control character, or an empty one", async () => {
    for (const bad of ["a\nb", "a\u0000b", "a\u001b[31mb", "", "   ", 5, "x".repeat(501)]) {
      await refusesWith((config) => { config["service"]["start"] = bad; }, "service.start");
    }
  });

  it("holds the ready URL to a loopback host, so the wait never probes another service", async () => {
    for (const ok of ["http://127.0.0.1:3000/", "http://localhost:8080/health", "http://[::1]:3000/", "https://127.0.0.2/"]) {
      const config = await fixture();
      config["service"]["ready"]["url"] = ok;
      assert.equal(validateConfig(config).service?.ready?.url, ok);
    }
    for (const bad of ["https://api.example.com/", "http://10.0.0.5:3000/", "http://0.0.0.0:3000/", "http://127.0.0.1.example.com/", "http://user:pw@127.0.0.1/", "ftp://127.0.0.1/", "http://localhost.example.com/"]) {
      await refusesWith((config) => { config["service"]["ready"]["url"] = bad; }, "service.ready.url");
    }
  });

  it("holds timeoutSeconds to a whole number from 1 to 600", async () => {
    for (const bad of [0, -1, 601, 1.5, "60", null]) {
      await refusesWith((config) => { config["service"]["ready"]["timeoutSeconds"] = bad; }, "service.ready.timeoutSeconds");
    }
    const config = await fixture();
    delete config["service"]["ready"]["timeoutSeconds"];
    assert.equal(validateConfig(config).service?.ready?.timeoutSeconds, 60);
  });
});

describe("endpoints", () => {
  it("needs a non-empty list of objects", async () => {
    await refusesWith((config) => { config["endpoints"] = []; }, "endpoints", /at least one/);
    await refusesWith((config) => { delete config["endpoints"]; }, "endpoints");
    await refusesWith((config) => { config["endpoints"] = {}; }, "endpoints");
    await refusesWith((config) => { config["endpoints"][0] = "weather"; }, "endpoints[0]");
  });

  it("holds the name to a plain identifier, unique", async () => {
    for (const bad of ["", "a b", "a/b", "::error::x", "a".repeat(65), "-a", 5]) {
      await refusesWith((config) => { config["endpoints"][0]["name"] = bad; }, "endpoints[0].name");
    }
    await refusesWith((config) => { config["endpoints"][1]["name"] = "weather"; }, "endpoints[1].name", /already used/);
  });

  it("takes only the three protocols", async () => {
    for (const bad of ["x402v1", "mpp", "MPP-charge", "", 5]) {
      await refusesWith((config) => { config["endpoints"][0]["protocol"] = bad; }, "endpoints[0].protocol", /x402, mpp-charge or mpp-channel/);
    }
  });

  it("takes only known HTTP methods, in any case, and normalises them", async () => {
    await refusesWith((config) => { config["endpoints"][0]["method"] = "FETCH"; }, "endpoints[0].method");
    await refusesWith((config) => { config["endpoints"][0]["method"] = 5; }, "endpoints[0].method");
    const config = await fixture();
    config["endpoints"][0]["method"] = "head";
    assert.equal(validateConfig(config).endpoints[0]?.method, "HEAD");
  });

  it("refuses a body on GET or HEAD, as the run would", async () => {
    await refusesWith((config) => { config["endpoints"][0]["body"] = { a: 1 }; }, "endpoints[0].body", /cannot be sent with GET/);
    await refusesWith((config) => { config["endpoints"][0]["method"] = "HEAD"; config["endpoints"][0]["body"] = "x"; }, "endpoints[0].body", /cannot be sent with HEAD/);
  });

  it("refuses a body over 64 KiB", async () => {
    await refusesWith((config) => { config["endpoints"][1]["body"] = { text: "x".repeat(70_000) }; }, "endpoints[1].body", /64 KiB/);
  });

  it("keeps a JSON body as a value and a string body verbatim", async () => {
    const config = validateConfig(await fixture());
    assert.deepEqual(config.endpoints[1]?.body, { text: "hello" });
    assert.equal(config.endpoints[2]?.body, '{"verbatim":true}');
  });

  it("takes channel and expect only on mpp-channel, as real Stellar addresses", async () => {
    await refusesWith((config) => { config["endpoints"][0]["channel"] = CONTRACT; }, "endpoints[0].channel", /mpp-channel/);
    await refusesWith((config) => { config["endpoints"][3]["expect"] = { to: PUBLIC_KEY }; }, "endpoints[3].expect", /mpp-channel/);
    await refusesWith((config) => { config["endpoints"][4]["channel"] = "C..."; }, "endpoints[4].channel", /contract address/);
    await refusesWith((config) => { config["endpoints"][4]["expect"]["from"] = CONTRACT; }, "endpoints[4].expect.from", /account address/);
    await refusesWith((config) => { config["endpoints"][4]["expect"]["token"] = PUBLIC_KEY; }, "endpoints[4].expect.token", /contract address/);
    for (const bad of [0, -1, 1.5, "17280"]) {
      await refusesWith((config) => { config["endpoints"][4]["expect"]["refundWaitingPeriod"] = bad; }, "endpoints[4].expect.refundWaitingPeriod");
    }
  });

  it("takes a reject variant with something to vary, and the same body rules", async () => {
    await refusesWith((config) => { config["endpoints"][1]["reject"] = {}; }, "endpoints[1].reject", /method, headers or body/);
    await refusesWith((config) => { config["endpoints"][1]["reject"] = { note: "only a note" }; }, "endpoints[1].reject", /method, headers or body/);
    await refusesWith((config) => { config["endpoints"][1]["reject"] = { method: "GET", body: "x" }; }, "endpoints[1].reject.body", /cannot be sent with GET/);
    await refusesWith((config) => { config["endpoints"][1]["reject"] = { headers: { authorization: "x" } }; }, "endpoints[1].reject.headers.authorization");
    await refusesWith((config) => { config["endpoints"][1]["reject"]["note"] = "n".repeat(201); }, "endpoints[1].reject.note");
  });
});

describe("path: stays inside the origin of baseUrl (A-A06)", () => {
  const BASE = "http://127.0.0.1:3000";

  it("joins a path that starts with a single slash", () => {
    assert.equal(joinTarget(BASE, "/api/weather"), "http://127.0.0.1:3000/api/weather");
    assert.equal(joinTarget(BASE, "/api/raw?mode=fast"), "http://127.0.0.1:3000/api/raw?mode=fast");
    assert.equal(joinTarget(`${BASE}/`, "/a"), "http://127.0.0.1:3000/a");
  });

  it("keeps a path prefix in baseUrl", () => {
    assert.equal(joinTarget("https://staging.example.com/v1", "/weather"), "https://staging.example.com/v1/weather");
    assert.equal(joinTarget("https://staging.example.com/v1/", "/weather"), "https://staging.example.com/v1/weather");
  });

  it("refuses every path that could leave the origin", () => {
    for (const path of [
      "//evil.example/x", "///evil.example", "/\\evil.example", "\\\\evil.example", "/\\/evil.example",
      "/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/ /evil.example", "/\u0000/x",
      "http://evil.example/x", "https://evil.example", "evil.example/x", "evil.example", "javascript:alert(1)", "file:///etc/passwd",
      "", " ", "x", "?x=1", "#x", "/a#b", "/a\u0085b", "/a b", "/a\u007fb",
    ]) {
      assert.throws(() => joinTarget(BASE, path), (error: unknown) => error instanceof ConfigError, JSON.stringify(path));
    }
  });

  it("keeps the origin even for paths that look odd but stay inside it", () => {
    for (const path of ["/..//evil.example/x", "/%2F%2Fevil.example/x", "/a/../../b", "/@evil.example", "/:evil", "/a?next=//evil.example", "/a?next=http://evil.example"]) {
      const url = joinTarget(BASE, path);
      assert.equal(new URL(url).origin, BASE, path);
    }
  });

  it("refuses the path in the config file with the path's own key", async () => {
    for (const bad of ["//evil.example/x", "/\\evil.example", "https://evil.example/", "api/weather", "/\t/evil.example", 5, null]) {
      await refusesWith((config) => { config["endpoints"][0]["path"] = bad; }, "endpoints[0].path");
    }
  });

  it("refuses a baseUrl that already carries a query or fragment when joining", () => {
    assert.throws(() => joinTarget("http://127.0.0.1:3000/?a=1", "/x"), ConfigError);
    assert.throws(() => joinTarget("http://user:pw@127.0.0.1:3000", "/x"), ConfigError);
  });
});

describe("header names refused in the file (A8 #7)", () => {
  const REFUSED = [
    "authorization", "Authorization", "proxy-authorization", "x-authorization",
    "cookie", "Cookie", "set-cookie", "x-cookie-jar",
    "x-api-key", "X-API-KEY", "apikey", "x-key", "keyid", "x-private-key",
    "x-token", "X-Auth-Token", "token", "x-access-token",
    "x-secret", "client-secret", "x-secret-sauce",
    "x-password", "password", "x-passwd-hash-password",
  ];

  for (const name of REFUSED) {
    it(`refuses ${name} in endpoint headers and in a reject variant, and says to use WASIT_HEADER_`, async () => {
      const error = await refusesWith((config) => { config["endpoints"][1]["headers"][name] = "v"; }, `endpoints[1].headers.${name}`, /WASIT_HEADER_/);
      assert.equal(error.message.includes("\"v\""), false);
      await refusesWith((config) => { config["endpoints"][1]["reject"] = { headers: { [name]: "v" } }; }, `endpoints[1].reject.headers.${name}`, /WASIT_HEADER_/);
    });
  }

  it("refuses the headers Wasit sets itself, so the request stays what the check says it is", async () => {
    for (const name of ["x-payment", "X-PAYMENT", "payment-signature", "payment-required", "payment-response", "host", "content-length", "connection", "transfer-encoding"]) {
      await refusesWith((config) => { config["endpoints"][1]["headers"][name] = "v"; }, `endpoints[1].headers.${name}`);
    }
  });

  it("refuses an invalid header name or value, and two names that differ only in case", async () => {
    await refusesWith((config) => { config["endpoints"][1]["headers"]["bad name"] = "v"; }, "endpoints[1].headers.bad name", /header name/);
    await refusesWith((config) => { config["endpoints"][1]["headers"]["x-ok"] = "line1\r\nX-Injected: 1"; }, "endpoints[1].headers.x-ok", /control character/);
    await refusesWith((config) => { config["endpoints"][1]["headers"]["x-ok"] = 5; }, "endpoints[1].headers.x-ok", /string/);
    await refusesWith((config) => { config["endpoints"][1]["headers"]["X-Tenant"] = "other"; }, "endpoints[1].headers.X-Tenant", /twice/);
  });

  it("allows an ordinary header such as x-tenant or content-type", async () => {
    const config = await fixture();
    config["endpoints"][1]["headers"]["content-type"] = "application/vnd.api+json";
    config["endpoints"][1]["headers"]["accept-language"] = "en";
    assert.equal(validateConfig(config).endpoints[1]?.headers["x-tenant"], "demo");
  });
});

describe("WASIT_HEADER_<NAME> (A8 #7)", () => {
  it("maps a header name to its variable: upper case, hyphen written as underscore", () => {
    assert.equal(headerEnvName("x-api-key"), "WASIT_HEADER_X_API_KEY");
    assert.equal(headerEnvName("Authorization"), "WASIT_HEADER_AUTHORIZATION");
    assert.equal(headerEnvName("X-Tenant-Id"), "WASIT_HEADER_X_TENANT_ID");
  });

  it("reads the variables back into header names: lower case, underscore as hyphen", () => {
    const env = { WASIT_HEADER_X_API_KEY: "k1", WASIT_HEADER_AUTHORIZATION: "Bearer t", UNRELATED: "x", WASIT_RPC_URL: "https://rpc.example.com" };
    assert.deepEqual(headersFromEnv(env), { "x-api-key": "k1", authorization: "Bearer t" });
  });

  it("ignores a variable with no value, and refuses one with a name that cannot be a header", () => {
    assert.deepEqual(headersFromEnv({ WASIT_HEADER_X_EMPTY: "", WASIT_HEADER_X_UNSET: undefined }), {});
    assert.throws(() => headersFromEnv({ WASIT_HEADER_: "v" }), (error: unknown) => error instanceof ConfigError && /WASIT_HEADER_/.test(error.message));
    assert.throws(() => headersFromEnv({ "WASIT_HEADER_BAD NAME": "v" }), ConfigError);
  });

  it("refuses the headers Wasit sets itself and a value with a control character, never printing the value", () => {
    const secret = "very-secret-header-value";
    for (const env of [
      { WASIT_HEADER_X_PAYMENT: secret },
      { WASIT_HEADER_HOST: secret },
      { WASIT_HEADER_X_OK: `${secret}\r\nX-Injected: 1` },
    ]) {
      assert.throws(() => headersFromEnv(env), (error: unknown) => error instanceof ConfigError && !error.message.includes(secret));
    }
  });
});

describe("resolveRun", () => {
  const NO_ENV = {};

  it("picks the default environment and joins each endpoint to its URL", async () => {
    const run = resolveRun(validateConfig(await fixture()), {}, NO_ENV);
    assert.equal(run.environment, "local");
    assert.equal(run.network, "stellar:testnet");
    assert.equal(run.networkClass, "test");
    assert.equal(run.operatedByMe, true);
    assert.equal(run.endpoints[0]?.url, "http://127.0.0.1:3000/api/weather");
    assert.equal(run.endpoints[2]?.url, "http://127.0.0.1:3000/api/raw?mode=fast");
  });

  it("selects an environment by name and keeps its path prefix, pin and run cap", async () => {
    const run = resolveRun(validateConfig(await fixture()), { environment: "staging" }, NO_ENV);
    assert.equal(run.endpoints[0]?.url, "https://staging.example.com/v1/api/weather");
    assert.deepEqual(run.pinned, { payTo: PUBLIC_KEY, asset: CONTRACT });
    assert.equal(run.maxRunUsd, 2);
  });

  it("classifies the network with the guard's table: pubnet is mainnet-optin, an unlisted id unknown", async () => {
    const config = validateConfig(await fixture());
    assert.equal(resolveRun(config, { environment: "mainnet" }, NO_ENV).networkClass, "mainnet-optin");
    const other = await fixture();
    other["environments"]["local"]["network"] = "ach:us";
    assert.equal(resolveRun(validateConfig(other), {}, NO_ENV).networkClass, "unknown");
  });

  it("refuses an environment that does not exist, listing the real ones, and one that is a prototype property", async () => {
    const config = validateConfig(await fixture());
    for (const name of ["nowhere", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      assert.throws(
        () => resolveRun(config, { environment: name }, NO_ENV),
        (error: unknown) => error instanceof ConfigError && /local, staging, mainnet/.test(error.message),
        name,
      );
    }
  });

  it("needs --env when there is no default and more than one environment, and takes the only one otherwise", async () => {
    const config = await fixture();
    delete config["defaultEnvironment"];
    assert.throws(() => resolveRun(validateConfig(config), {}, NO_ENV), (error: unknown) => error instanceof ConfigError && /--env/.test(error.message));
    config["environments"] = { only: config["environments"]["local"] };
    assert.equal(resolveRun(validateConfig(config), {}, NO_ENV).environment, "only");
  });

  it("filters endpoints by name and refuses a name it does not have", async () => {
    const config = validateConfig(await fixture());
    assert.deepEqual(resolveRun(config, { endpoints: ["chat", "weather"] }, NO_ENV).endpoints.map((e) => e.name), ["weather", "chat"]);
    assert.throws(() => resolveRun(config, { endpoints: ["weather", "nope"] }, NO_ENV), (error: unknown) => error instanceof ConfigError && /nope/.test(error.message) && /weather/.test(error.message));
    assert.throws(() => resolveRun(config, { endpoints: ["constructor"] }, NO_ENV), ConfigError);
  });

  it("serialises a JSON body, sends a string body verbatim, and keeps the reject variant", async () => {
    const run = resolveRun(validateConfig(await fixture()), {}, NO_ENV);
    assert.equal(run.endpoints[1]?.body, '{"text":"hello"}');
    assert.equal(run.endpoints[2]?.body, '{"verbatim":true}');
    assert.equal(run.endpoints[0]?.body, undefined);
    assert.equal(run.endpoints[1]?.reject?.body, '{"text":""}');
    assert.equal(run.endpoints[1]?.reject?.note, "empty text must be refused");
    // The variant is exactly what the file says; how it applies to the request is the check's business.
    assert.equal(run.endpoints[1]?.reject?.method, undefined);
  });

  it("merges WASIT_HEADER_* over the file's headers, by header name in any case", async () => {
    const run = resolveRun(validateConfig(await fixture()), {}, { WASIT_HEADER_X_TENANT: "from-env", WASIT_HEADER_AUTHORIZATION: "Bearer t" });
    assert.deepEqual(run.endpoints[1]?.headers, { "x-tenant": "from-env", authorization: "Bearer t" });
    // The variables apply to every endpoint of the run.
    assert.deepEqual(run.endpoints[0]?.headers, { "x-tenant": "from-env", authorization: "Bearer t" });
  });

  it("lets WASIT_RPC_URL win over the file, and refuses one that is not an http(s) URL without printing it", async () => {
    const config = validateConfig(await fixture());
    assert.equal(resolveRun(config, { environment: "staging" }, { WASIT_RPC_URL: "https://other.example.com/rpc?key=abc" }).rpcUrl, "https://other.example.com/rpc?key=abc");
    assert.equal(resolveRun(config, { environment: "staging" }, NO_ENV).rpcUrl, "https://rpc.example.com/soroban");
    assert.equal(resolveRun(config, { environment: "local" }, NO_ENV).rpcUrl, undefined);
    assert.throws(
      () => resolveRun(config, {}, { WASIT_RPC_URL: "ftp://secret-host-name.example/path?key=abc" }),
      (error: unknown) => error instanceof ConfigError && /WASIT_RPC_URL/.test(error.message) && !error.message.includes("secret-host-name") && !error.message.includes("abc"),
    );
  });

  it("refuses an operatedByMe environment's payment need later, but loads a not-operated one now", async () => {
    const config = await fixture();
    config["environments"]["local"]["operatedByMe"] = false;
    assert.equal(resolveRun(validateConfig(config), {}, NO_ENV).operatedByMe, false);
  });
});

describe("describeRun: what is printed (only the origin of an RPC URL)", () => {
  it("prints the environment, base URL, network and class, and the RPC origin only", async () => {
    const config = validateConfig(await fixture());
    const run = resolveRun(config, { environment: "staging" }, { WASIT_RPC_URL: "https://user:pw@rpc.example.com:8443/v2/KEY-IN-PATH?apikey=KEY-IN-QUERY#KEY-IN-FRAGMENT" });
    const text = describeRun(run);
    assert.match(text, /staging/);
    assert.match(text, /https:\/\/staging\.example\.com\/v1/);
    assert.match(text, /stellar:testnet/);
    assert.match(text, /https:\/\/rpc\.example\.com:8443/);
    for (const leak of ["KEY-IN-PATH", "KEY-IN-QUERY", "KEY-IN-FRAGMENT", "user", "pw@", "apikey"]) {
      assert.equal(text.includes(leak), false, leak);
    }
  });

  it("never prints a header value, from the file or from the environment", async () => {
    const run = resolveRun(validateConfig(await fixture()), {}, { WASIT_HEADER_AUTHORIZATION: "Bearer canary-header-value" });
    const text = describeRun(run);
    assert.equal(text.includes("canary-header-value"), false);
    assert.equal(text.includes("demo"), false);
  });

  it("passes everything through the sanitiser", async () => {
    const config = await fixture();
    config["environments"]["local"]["baseUrl"] = "http://127.0.0.1:3000/%1b[31m";
    const text = describeRun(resolveRun(validateConfig(config), {}, {}));
    assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text), false);
  });
});
