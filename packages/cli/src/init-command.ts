/**
 * `wasit init`: a `wasit.config.json` for one paid route of a service its
 * operator runs (spec C; W3-2 slices 2 and 3).
 *
 * Every answer is a flag, so the same command works in a script, in
 * PowerShell and in cmd.exe: no answer needs shell quoting (a body comes from
 * a file). The file is written by core's config writer, which takes only data
 * that is certain and checks the result with the validator `wasit run` reads
 * the file with (Najmi, 2026-11-15). What the writer is not given, this
 * command fills from a fixed fallback table (init-skeleton-plan.md section 6),
 * and says so: after writing it prints what it read from the service, what was
 * given, what was filled in by default, and what was NOT read.
 *
 * Reading the route (C2, slice 3) is the default: one unpaid request with the
 * route's method and body (and the `WASIT_HEADER_*` headers `wasit run` would
 * send), one redirect inside the origin at most, no payment, no signature, no
 * key. Its 402 tells x402 from MPP and fills in the protocol, the network, the
 * pin (receiving address and asset) and an MPP channel. A route that answers
 * 200, 500 or 503, or nothing, is said in plain words and nothing is written;
 * `--no-read` writes the route from the flags alone, as x402 (slice 2).
 *
 * The testnet key setup (C4, slice 5, `init-keys.ts`) comes last, for a route
 * on Stellar testnet: with `--setup-keys`, or a yes at a terminal. It writes the
 * key the route's payment checks read into `.env` (never into the config, and
 * never printed) after checking that git will not commit `.env`.
 *
 * Nothing is sent and nothing is written without `--operated-by-me`: Wasit
 * tests only services their operator runs. Every flag is checked before the
 * route is asked anything. An existing config is added to, never overwritten
 * silently; `--force` replaces it. A route it already has exactly as given, in
 * the same environment, is left as it is, byte for byte, and the run goes on
 * (to the key setup): init can be run again on the same route. Mainnet is not written in this version, and
 * nothing that could hold a secret is: an endpoint's headers are not written (a
 * credential goes in `WASIT_HEADER_*`). What the service answered is data:
 * printed through the sanitiser, never followed or run.
 *
 * `executeInit` does not call `process.exit` and does not read the process:
 * the environment and the output are passed in, so it can be tested in-process.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  ConfigError,
  ConfigWriteError,
  ConfigurationError,
  NETWORK_CLASSES,
  chooseOffer,
  deniedEnvValues,
  describeOffer,
  headersFromEnv,
  isLoopbackUrl,
  networkClass,
  parseConfig,
  readRoute,
  sanitizeText,
  writeConfigText,
  type EnvironmentConfig,
  type InitEndpointInput,
  type InitEnvironmentInput,
  type InitRejectInput,
  type InitServiceInput,
  type JsonValue,
  type PinConfig,
  type RouteOffer,
  type RouteProtocol,
} from "@wasit-dev/core";

import {
  GITIGNORE_QUESTION,
  KEY_SETUP_NETWORK,
  keySetupQuestion,
  notSetUpLines,
  otherNetworkLines,
  setUpTestKeys,
  type KeySetupDeps,
} from "./init-keys.js";

export const DEFAULT_CONFIG_FILE = "wasit.config.json";

/** The network written when none is given or read (the fallback table). */
const DEFAULT_NETWORK = "stellar:testnet";

/** The environment written for a URL on this machine when none is given. */
const DEFAULT_ENVIRONMENT = "local";

/** The readiness wait written when `--ready-timeout` is not given: the loader's own default (config.ts, readService). */
const DEFAULT_READY_TIMEOUT_SECONDS = 60;

/** The loader's rule for an endpoint or environment name (config.ts, NAME). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const HTTP_METHODS: readonly string[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** How often init asks for the method at a terminal before it takes the last answer and refuses it (exit 2). */
const METHOD_ATTEMPTS = 3;

const PROTOCOLS: readonly RouteProtocol[] = ["x402", "mpp-charge", "mpp-channel"];

/** The most offers printed: the rest is counted. */
const MAX_OFFER_LINES = 10;

const NO_READ_HINT = "To write the route without reading it, run this again with --no-read.";

export interface InitCommandOptions {
  readonly url?: string;
  readonly operatedByMe: boolean;
  readonly name?: string;
  readonly method?: string;
  readonly bodyFile?: string;
  /** Chooses among the ways the route offers to pay; without reading, the network written. */
  readonly network?: string;
  /** Chooses among the ways the route offers to pay. */
  readonly protocol?: string;
  readonly env?: string;
  readonly start?: string;
  readonly readyUrl?: string;
  readonly readyTimeout?: string;
  /** `Name: value`, repeatable: the headers of the request the route must refuse (X402-11). */
  readonly rejectHeader: readonly string[];
  readonly rejectBodyFile?: string;
  readonly rejectNote?: string;
  readonly config: string;
  readonly force: boolean;
  /** Read the route's 402 (the default); false is `--no-read`: no request, x402 from the flags. */
  readonly read: boolean;
  /**
   * The testnet key setup (C4): true is `--setup-keys`, false `--no-setup-keys`.
   * Undefined: asked at a terminal, else not done.
   */
  readonly setupKeys?: boolean;
}

