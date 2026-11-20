/**
 * `wasit.config.json`, version 1: the schema and the loader.
 *
 * One file, read the same way by `wasit run`, the Action and `wasit init`. It
 * is committed, so a pull request can change it, and every run reads it. That
 * shapes the loader:
 *
 * - strict: an unknown key or version is an error that names the key, never a
 *   setting that is silently dropped;
 * - closed: a secret, a secret variable name, the mainnet opt-in, a flag that
 *   enables MPP-13 and a per-payment cap have no place in the file, and each is
 *   refused with its own reason (the only cap the file may set is a LOWER
 *   per-run one, `maxRunUsd`, at most 5);
 * - quiet: an error names the key and never the value, so a secret that was
 *   pasted into the file by mistake does not come back through the message;
 * - bounded: a path cannot leave the origin of `baseUrl`, and a header that is
 *   a credential travels in an environment variable, not in the file.
 *
 * Pure and offline: it reads a file at most, and sends and signs nothing.
 */

import { readFileSync, statSync } from "node:fs";

import { StrKey } from "@stellar/stellar-sdk";

import { PROTOCOL_IDS, type ProtocolId } from "./catalogue.js";
import { ConfigurationError } from "./errors.js";
import { networkClass, type NetworkClass } from "./guard/networks.js";
import { sanitizeText } from "./sanitize.js";
import { validateNetwork } from "./x402/requirements.js";

/** The only version this loader reads. */
export const CONFIG_VERSION = 1;

/** The most a config file may weigh. A real one is a few kilobytes. */
const MAX_CONFIG_BYTES = 256 * 1024;

/** The most a request body (or a reject variant's) may weigh once serialised. */
const MAX_BODY_BYTES = 64 * 1024;

const MAX_ENDPOINTS = 50;
const MAX_DEPTH = 32;
const MAX_ISSUES_SHOWN = 10;

/** The most the file may set a run to spend. The built-in per-run cap, which the file can only lower. */
const MAX_RUN_USD = 5;

/** One problem found in a config, located by the key it is about. */
export interface ConfigIssue {
  /** Dotted path of the key, e.g. `endpoints[1].headers.authorization`. Empty for the file itself. */
  readonly path: string;
  /** What is wrong and what to do. Never contains a value from the file. */
  readonly message: string;
}

/**
 * The config cannot be used. A `ConfigurationError`: nothing is learned about
 * any service, so it is no verdict and exits 2.
 */
export class ConfigError extends ConfigurationError {
  public readonly issues: readonly ConfigIssue[];

