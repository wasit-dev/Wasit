/**
 * `wasit init`: a `wasit.config.json` for one paid route of a service its
 * operator runs (spec C; W3-2 slice 2, the flags).
 *
 * Every answer is a flag, so the same command works in a script, in
 * PowerShell and in cmd.exe: no answer needs shell quoting (a body comes from
 * a file). The file is written by core's config writer, which takes only data
 * that is certain and checks the result with the validator `wasit run` reads
 * the file with (Najmi, 2026-11-15). What the writer is not given, this
 * command fills from a fixed fallback table (init-skeleton-plan.md section 6),
 * and says so: after writing it prints what was given, what was filled in by
 * default, and what was NOT read from the service.
 *
 * Nothing is sent and nothing is written without `--operated-by-me`: Wasit
 * tests only services their operator runs. An existing config is added to,
 * never overwritten silently; `--force` replaces it. Mainnet is not written in
 * this version, and nothing that could hold a secret is: an endpoint's headers
 * are not written (a credential goes in `WASIT_HEADER_*`).
 *
 * `executeInit` does not call `process.exit` and does not read the process:
 * the environment and the output are passed in, so it can be tested in-process.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  ConfigWriteError,
  NETWORK_CLASSES,
  deniedEnvValues,
  isLoopbackUrl,
  networkClass,
  parseConfig,
  sanitizeText,
  writeConfigText,
  type EnvironmentConfig,
  type InitEndpointInput,
  type InitEnvironmentInput,
  type InitRejectInput,
  type InitServiceInput,
  type JsonValue,
} from "@wasit-dev/core";

export const DEFAULT_CONFIG_FILE = "wasit.config.json";

/** The network written when none is given (the fallback table). */
const DEFAULT_NETWORK = "stellar:testnet";

/** The environment written for a URL on this machine when none is given. */
const DEFAULT_ENVIRONMENT = "local";

/** The readiness wait written when `--ready-timeout` is not given: the loader's own default (config.ts, readService). */
const DEFAULT_READY_TIMEOUT_SECONDS = 60;

/** The loader's rule for an endpoint or environment name (config.ts, NAME). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const HTTP_METHODS: readonly string[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export interface InitCommandOptions {
  readonly url?: string;
  readonly operatedByMe: boolean;
  readonly name?: string;
  readonly method?: string;
  readonly bodyFile?: string;
  readonly network?: string;
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
}

export interface InitContext {
  /** For the values kept out of every printed line. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** One line at a time, the line break added by the caller. */
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Where relative paths are read from and the config is written. Default: the working directory. */
  readonly cwd?: string;
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

/** What the command was given, filled in, and did not read: printed after the file is written. */
interface Account {
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

/** The environment the file already has under `name`, as the loader reads it and as the file writes it. */
function existingEnvironment(
  text: string | undefined,
  name: string,
): { readonly parsed: EnvironmentConfig; readonly rawBaseUrl: string } | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed = parseConfig(text).environments[name];
    if (parsed === undefined) return undefined;
    const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as {
      environments: Record<string, { baseUrl: string }>;
    };
    return { parsed, rawBaseUrl: raw.environments[name]!.baseUrl };
  } catch {
    // Not a valid config: the writer refuses it and says why.
    return undefined;
  }
}

/**
 * The environment and the endpoint's path. A new environment's base URL is
 * the route's origin. An environment the file already has is used as it is:
 * the route must be under its base URL and on its network, and nothing in it
 * changes.
 */