export interface InitContext {
  /** The `WASIT_HEADER_*` variables the read sends, and the values kept out of every printed line. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** One line at a time, the line break added by the caller. */
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Where relative paths are read from and the config is written. Default: the working directory. */
  readonly cwd?: string;
  /** Tests only: how long the read waits for the route. Index never sets it. */
  readonly readTimeoutMs?: number;
  /**
   * Asks one question and returns the answer. Given only when stdin and stdout
   * are terminals (C1): without it, init asks nothing and names the flags that
   * are missing (C5). Rejects when the input ends.
   */
  readonly ask?: (question: string) => Promise<string>;
  /** The outside world of the key setup (git, Friendbot, Horizon, the key generator). Needed when the key setup runs. */
  readonly keys?: KeySetupDeps;
}

/** A refusal: printed, exit 2, nothing written. */
class InitRefusal extends Error {}

function refuse(message: string): never {
  throw new InitRefusal(message);
}

/** A value for a message: one line, no control characters, bounded, quoted. */
function shown(value: unknown): string {
  const text = sanitizeText(String(value)).replace(/\s+/g, " ");
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}...` : text);
}

function testNetworks(): string {
  return [...NETWORK_CLASSES]
    .filter(([, kind]) => kind === "test")
    .map(([network]) => network)
    .join(", ");
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "an error";
}

/** The route's URL: http(s), no credentials, no fragment. The value typed is never echoed: it may hold a credential. */
function routeUrl(value: string | undefined): URL {
  if (value === undefined || value.trim() === "") {
    refuse(
      "--url is required: the URL of one paid route of your service, e.g. --url http://127.0.0.1:3000/api/weather. " +
        "Nothing was written.",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    refuse("--url is not an absolute URL: include the scheme, e.g. http://127.0.0.1:3000/api/weather. Nothing was written.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    refuse("--url must be an http or https URL. Nothing was written.");
  }
  if (url.username !== "" || url.password !== "") {
    refuse(
      "--url carries credentials (user:password@). The config is committed and its URLs are printed in reports: " +
        "send a credential in a WASIT_HEADER_* variable instead. Nothing was written.",
    );
  }
  if (url.hash !== "") {
    refuse("--url carries a fragment (#...), which is never sent to a service. Leave it out. Nothing was written.");
  }
  return url;
}

/** The last part of the path, when it is a valid name: `/api/weather` gives `weather`. */
function nameFromPath(pathname: string): string | undefined {
  const last = pathname.split("/").filter((part) => part !== "").at(-1);
  return last !== undefined && NAME.test(last) ? last : undefined;
}

function readJsonFile(file: string, flag: string, cwd: string): JsonValue {
  let text: string;
  try {
    text = readFileSync(path.resolve(cwd, file), "utf-8");
  } catch (error) {
    refuse(`${flag}: cannot read ${shown(file)} (${errorCode(error)}). Nothing was written.`);
  }
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(source) as JsonValue;
  } catch {
    refuse(`${flag}: ${shown(file)} is not JSON. The body is written into the config as a JSON value. Nothing was written.`);
  }
}

function rejectHeaders(values: readonly string[]): Record<string, string> | undefined {
  if (values.length === 0) return undefined;
  const headers: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf(":");
    if (separator < 1) refuse(`--reject-header ${shown(value)} is not "Name: value". Nothing was written.`);
    headers[value.slice(0, separator).trim()] = value.slice(separator + 1).trim();
  }
  return headers;
}

/** What the command read, was given, filled in, and did not read: printed after the file is written. */
interface Account {
  readonly read: string[];
  readonly given: string[];
  readonly defaulted: string[];
  readonly notRead: string[];
}

/** The file at the destination, as text, or undefined when there is none. */
function existingText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf-8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    refuse(`cannot read the config ${shown(file)} (${errorCode(error)}). Nothing was written.`);
  }
}

/**
 * The environment the file already has under `name`, as the loader reads it
 * and as the file writes it. A file that is not a valid config is refused here,
 * before the route is asked anything, in the writer's words.
 */
function existingEnvironment(
  text: string | undefined,
  name: string,
): { readonly parsed: EnvironmentConfig; readonly rawBaseUrl: string } | undefined {
  if (text === undefined) return undefined;
  let parsed: EnvironmentConfig | undefined;
  try {
    parsed = parseConfig(text).environments[name];
  } catch (error) {
    const why = error instanceof ConfigError ? error.message : "it is not valid JSON";
    refuse(
      `The config already there is not valid, so init does not change it (${sanitizeText(why).replace(/\s+/g, " ")}). ` +
        "Fix it, or replace it (--force). Nothing was sent and nothing was written.",
    );
  }
  if (parsed === undefined) return undefined;
  const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as {
    environments: Record<string, { baseUrl: string }>;
  };
  return { parsed, rawBaseUrl: raw.environments[name]!.baseUrl };
}

/**
 * The environment, the endpoint's path, and what became of the pin. A new
 * environment's base URL is the route's origin, and it takes the pin read
 * from the route. An environment the file already has is used as it is: the
 * route must be under its base URL and on its network, its pin (or the lack of
 * one) stays, and a route that pays another address than it pins is refused.
 */
function environmentFor(
  name: string,
  url: URL,
  network: string,
  pin: PinConfig | undefined,
  existing: ReturnType<typeof existingEnvironment>,
): { readonly environment: InitEnvironmentInput; readonly path: string; readonly pinLine?: string } {
  const full = url.origin + url.pathname + url.search;
  if (existing === undefined) {
    return {
      environment: { name, baseUrl: url.origin, network, operatedByMe: true, ...(pin === undefined ? {} : { pinned: pin }) },
      path: url.pathname + url.search,
      ...(pin === undefined ? {} : { pinLine: `pinned: payTo ${pin.payTo}, asset ${pin.asset} (wasit run pays only these)` }),
    };
  }
  const { parsed, rawBaseUrl } = existing;
  if (!full.startsWith(`${parsed.baseUrl}/`)) {
    refuse(
      `The config already has the environment ${shown(name)} with the base URL ${shown(parsed.baseUrl)}, and this ` +
        `route is not under it. Name another environment (--env), or replace the file (--force). Nothing was written.`,
    );
  }
  if (parsed.operatedByMe !== true) {
    refuse(
      `The config already has the environment ${shown(name)} without operatedByMe true, and init does not change it. ` +
        `Name another environment (--env), or replace the file (--force). Nothing was written.`,
    );
  }
  if (parsed.network !== network) {
    refuse(
      `The config already has the environment ${shown(name)} on ${shown(parsed.network)}, and this route is written ` +
        `on ${shown(network)}. Name another environment (--env), or replace the file (--force). Nothing was written.`,
    );
  }
  let pinLine: string | undefined;
  if (parsed.pinned !== undefined) {
    if (pin !== undefined && (pin.payTo !== parsed.pinned.payTo || pin.asset !== parsed.pinned.asset)) {
      refuse(
        `The config's environment ${shown(name)} pins payTo ${shown(parsed.pinned.payTo)} and asset ` +
          `${shown(parsed.pinned.asset)}, and this route asks to be paid to ${shown(pin.payTo)} in ${shown(pin.asset)}. ` +
          "init does not change a pin: name another environment (--env), or replace the file (--force). Nothing was written.",
      );
    }
    pinLine = `pin: the environment's own (payTo ${parsed.pinned.payTo}, asset ${parsed.pinned.asset})`;
  } else if (pin !== undefined) {
    pinLine = `no pin added: the environment ${name} is in the config without one, and init does not change it`;
  }
  return {
    environment: {
      name,
      baseUrl: rawBaseUrl,
      network: parsed.network,
      operatedByMe: true,
      ...(parsed.pinned === undefined ? {} : { pinned: parsed.pinned }),
    },
    path: full.slice(parsed.baseUrl.length),
    ...(pinLine === undefined ? {} : { pinLine }),
  };
}