  public constructor(title: string, issues: readonly ConfigIssue[]) {
    const shown = issues
      .slice(0, MAX_ISSUES_SHOWN)
      .map((issue) => `  - ${issue.path === "" ? "(file)" : issue.path}: ${issue.message}`);
    const more = issues.length > MAX_ISSUES_SHOWN ? [`  - and ${issues.length - MAX_ISSUES_SHOWN} more`] : [];
    super([title, ...shown, ...more].join("\n"));
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** A JSON value, as a request body may be. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface ReadyConfig {
  readonly url: string;
  readonly timeoutSeconds: number;
}

export interface ServiceConfig {
  readonly start?: string;
  readonly ready?: ReadyConfig;
}

export interface PinConfig {
  readonly payTo: string;
  readonly asset: string;
}

export interface EnvironmentConfig {
  /** An http(s) URL with no credentials, query or fragment; no trailing slash. */
  readonly baseUrl: string;
  /** A CAIP-2 id. Default `stellar:testnet`. */
  readonly network: string;
  /** Must be true for any payment check to run on this environment. Default false. */
  readonly operatedByMe: boolean;
  readonly pinned?: PinConfig;
  /** Env `WASIT_RPC_URL` wins. Only its origin is ever printed. */
  readonly rpcUrl?: string;
  /** A LOWER per-run cap in USD, above 0 and at most 5. */
  readonly maxRunUsd?: number;
}

export interface RejectConfig {
  readonly method?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: JsonValue;
  readonly note?: string;
}

export interface ChannelExpectation {
  readonly token?: string;
  readonly from?: string;
  readonly to?: string;
  readonly refundWaitingPeriod?: number;
}

export interface EndpointConfig {
  readonly name: string;
  readonly protocol: ProtocolId;
  /** Starts with a single `/`; joined to `baseUrl`, it keeps the origin. */
  readonly path: string;
  /** Upper case. Default GET. */
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** A JSON value (serialised by Wasit) or a string (sent verbatim). */
  readonly body?: JsonValue;
  readonly reject?: RejectConfig;
  readonly channel?: string;
  readonly expect?: ChannelExpectation;
}

export interface WasitConfig {
  readonly version: 1;
  readonly service?: ServiceConfig;
  readonly defaultEnvironment?: string;
  readonly environments: Readonly<Record<string, EnvironmentConfig>>;
  readonly endpoints: readonly EndpointConfig[];
}

// ---------------------------------------------------------------------------
// Issues

class Issues {
  public readonly list: ConfigIssue[] = [];

  public add(path: string, message: string): void {
    // A path is built from keys the file chose: sanitised, one line, bounded.
    const clean = sanitizeText(path).replace(/\s+/g, " ").slice(0, 120);
    this.list.push({ path: clean, message });
  }
}

const TITLE = "Invalid wasit.config.json:";

function failIfAny(issues: Issues): void {
  if (issues.list.length > 0) throw new ConfigError(TITLE, issues.list);
}

function at(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Keys

/** Keys that have no place in the file, by what their name says, each with the reason. */
const FORBIDDEN_KEYS: ReadonlyArray<{ readonly match: RegExp; readonly reason: string }> = [
  {
    match: /secret|privatekey|payerkey|commitment|passw|mnemonic|seed|apikey|accesskey|token|credential|signingkey|signer/,
    reason:
      "secrets never go in this file, which is committed: give them to the run as environment variables",
  },
  {
    match: /mainnet|optin|pubnet/,
    reason: "the mainnet opt-in is never set in this file: it is a flag or an input on one run",
  },
  {
    match: /destructive|mpp13|closechannel|allowclose/,
    reason: "MPP-13 closes a channel for good and is never enabled from a file",
  },
  {
    match: /^cap$|cap$|maxpayment|perpayment|paymentcap|paymentlimit|maxamount|spendlimit|maxspend|maxusd/,
    reason:
      "the per-payment cap ($1) is fixed in the code and cannot be raised from a file; " +
      "this file may only lower the per-run cap, with maxRunUsd",
  },
];

/** Why `key` is forbidden, if its name says so. */
function forbiddenKeyReason(key: string): string | undefined {
  const normal = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return FORBIDDEN_KEYS.find((rule) => rule.match.test(normal))?.reason;
}

/** Refuses every key of `object` that is not in `allowed`, a forbidden one with its own reason. */
function checkKeys(object: Record<string, unknown>, allowed: readonly string[], path: string, issues: Issues): void {
  for (const key of Object.keys(object)) {
    if (allowed.includes(key)) continue;
    const reason = forbiddenKeyReason(key);
    issues.add(
      at(path, key),
      reason === undefined
        ? "unknown key: wasit.config.json version 1 has no such setting (a misspelt key is refused, not ignored)"
        : `not allowed in this file: ${reason}`,
    );
  }
}

/** A Stellar secret key, as a value anywhere in the file. */
const STELLAR_SECRET = /S[A-Z2-7]{55}/;

/**
 * Finds any string value shaped like a Stellar secret key, in the whole file,
 * body and headers included. The path is reported; the value never is.
 */
function scanForSecrets(value: unknown, path: string, depth: number, issues: Issues): void {
  if (typeof value === "string") {
    if (STELLAR_SECRET.test(value)) {
      issues.add(
        path,
        "contains a value shaped like a Stellar secret key; remove it from the file (and rotate the key if it is real)",
      );
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (depth > MAX_DEPTH) {
    issues.add(path, `is nested more than ${MAX_DEPTH} levels deep`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForSecrets(item, `${path}[${index}]`, depth + 1, issues));
    return;
  }
  for (const [key, item] of Object.entries(value)) scanForSecrets(item, at(path, key), depth + 1, issues);
}

// ---------------------------------------------------------------------------
// Values

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const ADDRESS = /^[A-Za-z0-9]{20,128}$/;

/** The methods a request may use; the same set the checks accept. */
const HTTP_METHODS: readonly string[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const BODYLESS_METHODS: readonly string[] = ["GET", "HEAD"];

/** Parses an http(s) URL; the reason it is not one otherwise. Never echoes the URL. */
function readHttpUrl(value: unknown): { url: URL } | { problem: string } {
  if (typeof value !== "string") return { problem: "must be a URL, written as a string" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: "is not a valid absolute URL; include the scheme, e.g. http://127.0.0.1:3000" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { problem: "must be an http or https URL" };
  }
  if (url.hostname === "") return { problem: "has no host" };
  return { url };
}

function hasCredentials(url: URL): boolean {
  return url.username !== "" || url.password !== "";
}

function readBaseUrl(value: unknown, path: string, issues: Issues): string | undefined {
  const parsed = readHttpUrl(value);
  if ("problem" in parsed) {
    issues.add(path, parsed.problem);
    return undefined;
  }
  const { url } = parsed;
  if (hasCredentials(url)) {
    issues.add(path, "must not carry credentials (user:password@): the URL is printed in reports");
    return undefined;
  }
  if (url.search !== "" || url.hash !== "") {
    issues.add(path, "must not carry a query or fragment: put those in an endpoint's path");
    return undefined;
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** A host that is this machine. The readiness wait probes nothing else. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/** True for an http(s) URL on this machine with no credentials: the only kind a readiness wait may probe. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      isLoopbackHost(parsed.hostname) &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function readRpcUrl(value: unknown, path: string, issues: Issues): string | undefined {
  const parsed = readHttpUrl(value);
  if ("problem" in parsed) {
    issues.add(path, parsed.problem);
    return undefined;
  }
  if (hasCredentials(parsed.url) || parsed.url.search !== "" || parsed.url.hash !== "") {
    issues.add(
      path,
      "must not carry credentials, a query or a fragment: this file is committed, and an RPC key " +
        "usually travels there. Set the full URL in the environment variable WASIT_RPC_URL instead",
    );
    return undefined;
  }
  return parsed.url.href;
}

function readName(value: unknown, path: string, what: string, issues: Issues): string | undefined {
  if (typeof value === "string" && NAME.test(value)) return value;
  issues.add(path, `${what} must be 1 to 64 letters, digits, dots, underscores or hyphens, starting with a letter or digit`);
  return undefined;
}

// ---------------------------------------------------------------------------
// Paths

/** Why `path` could leave the origin it is joined to, if it could. */
function pathProblem(path: unknown): string | undefined {
  if (typeof path !== "string") return "must be a path, written as a string";
  if (!path.startsWith("/")) return "must start with a single / (a path on the service, not a URL or a host)";
  // `//host` is a network-path reference and `/\host` is read as one by the URL parser.
  if (path.startsWith("//") || path.startsWith("/\\")) return "must start with a single /, not // or /\\";
  // Tab and newline are removed by the URL parser, so `/<tab>/host` becomes `//host`; a backslash is a slash.
  if (/[\\\s#\u0000-\u001f\u007f-\u009f]/.test(path)) {
    return "must not contain a space, a control character, a backslash or a #";
  }
  return undefined;
}

/**
 * Joins a base URL and a path, keeping the base URL's origin.
 *
 * The path is held to the rules above, and the result is checked to have the
 * origin of `baseUrl`: a path that could carry a request to another host is
 * refused, not repaired (spec A8 #5).
 *
 * @throws {ConfigError} For a path that could leave the origin, or a base URL that is not one.
 */
export function joinTarget(baseUrl: string, path: string): string {
  const issues = new Issues();
  const problem = pathProblem(path);
  if (problem !== undefined) issues.add("path", problem);
  const base = readBaseUrl(baseUrl, "baseUrl", issues);
  if (base === undefined || problem !== undefined) throw new ConfigError("Cannot join the target:", issues.list);

  const joined = new URL(base + path);
  if (joined.origin !== new URL(base).origin) {
    throw new ConfigError("Cannot join the target:", [{ path: "path", message: "leaves the origin of baseUrl" }]);
  }
  return joined.href;
}

// ---------------------------------------------------------------------------
// Headers

/** A header name's characters (RFC 9110 token). */
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A name that carries a credential: it travels in the environment, never in a committed file. */
const CREDENTIAL_HEADER_PARTS = ["authorization", "cookie", "key", "token", "secret", "password"];

/** Headers Wasit sets itself, or the transport owns. A file or variable that sets one would change the request a check describes. */
const OWN_HEADERS: ReadonlySet<string> = new Set([
  "x-payment",
  "payment-signature",
  "payment-required",
  "payment-response",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
]);

const MAX_HEADER_VALUE = 1000;

/** The variable that carries the value of header `name`: upper case, `-` written as `_`. */
export function headerEnvName(name: string): string {
  return `WASIT_HEADER_${name.toUpperCase().replace(/-/g, "_")}`;
}

function readHeaders(raw: unknown, path: string, issues: Issues): Record<string, string> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    issues.add(path, "must be an object of header names to string values");
    return {};
  }
  const seen = new Set<string>();
  const headers: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(raw)) {
    const here = at(path, name);
    const lower = name.toLowerCase();
    if (!HEADER_TOKEN.test(name)) {
      issues.add(here, "is not a valid header name");
      continue;
    }
    if (CREDENTIAL_HEADER_PARTS.some((part) => lower.includes(part))) {
      issues.add(
        here,
        `a header named like a credential does not belong in a committed file: ` +
          `send it with the environment variable ${headerEnvName(name)}`,
      );
      continue;
    }
    if (OWN_HEADERS.has(lower)) {
      issues.add(here, "is a header Wasit or the transport sets itself, so it cannot be set here");
      continue;
    }
    if (seen.has(lower)) {
      issues.add(here, "is set twice (header names are not case-sensitive)");
      continue;
    }
    seen.add(lower);
    if (typeof value !== "string") {
      issues.add(here, "must be a string");
    } else if (CONTROL.test(value)) {
      issues.add(here, "must not contain a control character (a line break would add a header)");
    } else if (value.length > MAX_HEADER_VALUE) {
      issues.add(here, `must be at most ${MAX_HEADER_VALUE} characters`);
    } else {
      headers.push([name, value]);
    }
  }
  return Object.fromEntries(headers);
}

/**
 * The headers given in the environment, by name in lower case.
 *
 * `WASIT_HEADER_<NAME>` carries the header `<NAME>` written in upper case with
 * `-` as `_`. Values are secrets: they are never printed, and a refusal names
 * the variable, not the value. A header Wasit sets itself cannot be given this
 * way either; the credential-like names the file refuses are exactly what this
 * is for.
 *
 * @throws {ConfigError} For a variable whose name or value cannot be a header.
 */
export function headersFromEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const prefix = "WASIT_HEADER_";
  const headers: Array<[string, string]> = [];
  for (const [variable, value] of Object.entries(env)) {
    if (!variable.startsWith(prefix) || value === undefined || value === "") continue;
    const part = variable.slice(prefix.length);
    const problem = (message: string): never => {
      throw new ConfigError("Cannot read the header variables:", [{ path: variable, message }]);
    };
    if (!/^[A-Z0-9][A-Z0-9_]*$/.test(part)) {
      problem("after WASIT_HEADER_ use upper case letters, digits and underscores (an underscore stands for a hyphen)");
    }
    const name = part.toLowerCase().replace(/_/g, "-");
    if (OWN_HEADERS.has(name)) problem("is a header Wasit or the transport sets itself, so it cannot be set here");
    if (CONTROL.test(value)) problem("has a value with a control character (a line break would add a header)");
    headers.push([name, value]);
  }
  return Object.fromEntries(headers);
}

// ---------------------------------------------------------------------------
// Body

function serializedBytes(body: JsonValue): number {
  return Buffer.byteLength(typeof body === "string" ? body : JSON.stringify(body), "utf-8");
}

/** A body as the wire carries it: a string verbatim, anything else as JSON. */
function serializeBody(body: JsonValue): string {
  return typeof body === "string" ? body : JSON.stringify(body);
}

function readBody(raw: unknown, method: string, path: string, issues: Issues): JsonValue | undefined {
  if (raw === undefined) return undefined;
  if (BODYLESS_METHODS.includes(method)) {
    issues.add(path, `A request body cannot be sent with ${method}. Name the method the endpoint uses, e.g. POST`);
    return undefined;
  }
  if (serializedBytes(raw as JsonValue) > MAX_BODY_BYTES) {
    issues.add(path, `is larger than ${MAX_BODY_BYTES / 1024} KiB`);
    return undefined;
  }
  return raw as JsonValue;
}

// ---------------------------------------------------------------------------
// Sections

function readService(raw: unknown, issues: Issues): ServiceConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    issues.add("service", "must be an object");
    return undefined;
  }
  checkKeys(raw, ["start", "ready"], "service", issues);

  let start: string | undefined;
  if (raw["start"] !== undefined) {
    const value = raw["start"];
    if (typeof value !== "string" || value.trim() === "" || value.length > 500 || CONTROL.test(value)) {
      issues.add("service.start", "must be one line of at most 500 characters: the command that starts the service");
    } else {
      start = value;
    }
  }

  let ready: ReadyConfig | undefined;
  if (raw["ready"] !== undefined) {
    const value = raw["ready"];
    if (!isRecord(value)) {
      issues.add("service.ready", "must be an object with a url");
    } else {
      checkKeys(value, ["url", "timeoutSeconds"], "service.ready", issues);
      const parsed = readHttpUrl(value["url"]);
      let url: string | undefined;
      if ("problem" in parsed) {
        issues.add("service.ready.url", parsed.problem);
      } else if (hasCredentials(parsed.url) || !isLoopbackHost(parsed.url.hostname)) {
        issues.add(
          "service.ready.url",
          "must be an address on this machine (localhost, 127.x.x.x or [::1]) with no credentials: " +
            "the wait probes the service the run starts, nothing else",
        );
      } else {
        url = value["url"] as string;
      }
      const timeout = value["timeoutSeconds"] === undefined ? 60 : value["timeoutSeconds"];
      if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 600) {
        issues.add("service.ready.timeoutSeconds", "must be a whole number of seconds from 1 to 600");
      } else if (url !== undefined) {
        ready = { url, timeoutSeconds: timeout };
      }
    }
  }

  return { ...(start === undefined ? {} : { start }), ...(ready === undefined ? {} : { ready }) };
}

function readPin(raw: unknown, path: string, issues: Issues): PinConfig | undefined {
  if (!isRecord(raw)) {
    issues.add(path, "must be an object with payTo and asset");
    return undefined;
  }
  checkKeys(raw, ["payTo", "asset"], path, issues);
  const fields: Record<string, string> = {};
  for (const key of ["payTo", "asset"] as const) {
    const value = raw[key];
    if (typeof value !== "string" || !ADDRESS.test(value)) {
      issues.add(at(path, key), "must be an address: 20 to 128 letters and digits, no spaces");
    } else {
      fields[key] = value;
    }
  }
  return fields["payTo"] !== undefined && fields["asset"] !== undefined
    ? { payTo: fields["payTo"], asset: fields["asset"] }
    : undefined;
}

function readEnvironment(raw: unknown, path: string, issues: Issues): EnvironmentConfig | undefined {
  if (!isRecord(raw)) {
    issues.add(path, "must be an object");
    return undefined;
  }
  checkKeys(raw, ["baseUrl", "network", "operatedByMe", "pinned", "rpcUrl", "maxRunUsd"], path, issues);
  const before = issues.list.length;

  const baseUrl = raw["baseUrl"] === undefined ? undefined : readBaseUrl(raw["baseUrl"], at(path, "baseUrl"), issues);
  if (raw["baseUrl"] === undefined) issues.add(at(path, "baseUrl"), "is required");

  const networkRaw = raw["network"] === undefined ? "stellar:testnet" : raw["network"];
  let network: string | undefined;
  if (typeof networkRaw !== "string") {
    issues.add(at(path, "network"), "must be a CAIP-2 network id, e.g. stellar:testnet");
  } else {
    const verdict = validateNetwork(networkRaw);
    if (verdict.valid) network = networkRaw;
    else issues.add(at(path, "network"), `is not a usable network id. ${verdict.fix}`);
  }

  const operatedRaw = raw["operatedByMe"] === undefined ? false : raw["operatedByMe"];
  if (typeof operatedRaw !== "boolean") issues.add(at(path, "operatedByMe"), "must be true or false");

  const pinned = raw["pinned"] === undefined ? undefined : readPin(raw["pinned"], at(path, "pinned"), issues);
  const rpcUrl = raw["rpcUrl"] === undefined ? undefined : readRpcUrl(raw["rpcUrl"], at(path, "rpcUrl"), issues);

  let maxRunUsd: number | undefined;
  if (raw["maxRunUsd"] !== undefined) {
    const value = raw["maxRunUsd"];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_RUN_USD) {
      issues.add(at(path, "maxRunUsd"), `must be a number above 0 and at most ${MAX_RUN_USD}: this setting can only lower the per-run cap`);
    } else {
      maxRunUsd = value;
    }
  }

  if (issues.list.length > before || baseUrl === undefined || network === undefined) return undefined;
  return {
    baseUrl,
    network,
    operatedByMe: operatedRaw as boolean,
    ...(pinned === undefined ? {} : { pinned }),
    ...(rpcUrl === undefined ? {} : { rpcUrl }),
    ...(maxRunUsd === undefined ? {} : { maxRunUsd }),
  };
}

function readReject(raw: unknown, endpointMethod: string, path: string, issues: Issues): RejectConfig | undefined {
  if (!isRecord(raw)) {
    issues.add(path, "must be an object with a method, headers or body that the service must refuse");
    return undefined;
  }
  checkKeys(raw, ["method", "headers", "body", "note"], path, issues);
  if (raw["method"] === undefined && raw["headers"] === undefined && raw["body"] === undefined) {
    issues.add(path, "must change something: set a method, headers or body");
    return undefined;
  }

  let method: string | undefined;
  if (raw["method"] !== undefined) {
    const value = typeof raw["method"] === "string" ? raw["method"].toUpperCase() : "";
    if (HTTP_METHODS.includes(value)) method = value;
    else issues.add(at(path, "method"), `must be one of ${HTTP_METHODS.join(", ")}`);
  }
  const headers = readHeaders(raw["headers"], at(path, "headers"), issues);
  const body = readBody(raw["body"], method ?? endpointMethod, at(path, "body"), issues);

  let note: string | undefined;
  if (raw["note"] !== undefined) {
    if (typeof raw["note"] === "string" && raw["note"].length <= 200 && !CONTROL.test(raw["note"])) note = raw["note"];
    else issues.add(at(path, "note"), "must be one line of at most 200 characters");
  }

  return {
    ...(method === undefined ? {} : { method }),
    headers,
    ...(body === undefined ? {} : { body }),
    ...(note === undefined ? {} : { note }),
  };
}

function readExpectation(raw: unknown, path: string, issues: Issues): ChannelExpectation | undefined {
  if (!isRecord(raw)) {
    issues.add(path, "must be an object");
    return undefined;
  }
  checkKeys(raw, ["token", "from", "to", "refundWaitingPeriod"], path, issues);
  const expected: { token?: string; from?: string; to?: string; refundWaitingPeriod?: number } = {};
  if (raw["token"] !== undefined) {
    if (typeof raw["token"] === "string" && StrKey.isValidContract(raw["token"])) expected.token = raw["token"];
    else issues.add(at(path, "token"), "must be a Soroban contract address (C...)");
  }
  for (const key of ["from", "to"] as const) {
    if (raw[key] === undefined) continue;
    const value = raw[key];
    if (typeof value === "string" && StrKey.isValidEd25519PublicKey(value)) expected[key] = value;
    else issues.add(at(path, key), "must be a Stellar account address (G...)");
  }
  if (raw["refundWaitingPeriod"] !== undefined) {
    const value = raw["refundWaitingPeriod"];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) expected.refundWaitingPeriod = value;
    else issues.add(at(path, "refundWaitingPeriod"), "must be a positive whole number of ledgers");
  }
  return expected;
}

