/**
 * The config writer of `wasit init` (spec C; init-skeleton-plan.md section 6,
 * Najmi's rule of 2026-11-15: the writer takes only data that is certain).
 *
 * Data in, the text of a `wasit.config.json` out, checked by the same
 * validator `wasit run` and the Action read it with, so init can never write
 * a file they refuse. Every field is given: the writer has no defaults of its
 * own and guesses nothing. It writes an environment only for a service its
 * operator runs (`operatedByMe` true, literally) and, in this version, only on
 * a test network. It never writes a secret (the validator refuses one), a
 * header of the endpoint (a credential goes in `WASIT_HEADER_*`), the mainnet
 * opt-in (not a config value at all) or anything that enables MPP-13.
 *
 * Adding to an existing file is the default: the file is read as it is, its
 * own keys kept, and the new endpoints appended; an endpoint name it already
 * has, or an environment of the same name with other values, is refused, never
 * overwritten. `replace` starts from nothing.
 *
 * Pure: no file, no network, no key.
 */

import type { ProtocolId } from "./catalogue.js";
import { ConfigError, validateConfig, type JsonValue, type PinConfig, type ReadyConfig } from "./config.js";
import { ConfigurationError } from "./errors.js";
import { networkClass } from "./guard/networks.js";
import { sanitizeText } from "./sanitize.js";

/** The writer will not write this config: nothing is written. */
export class ConfigWriteError extends ConfigurationError {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigWriteError";
  }
}

export interface InitEnvironmentInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly network: string;
  /** Literally true: init writes an environment only for a service its operator runs. */
  readonly operatedByMe: true;
  readonly pinned?: PinConfig;
}

export interface InitRejectInput {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: JsonValue;
  readonly note?: string;
}

export interface InitEndpointInput {
  readonly name: string;
  readonly protocol: ProtocolId;
  readonly path: string;
  readonly method: string;
  readonly body?: JsonValue;
  /** The request the service must refuse (X402-11). */
  readonly reject?: InitRejectInput;
  /** An MPP channel endpoint: the channel contract it bills through. */
  readonly channel?: string;
}

export interface InitServiceInput {
  readonly start: string;
  readonly ready: ReadyConfig;
}

export interface ConfigWriteInput {
  readonly environment: InitEnvironmentInput;
  readonly endpoints: readonly InitEndpointInput[];
  readonly service?: InitServiceInput;
}

export interface ConfigWriteOptions {
  /** The text of the config already at the destination, when there is one. */
  readonly existing?: string;
  /** Start from nothing instead of adding to `existing` (`--force`). */
  readonly replace?: boolean;
}

export interface ConfigWriteResult {
  /** The whole file, two-space JSON, ending in one line break. */
  readonly text: string;
  /** The endpoints this write added, by name. */
  readonly added: readonly string[];
  /** Whether the environment is new in the file. */
  readonly environmentAdded: boolean;
  /** Whether the service block is new in the file. */
  readonly serviceAdded: boolean;
}

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A name or a value for a message: one line, no control characters, bounded. */
function shown(value: unknown): string {
  const text = sanitizeText(String(value)).replace(/\s+/g, " ");
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}...` : text);
}

function rawEnvironment(environment: InitEnvironmentInput): Raw {
  return {
    baseUrl: environment.baseUrl,
    network: environment.network,
    operatedByMe: environment.operatedByMe,
    ...(environment.pinned === undefined ? {} : { pinned: { payTo: environment.pinned.payTo, asset: environment.pinned.asset } }),
  };
}

function rawEndpoint(endpoint: InitEndpointInput): Raw {
  const reject = endpoint.reject;
  return {
    name: endpoint.name,
    protocol: endpoint.protocol,
    path: endpoint.path,
    method: endpoint.method,
    ...(endpoint.body === undefined ? {} : { body: endpoint.body }),
    ...(reject === undefined
      ? {}
      : {
          reject: {
            ...(reject.method === undefined ? {} : { method: reject.method }),
            ...(reject.headers === undefined ? {} : { headers: { ...reject.headers } }),
            ...(reject.body === undefined ? {} : { body: reject.body }),
            ...(reject.note === undefined ? {} : { note: reject.note }),
          },
        }),
    ...(endpoint.channel === undefined ? {} : { channel: endpoint.channel }),
  };
}

function rawService(service: InitServiceInput): Raw {
  return { start: service.start, ready: { url: service.ready.url, timeoutSeconds: service.ready.timeoutSeconds } };
}

/** The rules on the data itself, before any file is looked at. */
function assertCertain(input: ConfigWriteInput): void {
  const { environment, endpoints } = input;
  if (environment.operatedByMe !== true) {
    throw new ConfigWriteError(
      "init writes an environment only for a service you operate (operatedByMe true): Wasit tests only services " +
        "their operator runs. Nothing was written.",
    );
  }
  const kind = networkClass(environment.network);
  if (kind !== "test") {
    throw new ConfigWriteError(
      kind === "mainnet-optin"
        ? `${shown(environment.network)} is Stellar mainnet: init writes test networks only in this version. Nothing was written.`
        : `${shown(environment.network)} is not on Wasit's list of test networks, so init does not write it. Nothing was written.`,
    );
  }
  if (endpoints.length === 0) throw new ConfigWriteError("init writes at least one endpoint. Nothing was written.");
  const names = new Set<string>();
  for (const endpoint of endpoints) {
    if (names.has(endpoint.name)) {
      throw new ConfigWriteError(`The endpoint name ${shown(endpoint.name)} is given twice. Nothing was written.`);
    }
    names.add(endpoint.name);
  }
}