function serviceFor(options: InitCommandOptions, url: URL, account: Account): InitServiceInput | undefined {
  if (options.start === undefined) {
    if (options.readyUrl !== undefined || options.readyTimeout !== undefined) {
      refuse(
        `${options.readyUrl !== undefined ? "--ready-url" : "--ready-timeout"} is for the wait after the service starts: ` +
          "give the command that starts it as well (--start). Nothing was written.",
      );
    }
    return undefined;
  }
  account.given.push(`start: ${options.start}`);

  let readyUrl: string;
  if (options.readyUrl !== undefined) {
    readyUrl = options.readyUrl;
    account.given.push(`ready url: ${readyUrl}`);
  } else if (isLoopbackUrl(url.href)) {
    readyUrl = url.href;
    account.defaulted.push(`ready url: ${readyUrl} (the route's own URL)`);
  } else {
    refuse(
      "--start needs --ready-url when the route is not on this machine: the address on this machine (localhost, " +
        "127.x.x.x or [::1]) the run waits for after starting the service. Nothing was written.",
    );
  }

  let timeoutSeconds = DEFAULT_READY_TIMEOUT_SECONDS;
  if (options.readyTimeout !== undefined) {
    const value = Number(options.readyTimeout);
    if (!/^\d+$/.test(options.readyTimeout) || value < 1 || value > 600) {
      refuse("--ready-timeout must be a whole number of seconds from 1 to 600. Nothing was written.");
    }
    timeoutSeconds = value;
    account.given.push(`ready timeout: ${timeoutSeconds} s`);
  } else {
    account.defaulted.push(`ready timeout: ${timeoutSeconds} s`);
  }
  return { start: options.start, ready: { url: readyUrl, timeoutSeconds } };
}

function rejectFor(options: InitCommandOptions, cwd: string, account: Account): InitRejectInput | undefined {
  const headers = rejectHeaders(options.rejectHeader);
  const body = options.rejectBodyFile === undefined ? undefined : readJsonFile(options.rejectBodyFile, "--reject-body-file", cwd);
  if (headers === undefined && body === undefined) {
    if (options.rejectNote !== undefined) {
      refuse("--reject-note describes the request the route must refuse: give --reject-header or --reject-body-file. Nothing was written.");
    }
    return undefined;
  }
  account.given.push(
    `request to refuse: ${[
      ...(headers === undefined ? [] : [`headers ${Object.keys(headers).join(", ")}`]),
      ...(body === undefined ? [] : [`body from ${options.rejectBodyFile}`]),
    ].join(" and ")}`,
  );
  return {
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
    ...(options.rejectNote === undefined ? {} : { note: options.rejectNote }),
  };
}