function readEndpoint(raw: unknown, index: number, taken: Set<string>, issues: Issues): EndpointConfig | undefined {
  const path = `endpoints[${index}]`;
  if (!isRecord(raw)) {
    issues.add(path, "must be an object");
    return undefined;
  }
  checkKeys(raw, ["name", "protocol", "path", "method", "headers", "body", "reject", "channel", "expect"], path, issues);
  const before = issues.list.length;

  const name = readName(raw["name"], at(path, "name"), "name", issues);
  if (name !== undefined) {
    if (taken.has(name)) issues.add(at(path, "name"), "is already used by an earlier endpoint");
    taken.add(name);
  }

  const protocol = raw["protocol"];
  if (typeof protocol !== "string" || !PROTOCOL_IDS.includes(protocol as ProtocolId)) {
    issues.add(at(path, "protocol"), `must be one of ${PROTOCOL_IDS.slice(0, -1).join(", ")} or ${PROTOCOL_IDS.at(-1)}`);
  }

  const problem = pathProblem(raw["path"]);
  if (problem !== undefined) issues.add(at(path, "path"), problem);

  const methodRaw = raw["method"] === undefined ? "GET" : raw["method"];
  const method = typeof methodRaw === "string" ? methodRaw.toUpperCase() : "";
  if (!HTTP_METHODS.includes(method)) issues.add(at(path, "method"), `must be one of ${HTTP_METHODS.join(", ")}`);

  const headers = readHeaders(raw["headers"], at(path, "headers"), issues);
  const body = readBody(raw["body"], method, at(path, "body"), issues);
  const reject = raw["reject"] === undefined ? undefined : readReject(raw["reject"], method, at(path, "reject"), issues);

  let channel: string | undefined;
  let expect: ChannelExpectation | undefined;
  if (raw["channel"] !== undefined) {
    if (protocol !== "mpp-channel") issues.add(at(path, "channel"), "is only for the protocol mpp-channel");
    else if (typeof raw["channel"] === "string" && StrKey.isValidContract(raw["channel"])) channel = raw["channel"];
    else issues.add(at(path, "channel"), "must be a Soroban contract address (C...)");
  }
  if (raw["expect"] !== undefined) {
    if (protocol !== "mpp-channel") issues.add(at(path, "expect"), "is only for the protocol mpp-channel");
    else expect = readExpectation(raw["expect"], at(path, "expect"), issues);
  }

  if (issues.list.length > before || name === undefined) return undefined;
  return {
    name,
    protocol: protocol as ProtocolId,
    path: raw["path"] as string,
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(reject === undefined ? {} : { reject }),
    ...(channel === undefined ? {} : { channel }),
    ...(expect === undefined ? {} : { expect }),
  };
}

