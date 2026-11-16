/**
 * X402-11's fixture on the Stellar test network (spec B7): three routes, each a
 * conformant x402 paywall for a valid request, which differ only in what they
 * do with a paid request that carries the `x-wasit-invalid` header, the request
 * the config declares invalid.
 *
 * - /refuses: answers 400. The official middleware does not settle a response
 *   of 400 or above, so the payment is never taken. X402-11 passes.
 * - /settles-then-refuses: settles the payment through the facilitator itself,
 *   then answers 400. X402-11 fails: the request was refused and the payment taken.
 * - /serves: serves it with 200, and the middleware settles. X402-11 fails.
 *
 * The lifetime is 60 s, shorter than the x402 default of 300 s, so the passing
 * route reaches its verdict in about a minute. Test funds only: the public
 * testnet facilitator, as `x402-real-server.ts` uses.
 */

import "dotenv/config";
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { ExactStellarScheme } from "@x402/stellar/exact/server";

const PORT = 3009;
const PRICE = "$0.01";
const NETWORK = "stellar:testnet";
const FACILITATOR_URL = "https://www.x402.org/facilitator";
const MAX_TIMEOUT_SECONDS = 60;
const PAY_TO = process.env.STELLAR_PAYEE_ADDRESS;
if (!PAY_TO) throw new Error("STELLAR_PAYEE_ADDRESS is not set in .env");

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const accepts = { scheme: "exact", price: PRICE, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS } as const;
const ROUTES = ["/refuses", "/settles-then-refuses", "/serves"];

const app = express();

app.use(
  paymentMiddlewareFromConfig(
    Object.fromEntries(ROUTES.map((route) => [`GET ${route}`, { accepts }])),
    facilitator,
    [{ network: NETWORK, server: new ExactStellarScheme() }],
  ),
);

const invalid = (request: express.Request): boolean => request.get("x-wasit-invalid") !== undefined;

app.get("/refuses", (request, response) => {
  if (invalid(request)) return response.status(400).json({ error: "invalid request" });
  return response.json({ resource: "wasit test resource" });
});

app.get("/settles-then-refuses", async (request, response) => {
  if (!invalid(request)) return response.json({ resource: "wasit test resource" });
  // The defect X402-11 exists to find: the payment is taken before the request is judged.
  const header = request.get("payment-signature") ?? request.get("x-payment") ?? "";
  try {
    const payload = decodePaymentSignatureHeader(header);
    await facilitator.settle(payload, payload.accepted);
  } catch (error) {
    console.error("settle failed:", (error as Error).message);
  }
  return response.status(400).json({ error: "invalid request" });
});

app.get("/serves", (_request, response) => response.json({ resource: "wasit test resource" }));

app.listen(PORT, () => {
  console.log(`X402-11 fixture on http://localhost:${PORT}: ${ROUTES.join(", ")} (invalid = header x-wasit-invalid)`);
});