/** `--protocol` and `--network`, checked before anything is sent. */
function wantedFlags(options: InitCommandOptions): { readonly protocol?: RouteProtocol; readonly network?: string } {
  if (options.protocol !== undefined && !PROTOCOLS.includes(options.protocol as RouteProtocol)) {
    refuse(`--protocol ${shown(options.protocol)} is not one of ${PROTOCOLS.join(", ")}. Nothing was written.`);
  }
  if (options.network !== undefined) {
    const kind = networkClass(options.network);
    if (kind !== "test") {
      refuse(
        `--network ${shown(options.network)} is ${kind === "mainnet-optin" ? "Stellar mainnet, which init does not write in this version" : "not on Wasit's list of test networks"}. ` +
          `init writes one of: ${testNetworks()}. Nothing was written.`,
      );
    }
  }
  return {
    ...(options.protocol === undefined ? {} : { protocol: options.protocol as RouteProtocol }),
    ...(options.network === undefined ? {} : { network: options.network }),
  };
}

/** The way to pay written for the route, and the URL it answered on. */
interface Route {
  readonly protocol: RouteProtocol;
  readonly network: string;
  readonly url: URL;
  readonly pin?: PinConfig;
  readonly channel?: string;
}

/** The network of an x402 route whose network was not read: the flag, the environment's, or the default. */
function unreadNetwork(
  options: InitCommandOptions,
  existing: ReturnType<typeof existingEnvironment>,
  environmentName: string,
  account: Account,
  why: string,
): string {
  if (options.network !== undefined) {
    account.given.push(`network: ${options.network}`);
    return options.network;
  }
  if (existing !== undefined) {
    account.defaulted.push(`network: ${existing.parsed.network} (the environment ${environmentName} in the config is on it)`);
    return existing.parsed.network;
  }
  account.defaulted.push(`network: ${DEFAULT_NETWORK} (default; ${why})`);
  return DEFAULT_NETWORK;
}

/** `--no-read` (slice 2): no request; x402 on the network the flags, the environment or the default give. */
function routeFromFlags(
  options: InitCommandOptions,
  url: URL,
  existing: ReturnType<typeof existingEnvironment>,
  environmentName: string,
  account: Account,
): Route {
  if (options.protocol !== undefined && options.protocol !== "x402") {
    refuse(
      "Without reading the route (--no-read), init writes x402 only: an MPP route is written from its challenge. " +
        "Leave out --no-read. Nothing was written.",
    );
  }
  account.given.push("read the route: no (--no-read)");
  const network = unreadNetwork(options, existing, environmentName, account, "init does not read the network from your service");
  if (options.protocol === undefined) account.defaulted.push("protocol: x402 (without reading the route, init writes x402 only)");
  else account.given.push("protocol: x402");
  account.notRead.push(
    "whether the route answers 402, and its protocol, network, price, asset and receiving address: " +
      "wasit run --read-only reads them",
  );
  return { protocol: "x402", network, url };
}

function offerLines(label: string, offers: readonly RouteOffer[], room: number): string[] {
  const lines = offers.slice(0, Math.max(0, room)).map((offer) => `${label}: ${describeOffer(offer)}`);
  const more = offers.length - lines.length;
  return more > 0 ? [...lines, `${label}: ${more} more`] : lines;
}

/** Why a status that is not 402 is not a paywall, in plain words. */
function statusMessage(status: number): string {
  if (status === 200) return "The paywall is not switched on: the route answered 200 without asking for payment.";
  if (status === 500 || status === 503) {
    return (
      `The paywall is not switched on or is misconfigured: the route answered ${status} instead of 402. A missing ` +
      "payee or facilitator setting often answers this way: check the service's payment settings and its log."
    );
  }
  const hint =
    status === 404
      ? ": check the path, and the method (--method)"
      : status === 405
        ? ": check the method (--method)"
        : status === 401 || status === 403
          ? ": it may need a credential, which init sends from a WASIT_HEADER_<NAME> variable, as wasit run does"
          : "";
  return `The route answered ${status}, not 402${hint}.`;
}