// ---------------------------------------------------------------------------
// The file

/**
 * Validates parsed JSON as a version 1 config.
 *
 * @throws {ConfigError} Naming every key that is wrong, never a value.
 */
export function validateConfig(value: unknown): WasitConfig {
  const issues = new Issues();
  if (!isRecord(value)) {
    issues.add("", "must be a JSON object");
    return failWith(issues);
  }

  // First: a secret anywhere. Nothing else is read, so no other message can echo it.
  scanForSecrets(value, "", 0, issues);
  failIfAny(issues);

  checkKeys(value, ["$schema", "version", "service", "defaultEnvironment", "environments", "endpoints"], "", issues);

  const version = value["version"];
  if (version !== CONFIG_VERSION) {
    issues.add(
      "version",
      `this loader reads only version ${CONFIG_VERSION}` +
        (typeof version === "number" && Number.isFinite(version) ? ` (this file says version ${version})` : " and the file must say `\"version\": 1`"),
    );
  }
  if (value["$schema"] !== undefined && (typeof value["$schema"] !== "string" || value["$schema"].length > 200)) {
    issues.add("$schema", "must be a string of at most 200 characters");
  }

  const service = readService(value["service"], issues);

  const environments: Array<[string, EnvironmentConfig]> = [];
  const environmentsRaw = value["environments"];
  if (!isRecord(environmentsRaw) || Object.keys(environmentsRaw).length === 0) {
    issues.add("environments", "must be an object with at least one environment");
  } else {
    for (const [name, raw] of Object.entries(environmentsRaw)) {
      const path = at("environments", name);
      if (readName(name, path, "an environment name", issues) === undefined) continue;
      const environment = readEnvironment(raw, path, issues);
      if (environment !== undefined) environments.push([name, environment]);
    }
  }

  let defaultEnvironment: string | undefined;
  if (value["defaultEnvironment"] !== undefined) {
    const named = value["defaultEnvironment"];
    if (typeof named === "string" && isRecord(environmentsRaw) && Object.hasOwn(environmentsRaw, named)) {
      defaultEnvironment = named;
    } else {
      issues.add("defaultEnvironment", "is not one of the environments");
    }
  }

  const endpoints: EndpointConfig[] = [];
  const endpointsRaw = value["endpoints"];
  if (!Array.isArray(endpointsRaw) || endpointsRaw.length === 0) {
    issues.add("endpoints", "must be a list with at least one endpoint");
  } else if (endpointsRaw.length > MAX_ENDPOINTS) {
    issues.add("endpoints", `must have at most ${MAX_ENDPOINTS} endpoints`);
  } else {
    const taken = new Set<string>();
    endpointsRaw.forEach((raw, index) => {
      const endpoint = readEndpoint(raw, index, taken, issues);
      if (endpoint !== undefined) endpoints.push(endpoint);
    });
  }

  failIfAny(issues);
  return {
    version: CONFIG_VERSION,
    ...(service === undefined ? {} : { service }),
    ...(defaultEnvironment === undefined ? {} : { defaultEnvironment }),
    environments: Object.fromEntries(environments),
    endpoints,
  };
}

