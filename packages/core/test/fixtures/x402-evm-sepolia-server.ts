import "dotenv/config";
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createWalletClient, http, publicActions, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

// The Ethereum Sepolia twin of x402-evm-server.ts. No public facilitator
// settles Ethereum Sepolia, so this one runs the official SDK's own
// facilitator in process (x402Facilitator with the EVM exact scheme),
// submitting each settlement from EVM_FACILITATOR_PRIVATE_KEY, which pays the
// gas and so needs Sepolia ETH. The payer still needs only the token. The SDK
// ships no default asset here, so the price names Circle's Sepolia USDC and
// its EIP-712 domain: 10000 units, $0.01.
const PORT = 3008;
const ROUTE_PATH = "/protected";
const NETWORK = "eip155:11155111";
const USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const RPC_URL = process.env.SEPOLIA_RPC_URL ?? sepolia.rpcUrls.default.http[0];
const PAY_TO = process.env.EVM_PAYEE_ADDRESS;
const FACILITATOR_KEY = process.env.EVM_FACILITATOR_PRIVATE_KEY;
if (!PAY_TO) throw new Error("EVM_PAYEE_ADDRESS is not set in .env");
if (!FACILITATOR_KEY) throw new Error("EVM_FACILITATOR_PRIVATE_KEY is not set in .env");

const account = privateKeyToAccount(FACILITATOR_KEY as Hex);
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC_URL) }).extend(publicActions);
const facilitator = new x402Facilitator();
// The signer the SDK's facilitator needs, method by method, from one viem
// wallet client extended with the public actions.
registerExactEvmScheme(facilitator, {
  signer: toFacilitatorEvmSigner({
    address: account.address,
    readContract: (args) => wallet.readContract(args as never),
    verifyTypedData: (args) => wallet.verifyTypedData(args as never),
    writeContract: (args) => wallet.writeContract(args as never),
    sendTransaction: (args) => wallet.sendTransaction(args as never),
    waitForTransactionReceipt: (args) => wallet.waitForTransactionReceipt(args),
    getCode: (args) => wallet.getCode(args),
  }),
  networks: NETWORK,
});

// The resource server talks to the facilitator through the same interface it
// would use over HTTP.
const local: FacilitatorClient = {
  verify: (payload, requirements) => facilitator.verify(payload, requirements),
  settle: (payload, requirements) => facilitator.settle(payload, requirements),
  getSupported: async () => facilitator.getSupported() as SupportedResponse,
};

const app = express();

app.use(
  paymentMiddlewareFromConfig(
    {
      [`GET ${ROUTE_PATH}`]: {
        accepts: {
          scheme: "exact",
          price: { amount: "10000", asset: USDC, extra: { name: "USDC", version: "2" } },
          network: NETWORK,
          payTo: PAY_TO,
        },
      },
    },
    local,
    [{ network: NETWORK, server: new ExactEvmScheme() }],
  ),
);

app.get(ROUTE_PATH, (_, res) => res.json({ secret: "wasit test resource" }));

app.listen(PORT, () =>
  console.log(`Test x402 server (Ethereum Sepolia, local facilitator ${account.address}) on http://localhost:${PORT}${ROUTE_PATH}`),
);
