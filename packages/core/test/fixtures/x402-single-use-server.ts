/**
 * The single-use paywall of spec B8, on the Stellar test network: a conformant
 * x402 paywall (the official middleware, as `x402-real-server.ts`) for one
 * resource that can be bought once. After the first paid request is served,
 * every request, paid or not, gets 409 with a short JSON reason: there is no
 * new 402 to answer with, because the resource is gone.
 *
 * Against it a payment run shows "resource consumed": X402-06 pays and is
 * served, the checks that need a new challenge (X402-07, 09, 10, 11) are
 * skipped with that reason, and X402-08 (the replay) still runs. Restart the
 * fixture to make the resource fresh again. Test funds only: the public testnet
 * facilitator.
 *
 * Run: npx tsx packages/core/test/fixtures/x402-single-use-server.ts
 */

import "dotenv/config";
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";

const PORT = 3010;
const ROUTE_PATH = "/protected";
const PRICE = "$0.01";
const NETWORK = "stellar:testnet";
const FACILITATOR_URL = "https://www.x402.org/facilitator";
const PAY_TO = process.env.STELLAR_PAYEE_ADDRESS;
if (!PAY_TO) throw new Error("STELLAR_PAYEE_ADDRESS is not set in .env");

/** Set when the one paid request has been served: from then on the resource is gone. */
let consumed = false;

const app = express();

// Before the paywall: once the resource is gone there is nothing to sell, so no 402 either.
app.use((_request, response, next) => {
  if (!consumed) {
    next();
    return;
  }
  response.status(409).json({ error: "resource_consumed", message: "This resource could be bought once, and it was." });
});

app.use(
  paymentMiddlewareFromConfig(
    {
      [`GET ${ROUTE_PATH}`]: {
        accepts: { scheme: "exact", price: PRICE, network: NETWORK, payTo: PAY_TO },
      },
    },
    new HTTPFacilitatorClient({ url: FACILITATOR_URL }),
    [{ network: NETWORK, server: new ExactStellarScheme() }],
  ),
);

// Reached only with a payment the middleware verified; it settles after this answer.
app.get(ROUTE_PATH, (_request, response) => {
  consumed = true;
  response.json({ secret: "wasit single-use test resource" });
});

app.listen(PORT, () => console.log(`Single-use x402 server on http://localhost:${PORT}${ROUTE_PATH} (one sale, then 409)`));
