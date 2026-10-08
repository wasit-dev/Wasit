import "dotenv/config";
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";

// The Solana devnet twin of x402-real-server.ts: the same route and price,
// settled through the same public facilitator, which signs as fee payer and
// pays the fee (its address reaches the challenge as extra.feePayer). The SDK
// prices "$0.01" in its default devnet USDC (6 decimals: 10000 units). The
// payee's USDC account must already exist: the exact scheme's transaction
// carries no instruction that creates it.
const PORT = 3007;
const ROUTE_PATH = "/protected";
const PRICE = "$0.01";
const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const FACILITATOR_URL = "https://www.x402.org/facilitator";
const PAY_TO = process.env.SVM_PAYEE_ADDRESS;
if (!PAY_TO) throw new Error("SVM_PAYEE_ADDRESS is not set in .env");

const app = express();

app.use(
  paymentMiddlewareFromConfig(
    {
      [`GET ${ROUTE_PATH}`]: {
        accepts: { scheme: "exact", price: PRICE, network: NETWORK, payTo: PAY_TO },
      },
    },
    new HTTPFacilitatorClient({ url: FACILITATOR_URL }),
    [{ network: NETWORK, server: new ExactSvmScheme() }],
  ),
);

app.get(ROUTE_PATH, (_, res) => res.json({ secret: "wasit test resource" }));

app.listen(PORT, () => console.log(`Test x402 server (Solana devnet) on http://localhost:${PORT}${ROUTE_PATH}`));