/** Slice 3: one unpaid request, and the way to pay its 402 offers. */
async function routeFromReading(
  options: InitCommandOptions,
  context: InitContext,
  url: URL,
  method: string,
  body: JsonValue | undefined,
  existing: ReturnType<typeof existingEnvironment>,
  environmentName: string,
  wanted: { readonly protocol?: RouteProtocol; readonly network?: string },
  account: Account,
): Promise<Route> {
  let headers: Record<string, string>;
  try {
    headers = headersFromEnv(context.env);
  } catch (error) {
    if (error instanceof ConfigError) refuse(`${error.message} Nothing was sent and nothing was written.`);
    throw error;
  }
  const headerNames = Object.keys(headers);
  const sent = `${method} ${url.href}`;

  let reading;
  try {
    reading = await readRoute(
      url.href,
      {
        method,
        ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
        ...(headerNames.length === 0 ? {} : { headers }),
      },
      context.readTimeoutMs === undefined ? {} : { timeoutMs: context.readTimeoutMs },
    );
  } catch (error) {
    if (error instanceof ConfigurationError) refuse(`${error.message} Nothing was written.`);
    throw error;
  }

  switch (reading.kind) {
    case "unreachable":
      refuse(`init sent ${sent} and got no answer. ${reading.message} Start the service and run this again. ${NO_READ_HINT} Nothing was written.`);
    case "redirect":
      refuse(`init sent ${sent}. ${reading.message} Nothing was written.`);
    case "status":
      refuse(`init sent ${sent}. ${statusMessage(reading.status)} Nothing was written. ${NO_READ_HINT}`);
    case "unreadable":
      refuse(
        [
          `init sent ${sent}. The route answered 402, and init could not read how it asks to be paid:`,
          ...reading.notes.map((note) => `  ${note}`),
          `${NO_READ_HINT} It is then written as x402, and wasit run --read-only reports what it finds. Nothing was written.`,
        ].join("\n"),
      );
    default:
      break;
  }

  account.read.push(
    `one unpaid request: ${sent}` +
      `${headerNames.length === 0 ? "" : ` with the WASIT_HEADER_* headers ${headerNames.join(", ")} (values not shown)`}` +
      "; nothing was paid or signed",
  );
  const answered = new URL(reading.url);
  if (answered.href !== url.href) {
    account.read.push(`the route redirected once inside its origin, to ${answered.pathname}${answered.search}: init wrote that path`);
  }
  if (wanted.protocol !== undefined) account.given.push(`protocol: ${wanted.protocol}`);

  if (reading.kind === "x402-v1") {
    if (wanted.protocol !== undefined && wanted.protocol !== "x402") {
      refuse(`init sent ${sent}. The route answered with an x402 v1 challenge, not ${wanted.protocol}. Nothing was written.`);
    }
    account.read.push(
      "answer: 402 with an x402 v1 challenge in the body. Wasit grades x402 v2 only: wasit run reports this route " +
        "as unsupported, not failed, and says how to move it to v2",
      "written: protocol x402",
    );
    const network = unreadNetwork(options, existing, environmentName, account, "init does not read the network from an x402 v1 challenge");
    return { protocol: "x402", network, url: answered };
  }

  // A network the environment in the file is on chooses among the offers, when the route offers it.
  const envNetwork = existing?.parsed.network;
  const network =
    wanted.network ?? (envNetwork !== undefined && reading.offers.some((offer) => offer.network === envNetwork) ? envNetwork : undefined);
  const choice = chooseOffer(reading.offers, { ...(wanted.protocol === undefined ? {} : { protocol: wanted.protocol }), ...(network === undefined ? {} : { network }) });
  if (!choice.ok) {
    refuse(
      [
        `init sent ${sent}. ${choice.reason}`,
        ...offerLines("  offered", reading.offers, MAX_OFFER_LINES),
        "Nothing was written.",
      ].join("\n"),
    );
  }
  if (wanted.network !== undefined) account.given.push(`network: ${wanted.network}`);

  const headersSeen = [
    ...(reading.offers.some((offer) => offer.protocol === "x402") ? ["a PAYMENT-REQUIRED header (x402)"] : []),
    ...(reading.offers.some((offer) => offer.protocol !== "x402") ? ["a WWW-Authenticate challenge (MPP)"] : []),
  ];
  account.read.push(
    `answer: 402 with ${headersSeen.join(" and ")}`,
    ...offerLines("offered", choice.offers, MAX_OFFER_LINES),
    ...offerLines("also offered, not written", choice.left, MAX_OFFER_LINES - choice.offers.length),
    ...reading.notes.map((note) => `note: ${note}`),
    `written: protocol ${choice.protocol}, network ${choice.network}`,
    ...(choice.channel === undefined ? [] : [`channel: ${choice.channel}`]),
    ...(choice.noPin === undefined ? [] : [`no pin: ${choice.noPin}`]),
  );
  return {
    protocol: choice.protocol,
    network: choice.network,
    url: answered,
    ...(choice.pin === undefined ? {} : { pin: choice.pin }),
    ...(choice.channel === undefined ? {} : { channel: choice.channel }),
  };
}

/** The shortest value of a secret variable the file check looks for: a shorter one would match by chance. */
const MIN_SECRET_LENGTH = 8;

/**
 * Whether the new text holds the value of a variable Wasit keeps secret (a
 * key, a `WASIT_HEADER_*` value, `WASIT_RPC_URL`) that the file did not hold
 * before. The config is committed: a value of those must never reach it, from
 * a flag or from the route's challenge.
 */
function writesSecret(text: string, before: string | undefined, env: Readonly<Record<string, string | undefined>>): boolean {
  return deniedEnvValues(env).some((value) => {
    if (value.length < MIN_SECRET_LENGTH) return false;
    const escaped = JSON.stringify(value).slice(1, -1);
    return [value, escaped].some((form) => text.includes(form) && !(before ?? "").includes(form));
  });
}