function failWith(issues: Issues): never {
  throw new ConfigError(TITLE, issues.list);
}

/**
 * The position of the first syntax error in `text`, if it is not JSON.
 *
 * V8's own message quotes the text around the error, which here could be a
 * secret, so the position is found by a small scanner and the message is not
 * used.
 */
function jsonErrorPosition(text: string): number | undefined {
  let i = 0;
  const fail = (): never => {
    throw i;
  };
  const space = (): void => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i += 1;
  };
  const literal = (word: string): void => {
    if (!text.startsWith(word, i)) fail();
    i += word.length;
  };
  const string = (): void => {
    i += 1;
    for (;;) {
      const char = text[i];
      if (char === undefined || char < " ") fail();
      if (char === '"') {
        i += 1;
        return;
      }
      if (char === "\\") {
        i += 1;
        const escape = text[i];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}/.test(text.slice(i + 1, i + 5))) fail();
          i += 4;
        } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          fail();
        }
      }
      i += 1;
    }
  };
  const number = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
  const value = (depth: number): void => {
    if (depth > 256) fail();
    space();
    const char = text[i];
    if (char === "{") {
      i += 1;
      space();
      if (text[i] === "}") {
        i += 1;
        return;
      }
      for (;;) {
        space();
        if (text[i] !== '"') fail();
        string();
        space();
        if (text[i] !== ":") fail();
        i += 1;
        value(depth + 1);
        space();
        if (text[i] === ",") i += 1;
        else if (text[i] === "}") {
          i += 1;
          return;
        } else fail();
      }
    } else if (char === "[") {
      i += 1;
      space();
      if (text[i] === "]") {
        i += 1;
        return;
      }
      for (;;) {
        value(depth + 1);
        space();
        if (text[i] === ",") i += 1;
        else if (text[i] === "]") {
          i += 1;
          return;
        } else fail();
      }
    } else if (char === '"') {
      string();
    } else if (char === "t") {
      literal("true");
    } else if (char === "f") {
      literal("false");
    } else if (char === "n") {
      literal("null");
    } else {
      number.lastIndex = i;
      if (!number.test(text)) fail();
      i = number.lastIndex;
    }
  };
  try {
    value(0);
    space();
    if (i < text.length) fail();
  } catch (position) {
    return typeof position === "number" ? position : undefined;
  }
  return undefined;
}