/** The existing file's JSON, valid as a config, or why init leaves it as it is. */
function existingConfig(text: string): Raw {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let raw: unknown;
  try {
    raw = JSON.parse(source);
    validateConfig(raw);
  } catch (error) {
    const why = error instanceof ConfigError ? error.message : "it is not valid JSON";
    throw new ConfigWriteError(
      `The config already there is not valid, so init does not change it (${sanitizeText(why).replace(/\s+/g, " ")}). ` +
        `Fix it, or replace it (--force).`,
    );
  }
  return raw as Raw;
}

/** Whether the file's environment is the one being written: the same URL, network, operator and pin. */
function sameEnvironment(existing: unknown, environment: InitEnvironmentInput): boolean {
  if (!isRecord(existing)) return false;
  const network = existing["network"] ?? "stellar:testnet";
  const pinned = existing["pinned"];
  const pinSame =
    environment.pinned === undefined
      ? pinned === undefined
      : isRecord(pinned) && pinned["payTo"] === environment.pinned.payTo && pinned["asset"] === environment.pinned.asset;
  return existing["baseUrl"] === environment.baseUrl && network === environment.network && existing["operatedByMe"] === true && pinSame;
}

function sameService(existing: unknown, service: InitServiceInput): boolean {
  if (!isRecord(existing)) return false;
  const ready = existing["ready"];
  return (
    existing["start"] === service.start &&
    isRecord(ready) &&
    ready["url"] === service.ready.url &&
    ready["timeoutSeconds"] === service.ready.timeoutSeconds
  );
}

/**
 * The text of the config with `input` in it: a new file, or `existing` with
 * the new endpoints appended. Checked by `validateConfig` before it is
 * returned.
 *
 * @throws {ConfigWriteError} When the data, the existing file or the result is not one init writes. Nothing is to be written then.
 */
export function writeConfigText(input: ConfigWriteInput, options: ConfigWriteOptions = {}): ConfigWriteResult {
  assertCertain(input);
  const { environment } = input;
  const endpoints = input.endpoints.map(rawEndpoint);
  const base = options.existing !== undefined && options.replace !== true ? existingConfig(options.existing) : undefined;

  let ordered: Raw;
  let environmentAdded = true;
  let serviceAdded = input.service !== undefined;
  if (base === undefined) {
    ordered = {
      version: 1,
      ...(input.service === undefined ? {} : { service: rawService(input.service) }),
      defaultEnvironment: environment.name,
      environments: { [environment.name]: rawEnvironment(environment) },
      endpoints,
    };
  } else {
    const environments = { ...(base["environments"] as Raw) };
    if (Object.hasOwn(environments, environment.name)) {
      if (!sameEnvironment(environments[environment.name], environment)) {
        throw new ConfigWriteError(
          `The config already has an environment named ${shown(environment.name)} with another URL, network, operator or ` +
            `pin, and init does not overwrite it. Choose another environment name, or replace the file (--force).`,
        );
      }
      environmentAdded = false;
    } else {
      environments[environment.name] = rawEnvironment(environment);
    }
    const before = base["endpoints"] as Raw[];
    const taken = new Set(before.map((endpoint) => endpoint["name"]));
    for (const endpoint of endpoints) {
      if (taken.has(endpoint["name"])) {
        throw new ConfigWriteError(
          `The config already has an endpoint named ${shown(endpoint["name"])}, and init does not overwrite it. ` +
            `Choose another name, or replace the file (--force).`,
        );
      }
    }
    let service = base["service"];
    if (input.service !== undefined) {
      if (service === undefined) {
        service = rawService(input.service);
      } else if (!sameService(service, input.service)) {
        throw new ConfigWriteError(
          "The config already says how to start the service, differently, and init does not overwrite it. " +
            "Leave the start command out, or replace the file (--force).",
        );
      } else {
        serviceAdded = false;
      }
    }
    // A file with one environment and no defaultEnvironment ran that environment; with a second one it keeps doing so.
    const previous = Object.keys(base["environments"] as Raw);
    const defaultEnvironment = base["defaultEnvironment"] ?? (previous.length === 1 ? previous[0] : undefined);
    ordered = {
      ...(base["$schema"] === undefined ? {} : { $schema: base["$schema"] }),
      version: 1,
      ...(service === undefined ? {} : { service }),
      ...(defaultEnvironment === undefined ? {} : { defaultEnvironment }),
      environments,
      endpoints: [...before, ...endpoints],
    };
  }

  const text = `${JSON.stringify(ordered, null, 2)}\n`;
  try {
    validateConfig(JSON.parse(text));
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigWriteError(
        `init would write a config that wasit run does not accept, so it writes nothing:\n${error.message}`,
      );
    }
    throw error;
  }
  return { text, added: input.endpoints.map((endpoint) => endpoint.name), environmentAdded, serviceAdded };
}
