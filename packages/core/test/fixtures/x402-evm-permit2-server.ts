import "dotenv/config";
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareEip2612GasSponsoringExtension } from "@x402/extensions";

// x402-evm-server.ts with the Permit2 transfer method instead of EIP-3009.
// Permit2 needs a one-time approval; the eip2612GasSponsoring extension lets
// the client sign it as an EIP-2612 permit that the facilitator submits, so
// the payer still needs no ETH. The public facilitator supports the
// extension (its /supported list, 2026-10-05).
const PORT = 3006;
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
        accepts: {
          scheme: "exact",
          price: PRICE,
          network: NETWORK,
          payTo: PAY_TO,
          extra: { assetTransferMethod: "permit2" },
        },
        extensions: { ...declareEip2612GasSponsoringExtension() },
      },
    },
    new HTTPFacilitatorClient({ url: FACILITATOR_URL }),
    [{ network: NETWORK, server: new ExactEvmScheme() }],
  ),
);

app.get(ROUTE_PATH, (_, res) => res.json({ secret: "wasit test resource" }));

app.listen(PORT, () =>
  console.log(`Test x402 server (Base Sepolia, Permit2) on http://localhost:${PORT}${ROUTE_PATH}`),
);