/** `line L, column C` of a position in `text`, counting from 1. */
function lineAndColumn(text: string, position: number): string {
  const before = text.slice(0, position);
  const line = before.split("\n").length;
  const column = position - (before.lastIndexOf("\n") + 1) + 1;
  return `line ${line}, column ${column}`;
}

/**
 * Parses config text.
 *
 * @throws {ConfigError} For text that is not JSON (located by line and column, never quoted), or a config that is not valid.
 */
export function parseConfig(text: string): WasitConfig {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    const position = jsonErrorPosition(source);
    throw new ConfigError(TITLE, [
      { path: "", message: `is not valid JSON${position === undefined ? "" : ` (${lineAndColumn(source, position)})`}` },
    ]);
  }
  return validateConfig(value);
}

/**
 * Reads and parses a config file.
 *
 * @throws {ConfigError} For a file that cannot be read, is too large, or is not a valid config.
 */
export function readConfigFile(path: string | URL): WasitConfig {
  const shown = sanitizeText(String(path)).replace(/\s+/g, " ").slice(0, 200);
  let text: string;
  try {
    if (statSync(path).size > MAX_CONFIG_BYTES) {
      throw new ConfigError(TITLE, [{ path: "", message: `${shown} is larger than ${MAX_CONFIG_BYTES / 1024} KiB` }]);
    }
    text = readFileSync(path, "utf-8");
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    const code = (error as { code?: unknown }).code;
    throw new ConfigError(TITLE, [
      { path: "", message: `cannot read ${shown}${typeof code === "string" ? ` (${code})` : ""}` },
    ]);
  }
  return parseConfig(text);
}