/** The flags a non-interactive run is missing, or the questions an interactive one asks: C1 and C5. */
async function completeAnswers(options: InitCommandOptions, context: InitContext): Promise<InitCommandOptions> {
  const ask = context.ask;
  if (ask === undefined) {
    if (options.url === undefined && !options.operatedByMe) {
      refuse(
        "--url is required (the URL of one paid route, e.g. --url http://127.0.0.1:3000/api/weather), and so is " +
          "--operated-by-me: Wasit tests only services their operator runs. init asks nothing when it is not at a " +
          "terminal. Nothing was written.",
      );
    }
    return options;
  }
  const answer = async (question: string): Promise<string> => {
    try {
      return (await ask(question)).trim();
    } catch {
      refuse("init was asking, and the input ended. Nothing was sent and nothing was written.");
    }
  };
  let url = options.url;
  if (url === undefined) url = await answer("URL of one paid route of your service (e.g. http://127.0.0.1:3000/api/weather): ");
  let operatedByMe = options.operatedByMe;
  if (!operatedByMe) {
    const reply = (await answer("Do you operate this service? Wasit tests only services their operator runs (yes/no): ")).toLowerCase();
    operatedByMe = reply === "yes" || reply === "y";
  }
  // A URL that is not usable, or a service that is not theirs: no more questions; the main path refuses in its own words.
  if (!operatedByMe) return { ...options, ...(url === undefined || url === "" ? {} : { url }), operatedByMe };
  routeUrl(url === "" ? undefined : url);
  let method = options.method;
  if (method === undefined) {
    // A method that is not one of ours is asked again, a few times: a typo costs a retry, not the whole run.
    let question = "HTTP method of the route [GET]: ";
    for (let attempt = 1; attempt <= METHOD_ATTEMPTS; attempt += 1) {
      const reply = await answer(question);
      if (reply === "") break;
      method = reply;
      if (HTTP_METHODS.includes(reply.toUpperCase())) break;
      // The last try is wrong too: refuse here, in the main path's words, before any other question.
      if (attempt === METHOD_ATTEMPTS) refuse(`--method ${shown(reply)} is not one of ${HTTP_METHODS.join(", ")}. Nothing was written.`);
      question = `${shown(reply)} is not one of ${HTTP_METHODS.join(", ")}. HTTP method of the route [GET]: `;
    }
  }
  let bodyFile = options.bodyFile;
  if (bodyFile === undefined && method !== undefined && !["GET", "HEAD"].includes(method.toUpperCase())) {
    const reply = await answer("JSON file with the request body (empty for none): ");
    if (reply !== "") bodyFile = reply;
  }
  let env = options.env;
  if (env === undefined && url !== "") {
    let loopback = true;
    try {
      loopback = isLoopbackUrl(new URL(url).href);
    } catch {
      // routeUrl refuses a URL that does not parse, in its own words.
    }
    if (!loopback) {
      const reply = await answer("Name for this environment (e.g. staging): ");
      if (reply !== "") env = reply;
    }
  }
  let start = options.start;
  if (start === undefined) {
    const reply = await answer("Command that starts the service for wasit run --start (empty for none): ");
    if (reply !== "") start = reply;
  }
  return {
    ...options,
    ...(url === undefined || url === "" ? {} : { url }),
    operatedByMe,
    ...(method === undefined ? {} : { method }),
    ...(bodyFile === undefined ? {} : { bodyFile }),
    ...(env === undefined ? {} : { env }),
    ...(start === undefined ? {} : { start }),
  };
}

/** A yes or a no at the terminal, before the config is written: input that ends is a refusal. */
async function askYes(ask: (question: string) => Promise<string>, question: string): Promise<boolean> {
  let reply: string;
  try {
    reply = await ask(question);
  } catch {
    refuse("init was asking, and the input ended. Nothing was written.");
  }
  const word = reply.trim().toLowerCase();
  return word === "yes" || word === "y";
}

/**
 * Whether the key setup runs for a route on the key setup's network: the flag,
 * else the answer at a terminal (C1 step 8), else no (C5).
 */
async function keySetupWanted(
  options: InitCommandOptions,
  context: InitContext,
  protocol: RouteProtocol,
  account: Account,
): Promise<{ readonly run: boolean; readonly why: string }> {
  if (options.setupKeys === true) {
    account.given.push("key setup: yes (--setup-keys)");
    return { run: true, why: "--setup-keys" };
  }
  if (options.setupKeys === false) {
    account.given.push("key setup: no (--no-setup-keys)");
    return { run: false, why: "--no-setup-keys" };
  }
  if (context.ask === undefined) {
    return { run: false, why: "init sets one up only with --setup-keys, or a yes at a terminal" };
  }
  const yes = await askYes(context.ask, keySetupQuestion(protocol));
  account.given.push(`key setup: ${yes ? "yes" : "no"} (your answer)`);
  return { run: yes, why: yes ? "your answer" : "you said no" };
}

