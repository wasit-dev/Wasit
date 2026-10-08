import "dotenv/config";
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

// The Base Sepolia twin of x402-real-server.ts: the same route and price,
// settled through the same public facilitator, which pays the gas. The SDK
// prices "$0.01" in its default Base Sepolia USDC (6 decimals: 10000 units).
const PORT = 3005;
const ROUTE_PATH = "/protected";
const PRICE = "$0.01";
const NETWORK = "eip155:84532";
const FACILITATOR_URL = "https://www.x402.org/facilitator";
const PAY_TO = process.env.EVM_PAYEE_ADDRESS;
if (!PAY_TO) throw new Error("EVM_PAYEE_ADDRESS is not set in .env");

const app = express();

app.use(
  paymentMiddlewareFromConfig(
    {
      [`GET ${ROUTE_PATH}`]: {
        accepts: { scheme: "exact", price: PRICE, network: NETWORK, payTo: PAY_TO },
      },
    },
    new HTTPFacilitatorClient({ url: FACILITATOR_URL }),
    [{ network: NETWORK, server: new ExactEvmScheme() }],
  ),
);

app.get(ROUTE_PATH, (_, res) => res.json({ secret: "wasit test resource" }));

app.listen(PORT, () => console.log(`Test x402 server (Base Sepolia) on http://localhost:${PORT}${ROUTE_PATH}`));