function environmentFor(
  name: string,
  url: URL,
  network: string,
  existing: ReturnType<typeof existingEnvironment>,
): { readonly environment: InitEnvironmentInput; readonly path: string } {
  const full = url.origin + url.pathname + url.search;
  if (existing === undefined) {
    return {
      environment: { name, baseUrl: url.origin, network, operatedByMe: true },
      path: url.pathname + url.search,
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
  return {
    environment: {
      name,
      baseUrl: rawBaseUrl,
      network: parsed.network,
      operatedByMe: true,
      ...(parsed.pinned === undefined ? {} : { pinned: parsed.pinned }),
    },
    path: full.slice(parsed.baseUrl.length),
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

/** The shortest value of a secret variable the file check looks for: a shorter one would match by chance. */
const MIN_SECRET_LENGTH = 8;

/**
 * Whether the new text holds the value of a variable Wasit keeps secret (a
 * key, a `WASIT_HEADER_*` value, `WASIT_RPC_URL`) that the file did not hold
 * before. The config is committed: a value of those must never reach it.
 */
function writesSecret(text: string, before: string | undefined, env: Readonly<Record<string, string | undefined>>): boolean {
  return deniedEnvValues(env).some((value) => {
    if (value.length < MIN_SECRET_LENGTH) return false;
    const escaped = JSON.stringify(value).slice(1, -1);
    return [value, escaped].some((form) => text.includes(form) && !(before ?? "").includes(form));
  });
}

/** A path for the next command: quoted when it has a space, which both PowerShell and cmd.exe read. */
function commandArgument(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * Runs `wasit init`. Returns the exit code: 0 the file was written; 2 nothing
 * was written (a flag is missing or wrong, the service is not yours, or the
 * writer refused the data).
 */
export async function executeInit(options: InitCommandOptions, context: InitContext): Promise<number> {
  const secrets = deniedEnvValues(context.env);
  const clean = (line: string): string => sanitizeText(line, { redact: secrets });
  const cwd = context.cwd ?? process.cwd();

  try {
    const url = routeUrl(options.url);
    if (!options.operatedByMe) {
      refuse(
        `Wasit tests only services their operator runs. If you operate the service at ${url.origin}, run this again ` +
          "with --operated-by-me. Nothing was sent and nothing was written.",
      );
    }
    const account: Account = { given: [`url: ${url.href}`, "operated by you: yes (--operated-by-me)"], defaulted: [], notRead: [] };

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

    const configPath = path.resolve(cwd, options.config);
    const before = existingText(configPath);
    const existing = options.force ? undefined : existingEnvironment(before, environmentName);

    let network: string;
    if (options.network !== undefined) {
      const kind = networkClass(options.network);
      if (kind !== "test") {
        refuse(
          `--network ${shown(options.network)} is ${kind === "mainnet-optin" ? "Stellar mainnet, which init does not write in this version" : "not on Wasit's list of test networks"}. ` +
            `init writes one of: ${testNetworks()}. Nothing was written.`,
        );
      }
      network = options.network;
      account.given.push(`network: ${network}`);
    } else if (existing !== undefined) {
      network = existing.parsed.network;
      account.defaulted.push(`network: ${network} (the environment ${environmentName} in the config is on it)`);
    } else {
      network = DEFAULT_NETWORK;
      account.defaulted.push(`network: ${network} (default; init does not read the network from your service)`);
    }
    account.defaulted.push("protocol: x402 (without reading the route, init writes x402 only)");
    account.notRead.push(
      "whether the route answers 402, and its protocol, network, price, asset and receiving address: " +
        "wasit run --read-only reads them",
    );

    const { environment, path: endpointPath } = environmentFor(environmentName, url, network, existing);
    const endpoint: InitEndpointInput = {
      name,
      protocol: "x402",
      path: endpointPath,
      method,
      ...(body === undefined ? {} : { body }),
      ...(reject === undefined ? {} : { reject }),
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
          "into the config, which is committed. It came from a flag (--start, --reject-header, a body file). " +
          "Nothing was written.",
      );
    }

    try {
      writeFileSync(configPath, result.text, { flag: before === undefined ? "wx" : "w" });
    } catch (error) {
      refuse(`cannot write the config ${shown(options.config)} (${errorCode(error)}). Nothing was written.`);
    }

    const shownFile = options.config;
    const lines: string[] = [];
    if (before === undefined) {
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
    lines.push("You gave:", ...account.given.map((line) => `  ${line}`));
    if (account.defaulted.length > 0) lines.push("Filled in by default:", ...account.defaulted.map((line) => `  ${line}`));
    if (account.notRead.length > 0) lines.push("Not read from your service:", ...account.notRead.map((line) => `  ${line}`));

    const written = parseConfig(result.text);
    const runsByDefault =
      written.defaultEnvironment === environmentName ||
      (written.defaultEnvironment === undefined && Object.keys(written.environments).length === 1);
    const next = [
      "wasit run --read-only",
      ...(options.config === DEFAULT_CONFIG_FILE ? [] : [`--config ${commandArgument(options.config)}`]),
      ...(runsByDefault ? [] : [`--env ${environmentName}`]),
    ].join(" ");
    lines.push(`Next: ${next}`);
    for (const line of lines) context.stdout(clean(line));
    return 0;
  } catch (error) {
    if (error instanceof InitRefusal) {
      context.stderr(clean(`wasit init: ${error.message}`));
      return 2;
    }
    throw error;
  }
}