/** A path for the next command: quoted when it has a space, which both PowerShell and cmd.exe read. */
function commandArgument(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * Runs `wasit init`. Returns the exit code: 0 the file has the route (written
 * now, or already there as given and left as it is); 2 nothing was written (a
 * flag is missing or wrong, the service is not yours, the route is not a
 * paywall init can read, or the writer refused the data). The key setup runs
 * after the file is written and never changes the exit code: what
 * it could not do is in its status table, with the command that finishes it
 * (Najmi, 2026-11-27).
 */
export async function executeInit(given: InitCommandOptions, context: InitContext): Promise<number> {
  // A key the key setup makes is added here: no printed line may carry it.
  const secrets: string[] = [...deniedEnvValues(context.env)];
  const clean = (line: string): string => sanitizeText(line, { redact: secrets });
  const cwd = context.cwd ?? process.cwd();

  try {
    const options = await completeAnswers(given, context);
    const url = routeUrl(options.url);
    if (!options.operatedByMe) {
      refuse(
        `Wasit tests only services their operator runs. If you operate the service at ${url.origin}, run this again ` +
          "with --operated-by-me. Nothing was sent and nothing was written.",
      );
    }
    const account: Account = {
      read: [],
      given: [`url: ${url.href}`, "operated by you: yes (--operated-by-me)"],
      defaulted: [],
      notRead: [],
    };

    const method = (options.method ?? "GET").toUpperCase();
    if (!HTTP_METHODS.includes(method)) {
      refuse(`--method ${shown(options.method)} is not one of ${HTTP_METHODS.join(", ")}. Nothing was written.`);
    }
    if (options.method === undefined) account.defaulted.push("method: GET");
    else account.given.push(`method: ${method}`);

    const body = options.bodyFile === undefined ? undefined : readJsonFile(options.bodyFile, "--body-file", cwd);
    if (body !== undefined) {
      if (method === "GET" || method === "HEAD") {
        refuse(`A request body cannot be sent with ${method}: name the method the route uses, e.g. --method POST. Nothing was written.`);
      }
      account.given.push(`body: from ${options.bodyFile}`);
    }

    let name: string;
    if (options.name !== undefined) {
      if (!NAME.test(options.name)) {
        refuse("--name must be 1 to 64 letters, digits, dots, underscores or hyphens, starting with a letter or digit. Nothing was written.");
      }
      name = options.name;
      account.given.push(`name: ${name}`);
    } else {
      const derived = nameFromPath(url.pathname);
      if (derived === undefined) {
        refuse(
          "init could not take a name from the route's path: give one with --name (1 to 64 letters, digits, dots, " +
            "underscores or hyphens). Nothing was written.",
        );
      }
      name = derived;
      account.defaulted.push(`name: ${name} (from the path)`);
    }

    let environmentName: string;
    if (options.env !== undefined) {
      if (!NAME.test(options.env)) {
        refuse("--env must be 1 to 64 letters, digits, dots, underscores or hyphens, starting with a letter or digit. Nothing was written.");
      }
      environmentName = options.env;
      account.given.push(`environment: ${environmentName}`);
    } else if (isLoopbackUrl(url.href)) {
      environmentName = DEFAULT_ENVIRONMENT;
      account.defaulted.push(`environment: ${environmentName} (the URL is on this machine)`);
    } else {
      refuse("The route is not on this machine: name its environment with --env, e.g. --env staging. Nothing was written.");
    }

    const service = serviceFor(options, url, account);
    const reject = rejectFor(options, cwd, account);
    const wanted = wantedFlags(options);

    const configPath = path.resolve(cwd, options.config);
    const before = existingText(configPath);
    const existing = options.force ? undefined : existingEnvironment(before, environmentName);

    // Every flag has been checked: only now is the route asked anything.
    const route = options.read
      ? await routeFromReading(options, context, url, method, body, existing, environmentName, wanted, account)
      : routeFromFlags(options, url, existing, environmentName, account);

    if (route.protocol !== "x402") {
      if (method !== "GET") {
        refuse(
          `The route answers with an MPP challenge, and wasit run sends an MPP endpoint a plain GET in this version: ` +
            `this route was read with ${method}. Nothing was written.`,
        );
      }
      if (reject !== undefined) {
        refuse("--reject-header and --reject-body-file are for x402 (X402-11): an MPP endpoint has no request to refuse. Nothing was written.");
      }
      if (Object.keys(headersFromEnv(context.env)).length > 0) {
        account.notRead.push(
          "wasit run sends an MPP endpoint a plain GET without headers: while a WASIT_HEADER_* variable is set, it sends this endpoint nothing",
        );
      }
      if (route.protocol === "mpp-channel") {
        account.notRead.push("the channel's on-chain terms (expect: token, from, to, refundWaitingPeriod), which its challenge does not carry");
      }
    } else if (reject === undefined) {
      account.notRead.push("a request this route must refuse: X402-11 runs only with one (--reject-header or --reject-body-file)");
    }

    const { environment, path: endpointPath, pinLine } = environmentFor(environmentName, route.url, route.network, route.pin, existing);
    if (pinLine !== undefined) account.read.push(pinLine);
    const endpoint: InitEndpointInput = {
      name,
      protocol: route.protocol,
      path: endpointPath,
      method,
      ...(body === undefined ? {} : { body }),
      ...(reject === undefined ? {} : { reject }),
      ...(route.channel === undefined ? {} : { channel: route.channel }),
    };

    let result;
    try {
      result = writeConfigText(
        { environment, endpoints: [endpoint], ...(service === undefined ? {} : { service }) },
        { ...(before === undefined ? {} : { existing: before }), replace: options.force },
      );
    } catch (error) {
      if (error instanceof ConfigWriteError) refuse(error.message);
      throw error;
    }

    if (writesSecret(result.text, before, context.env)) {
      refuse(
        "init would write the value of a variable Wasit keeps secret (a key, a WASIT_HEADER_* value or WASIT_RPC_URL) " +
          "into the config, which is committed. It came from a flag (--start, --reject-header, a body file) or from " +
          "the route's challenge. Nothing was written.",
      );
    }

    // C1 step 8: asked after the read, when the network is known, and before anything is written.
    const keyStep =
      route.network === KEY_SETUP_NETWORK ? await keySetupWanted(options, context, route.protocol, account) : undefined;
    if (keyStep === undefined && options.setupKeys === true) {
      account.given.push(`key setup: --setup-keys (init sets up keys on ${KEY_SETUP_NETWORK} only)`);
    }
    const keys = context.keys;
    if (keyStep?.run === true && keys === undefined) throw new Error("the key setup was asked for, and init was given no way to run it");

    // A file that already holds this route as given is left as it is, byte for byte (run again to set up the key, say).
    if (result.changed) {
      try {
        writeFileSync(configPath, result.text, { flag: before === undefined ? "wx" : "w" });
      } catch (error) {
        refuse(`cannot write the config ${shown(options.config)} (${errorCode(error)}). Nothing was written.`);
      }
    }

    const shownFile = options.config;
    const lines: string[] = [];
    if (!result.changed) {
      lines.push(
        `wasit init: ${shownFile} already has the endpoint ${name} as given, in the environment ${environmentName}: ` +
          "the file was left as it is.",
      );
    } else if (before === undefined) {
      lines.push(`wasit init: wrote ${shownFile}: the environment ${environmentName} and the endpoint ${name}.`);
    } else if (options.force) {
      lines.push(`wasit init: replaced ${shownFile} (--force): the environment ${environmentName} and the endpoint ${name}.`);
    } else {
      lines.push(
        `wasit init: added the endpoint ${name} to ${shownFile}` +
          `${result.environmentAdded ? `, with the new environment ${environmentName}` : `, in the environment ${environmentName}`}` +
          `${service !== undefined && !result.serviceAdded ? " (its start command was already there)" : ""}.`,
      );
    }
    if (account.read.length > 0) lines.push("Read from your service:", ...account.read.map((line) => `  ${line}`));
    lines.push("You gave:", ...account.given.map((line) => `  ${line}`));
    if (account.defaulted.length > 0) lines.push("Filled in by default:", ...account.defaulted.map((line) => `  ${line}`));
    if (account.notRead.length > 0) lines.push("Not read from your service:", ...account.notRead.map((line) => `  ${line}`));

    for (const line of lines) context.stdout(clean(line));

    // The config is written: from here on nothing refuses, and what the key setup could not do is a line (exit 0).
    if (keyStep === undefined) {
      for (const line of otherNetworkLines(route.network, route.protocol)) context.stdout(clean(line));
    } else if (!keyStep.run || keys === undefined) {
      for (const line of notSetUpLines(route.protocol, keyStep.why)) context.stdout(clean(line));
    } else {
      const ask = context.ask;
      await setUpTestKeys(
        {
          network: route.network,
          protocol: route.protocol,
          ...(route.channel === undefined ? {} : { channel: route.channel }),
          ...(route.pin === undefined ? {} : { asset: route.pin.asset }),
          cwd,
          env: context.env,
          // --setup-keys answers this one too; at a terminal it is asked, and input that ends is a no.
          allowGitignore:
            options.setupKeys === true || ask === undefined
              ? async () => true
              : async () => {
                  try {
                    const word = (await ask(GITIGNORE_QUESTION)).trim().toLowerCase();
                    return word === "yes" || word === "y";
                  } catch {
                    return false;
                  }
                },
          say: (line) => context.stdout(clean(line)),
          redact: (value) => secrets.push(value),
        },
        keys,
      );
    }

    const written = parseConfig(result.text);
    const runsByDefault =
      written.defaultEnvironment === environmentName ||
      (written.defaultEnvironment === undefined && Object.keys(written.environments).length === 1);
    const next = [
      route.protocol === "x402" ? "wasit run --read-only" : "wasit run --dry-run",
      ...(options.config === DEFAULT_CONFIG_FILE ? [] : [`--config ${commandArgument(options.config)}`]),
      ...(runsByDefault ? [] : [`--env ${environmentName}`]),
    ].join(" ");
    context.stdout(clean(`Next: ${next}`));
    if (route.protocol !== "x402") {
      context.stdout(clean("  (MPP has no read-only checks: the dry run prints what the payment tier would do, and signs nothing.)"));
    }
    return 0;
  } catch (error) {
    if (error instanceof InitRefusal) {
      context.stderr(clean(`wasit init: ${error.message}`));
      return 2;
    }
    throw error;
  }
}