// ---------------------------------------------------------------------------
// A run

export interface RunSelection {
  /** `--env`. Else the config's `defaultEnvironment`, else the only environment. */
  readonly environment?: string;
  /** `--endpoint`, by name. Else all, in the config's order. */
  readonly endpoints?: readonly string[];
}

export interface ResolvedReject {
  readonly method?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly note?: string;
}

export interface ResolvedEndpoint {
  readonly name: string;
  readonly protocol: ProtocolId;
  readonly method: string;
  readonly path: string;
  /** `baseUrl` + `path`; always the origin of `baseUrl`. */
  readonly url: string;
  /** The file's headers with `WASIT_HEADER_*` over them. Values are secrets: never print this object. */
  readonly headers: Readonly<Record<string, string>>;
  /** Serialised: a JSON value as JSON, a string verbatim. */
  readonly body?: string;
  /** Exactly what the file says; the check that uses it decides how it applies to the request. */
  readonly reject?: ResolvedReject;
  readonly channel?: string;
  readonly expect?: ChannelExpectation;
}

export interface ResolvedRun {
  readonly environment: string;
  readonly baseUrl: string;
  readonly network: string;
  readonly networkClass: NetworkClass;
  readonly operatedByMe: boolean;
  readonly pinned?: PinConfig;
  /** Full URL: may carry a key. Print only {@link urlOrigin} of it. */
  readonly rpcUrl?: string;
  readonly maxRunUsd?: number;
  readonly service?: ServiceConfig;
  readonly endpoints: readonly ResolvedEndpoint[];
}

function selectEnvironment(config: WasitConfig, requested: string | undefined): string {
  const names = Object.keys(config.environments);
  const list = `the environments are: ${names.join(", ")}`;
  if (requested !== undefined) {
    if (Object.hasOwn(config.environments, requested)) return requested;
    throw new ConfigError("Cannot pick an environment:", [{ path: "--env", message: `no such environment; ${list}` }]);
  }
  if (config.defaultEnvironment !== undefined) return config.defaultEnvironment;
  if (names.length === 1) return names[0]!;
  throw new ConfigError("Cannot pick an environment:", [
    { path: "--env", message: `more than one environment and no defaultEnvironment; pass --env. ${list}` },
  ]);
}

