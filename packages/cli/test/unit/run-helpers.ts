/**
 * Shared by the tests of `wasit run` and `wasit ci-report`: paywalls on
 * 127.0.0.1 that answer with a chosen challenge and record what they receive,
 * and config files written to a temporary directory. Every key is made up;
 * nothing leaves 127.0.0.1.
 */

import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Keypair } from "@stellar/stellar-sdk";

export interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

export interface Paywall {
  /** `http://127.0.0.1:<port>` */
  readonly base: string;
  readonly received: Received[];
  readonly close: () => Promise<void>;
}

export type Handler = (request: http.IncomingMessage, response: http.ServerResponse, received: Received) => void;

/** A valid x402 v2 challenge for stellar:testnet, as the PAYMENT-REQUIRED header carries it. */
export function challengeHeader(overrides: { network?: string } = {}): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: "http://127.0.0.1/paid" },
      accepts: [
        {
          scheme: "exact",
          network: overrides.network ?? "stellar:testnet",
          amount: "10000",
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          payTo: Keypair.random().publicKey(),
          maxTimeoutSeconds: 60,
          extra: { areFeesSponsored: true },
        },
      ],
    }),
  ).toString("base64");
}

/** Answers 402 with a valid challenge. */
export const conformantHandler: Handler = (_request, response) => {
  response.writeHead(402, { "payment-required": challengeHeader(), "content-type": "application/json" });
  response.end("{}");
};

/** Answers 402 with an x402 v1 challenge in the body. */
export const v1Handler: Handler = (_request, response) => {
  response.writeHead(402, { "content-type": "application/json" });
  response.end(JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "stellar:testnet" }] }));
};

export async function startPaywall(handler: Handler = conformantHandler): Promise<Paywall> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry: Received = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf-8"),
      };
      received.push(entry);
      handler(request, response, entry);
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

export interface ConfigOptions {
  readonly baseUrl: string;
  readonly network?: string;
  readonly environment?: string;
  readonly endpoints?: ReadonlyArray<Record<string, unknown>>;
  readonly service?: Record<string, unknown>;
}

/** Writes a wasit.config.json into `dir` and returns its path. */
export async function writeConfig(dir: string, options: ConfigOptions, name = "wasit.config.json"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const environment = options.environment ?? "local";
  await writeFile(
    file,
    JSON.stringify(
      {
        version: 1,
        ...(options.service === undefined ? {} : { service: options.service }),
        defaultEnvironment: environment,
        environments: {
          [environment]: { baseUrl: options.baseUrl, network: options.network ?? "stellar:testnet", operatedByMe: true },
        },
        endpoints: options.endpoints ?? [{ name: "weather", protocol: "x402", path: "/api/weather", method: "GET" }],
      },
      null,
      2,
    ),
  );
  return file;
}

export async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