function selectEndpoints(config: WasitConfig, requested: readonly string[] | undefined): readonly EndpointConfig[] {
  if (requested === undefined || requested.length === 0) return config.endpoints;
  const known = new Set(config.endpoints.map((endpoint) => endpoint.name));
  const missing = requested.filter((name) => !known.has(name));
  if (missing.length > 0) {
    throw new ConfigError("Cannot pick endpoints:", [
      {
        path: "--endpoint",
        message: `no endpoint named ${missing.join(", ")}; the endpoints are: ${[...known].join(", ")}`,
      },
    ]);
  }
  const wanted = new Set(requested);
  return config.endpoints.filter((endpoint) => wanted.has(endpoint.name));
}

/** Merges `over` onto `base` by header name, case-insensitively; the name keeps the case of the one that wins. */
function mergeHeaders(base: Readonly<Record<string, string>>, over: Readonly<Record<string, string>>): Record<string, string> {
  const overridden = new Set(Object.keys(over).map((name) => name.toLowerCase()));
  return Object.fromEntries([
    ...Object.entries(base).filter(([name]) => !overridden.has(name.toLowerCase())),
    ...Object.entries(over),
  ]);
}

/**
 * Turns a validated config into what a run uses.
 *
 * Picks the environment and endpoints, joins each path to the base URL, applies
 * the `WASIT_HEADER_*` and `WASIT_RPC_URL` variables of `env` (injected, so a
 * test needs no process state), and serialises bodies.
 *
 * @throws {ConfigError} For an environment or endpoint that does not exist, a bad variable, or a path that could leave the origin.
 */
export function resolveRun(
  config: WasitConfig,
  selection: RunSelection,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedRun {
  const name = selectEnvironment(config, selection.environment);
  const environment = config.environments[name]!;
  const endpoints = selectEndpoints(config, selection.endpoints);
  const fromEnv = headersFromEnv(env);

  let rpcUrl = environment.rpcUrl;
  const override = env["WASIT_RPC_URL"];
  if (override !== undefined && override !== "") {
    const parsed = readHttpUrl(override);
    if ("problem" in parsed) {
      throw new ConfigError("Cannot read the RPC variable:", [{ path: "WASIT_RPC_URL", message: parsed.problem }]);
    }
    rpcUrl = override;
  }

  return {
    environment: name,
    baseUrl: environment.baseUrl,
    network: environment.network,
    networkClass: networkClass(environment.network),
    operatedByMe: environment.operatedByMe,
    ...(environment.pinned === undefined ? {} : { pinned: environment.pinned }),
    ...(rpcUrl === undefined ? {} : { rpcUrl }),
    ...(environment.maxRunUsd === undefined ? {} : { maxRunUsd: environment.maxRunUsd }),
    ...(config.service === undefined ? {} : { service: config.service }),
    endpoints: endpoints.map((endpoint) => ({
      name: endpoint.name,
      protocol: endpoint.protocol,
      method: endpoint.method,
      path: endpoint.path,
      url: joinTarget(environment.baseUrl, endpoint.path),
      headers: mergeHeaders(endpoint.headers, fromEnv),
      ...(endpoint.body === undefined ? {} : { body: serializeBody(endpoint.body) }),
      ...(endpoint.reject === undefined
        ? {}
        : {
            reject: {
              ...(endpoint.reject.method === undefined ? {} : { method: endpoint.reject.method }),
              headers: endpoint.reject.headers,
              ...(endpoint.reject.body === undefined ? {} : { body: serializeBody(endpoint.reject.body) }),
              ...(endpoint.reject.note === undefined ? {} : { note: endpoint.reject.note }),
            },
          }),
      ...(endpoint.channel === undefined ? {} : { channel: endpoint.channel }),
      ...(endpoint.expect === undefined ? {} : { expect: endpoint.expect }),
    })),
  };
}

/** The origin of a URL, which is all of an RPC URL that is ever printed: a key often rides in its path or query. */
export function urlOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : "(not an http URL)";
  } catch {
    return "(not a URL)";
  }
}

const NETWORK_CLASS_LABEL: Readonly<Record<NetworkClass, string>> = {
  test: "test network",
  "mainnet-optin": "mainnet",
  unknown: "network Wasit does not know",
};

/**
 * A short description of a run for a terminal or a log: the environment, base
 * URL, network, the RPC origin and the endpoints. No header value, no pin
 * secret, no RPC path or query. Sanitised.
 */
export function describeRun(run: ResolvedRun): string {
  const lines = [
    `Environment ${run.environment}: ${run.baseUrl}`,
    `Network: ${run.network} (${NETWORK_CLASS_LABEL[run.networkClass]})`,
    ...(run.rpcUrl === undefined ? [] : [`RPC: ${urlOrigin(run.rpcUrl)} (origin only)`]),
    ...(run.maxRunUsd === undefined ? [] : [`Per-run cap: $${run.maxRunUsd}`]),
    `Endpoints: ${run.endpoints.length}`,
    ...run.endpoints.map((endpoint) => `  ${endpoint.name}  ${endpoint.protocol}  ${endpoint.method} ${endpoint.path}`),
  ];
  return sanitizeText(lines.join("\n"));
}
