/**
 * The `exact` scheme on Stellar: Soroban authorization entries signed by the
 * payer, settlement read from the token contract's `transfer` event on
 * Stellar RPC (settlement.ts). This is the chain Wasit was built on, and the
 * only one with MPP as well.
 */

import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme as ExactStellarClientScheme } from "@x402/stellar/exact/client";
import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { CheckSetupError } from "../../errors.js";
import { PaymentGuardRefusedError } from "../../guard/budget.js";
import { checkStellarPreimage, type SigningGate } from "../../guard/signed-terms.js";
import { networkPassphrase, resolveRpcUrl } from "../../mpp/network.js";
import { readTransferData, verifySettlement } from "../../settlement.js";
import type {
  AuthorizationWatch,
  PaymentChain,
  RecordedTransfer,
  SignedAuthorization,
  SignedTermsBinding,
} from "./types.js";

/** A Stellar transaction hash: 64 hex characters. */
const TRANSACTION_HASH = /^[0-9a-f]{64}$/i;

/**
 * Corrupts the client's authorization signature, and nothing else.
 *
 * In the `exact` scheme on Stellar the client signs a Soroban authorization
 * entry, not the envelope: the facilitator signs the envelope later. So the
 * signature that proves the payer consented is the address credential's
 * `signature`, a `Vec<{ public_key, signature }>`. Flipping one byte of it
 * leaves a transaction that still decodes, carries the same amount, payer and
 * recipient, and fails only signature verification. A target can refuse it
 * only by verifying the signature.
 *
 * Throws {@link CheckSetupError} if the payload carries no such signature, so
 * the check reports no verdict rather than one it did not establish.
 */
export function corruptAuthSignature(transaction: string): string {
  const envelope = xdr.TransactionEnvelope.fromXDR(transaction, "base64");
  const operations =
    envelope.switch().name === "envelopeTypeTx" ? envelope.v1().tx().operations() : [];

  let corrupted = false;
  for (const operation of operations) {
    if (operation.body().switch().name !== "invokeHostFunction") continue;
    for (const entry of operation.body().invokeHostFunctionOp().auth()) {
      const credentials = entry.credentials();
      if (credentials.switch().name !== "sorobanCredentialsAddress") continue;
      const signature = credentials.address().signature();
      if (signature.switch().name !== "scvVec") continue;
      for (const item of signature.vec() ?? []) {
        if (item.switch().name !== "scvMap") continue;
        for (const field of item.map() ?? []) {
          if (field.key().switch().name !== "scvSymbol") continue;
          if (field.key().sym().toString() !== "signature") continue;
          const bytes = Buffer.from(field.val().bytes());
          bytes[0] = bytes[0]! ^ 0xff;
          field.val(xdr.ScVal.scvBytes(bytes));
          corrupted = true;
        }
      }
    }
  }

  if (!corrupted) {
    throw new CheckSetupError(
      "The payment payload carries no authorization-entry signature to " +
        "corrupt, so a corrupted signature cannot be tested.",
    );
  }
  return envelope.toXDR("base64");
}

/**
 * A format-valid all-zero account, as the simulation source: a read-only
 * simulation never touches it, so it need not exist (channel-commitment.ts
 * uses the same).
 */
const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** A read-only contract call, simulated; undefined unless it succeeds with a value. */
async function simulateTokenRead(
  server: rpc.Server,
  passphrase: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown> {
  const transaction = new TransactionBuilder(new Account(SIMULATION_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  if (
    !rpc.Api.isSimulationSuccess(simulation) ||
    rpc.Api.isSimulationRestore(simulation) ||
    simulation.result === undefined
  ) {
    return undefined;
  }
  return scValToNative(simulation.result.retval);
}

/**
 * The classic asset a Stellar Asset Contract wraps, from the `name` it
 * reports ("CODE:ISSUER", CAP-46-06), only when that asset's contract id is
 * `contractId`: any contract can return such a name, but only the SAC has
 * the id derived from the asset.
 */
export function sacAssetFromName(name: unknown, contractId: string, passphrase: string): Asset | undefined {
  if (typeof name !== "string") return undefined;
  const match = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/.exec(name);
  if (match === null || !StrKey.isValidEd25519PublicKey(match[2]!)) return undefined;
  const asset = new Asset(match[1]!, match[2]!);
  return asset.contractId(passphrase) === contractId ? asset : undefined;
}

/**
 * The payer's balance of a SEP-41 token, read by simulating its `balance`.
 *
 * A Stellar Asset Contract reports a payer without a trustline as an error,
 * not as zero, and an unfunded payer is the usual case. So when `balance`
 * gives no value and the token is a SAC, the trustline is looked up: none
 * means the payer holds nothing. The asset's issuer needs no trustline, so it
 * is left unread. Anything else gives undefined.
 */
async function stellarTokenBalance(
  network: string,
  rpcUrl: string,
  payer: string,
  asset: string,
): Promise<bigint | undefined> {
  if (!StrKey.isValidContract(asset) || !StrKey.isValidEd25519PublicKey(payer)) return undefined;
  const passphrase = networkPassphrase(network);
  const server = new rpc.Server(rpcUrl);
  const balance = await simulateTokenRead(server, passphrase, asset, "balance", [
    new Address(payer).toScVal(),
  ]);
  if (typeof balance === "bigint") return balance;

  const classic = sacAssetFromName(
    await simulateTokenRead(server, passphrase, asset, "name", []),
    asset,
    passphrase,
  );
  if (classic === undefined || classic.getIssuer() === payer) return undefined;
  const { entries } = await server.getLedgerEntries(
    xdr.LedgerKey.trustline(
      new xdr.LedgerKeyTrustLine({
        accountId: Keypair.fromPublicKey(payer).xdrAccountId(),
        asset: classic.toTrustLineXDRObject(),
      }),
    ),
  );
  return entries.length === 0 ? 0n : undefined;
}


/**
 * X402-11 reads (D-032, spec B16.4): the authorization a payment carries, as
 * the payer signed it. Only an address credential is read; another form (the
 * newer `AddressV2`, one with delegates) is not, and gives no reading rather
 * than a guess, since its nonce handling was not read.
 */
export function decodeStellarAuthorization(payload: Record<string, unknown>): SignedAuthorization {
  const transaction = payload["transaction"];
  if (typeof transaction !== "string") {
    throw new CheckSetupError("The payment payload carries no transaction to read its authorization from.");
  }
  let envelope: xdr.TransactionEnvelope;
  try {
    envelope = xdr.TransactionEnvelope.fromXDR(transaction, "base64");
  } catch {
    throw new CheckSetupError("The payment payload's transaction does not decode, so its authorization cannot be read.");
  }
  const operations = envelope.switch().name === "envelopeTypeTx" ? envelope.v1().tx().operations() : [];
  const found: SignedAuthorization[] = [];
  let otherForms = 0;
  for (const operation of operations) {
    if (operation.body().switch().name !== "invokeHostFunction") continue;
    for (const entry of operation.body().invokeHostFunctionOp().auth()) {
      const credentials = entry.credentials();
      const kind = credentials.switch().name;
      if (kind === "sorobanCredentialsSourceAccount") continue;
      if (kind !== "sorobanCredentialsAddress") {
        otherForms += 1;
        continue;
      }
      const address = credentials.address();
      found.push({
        payer: Address.fromScAddress(address.address()).toString(),
        nonce: address.nonce().toString(),
        expiresAt: address.signatureExpirationLedger(),
      });
    }
  }
  if (otherForms > 0) {
    throw new CheckSetupError(
      "The payment's authorization uses a credential form this check does not read (it reads address credentials), " +
        "so whether it was used cannot be read.",
    );
  }
  if (found.length !== 1) {
    throw new CheckSetupError(`The payment carries ${found.length} address authorizations; this check reads exactly one.`);
  }
  return found[0]!;
}

/** The ledger entry the host writes when it consumes the nonce: TEMPORARY contract data of the signer. */
function nonceKey(authorization: SignedAuthorization): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(authorization.payer).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce: xdr.Int64.fromString(authorization.nonce) })),
      durability: xdr.ContractDataDurability.temporary(),
    }),
  );
}

function rpcServer(rpcUrl: string): rpc.Server {
  return new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
}

/** The most events read for one X402-11 window: far more than one run makes. */
const EVENTS_PAGE = 100;
const EVENTS_MAX_PAGES = 20;

const stellarAuthorizations: AuthorizationWatch = {
  unit: "ledger",
  unitMs: 5_000,
  // The x402 Stellar client's own default (DEFAULT_ESTIMATED_LEDGER_SECONDS in
  // @x402/stellar 2.28.0); it estimates from recent ledgers when it can.
  unitSeconds: 5,
  decode: decodeStellarAuthorization,
  async read(_network, rpcUrl, authorizations) {
    const keys = authorizations.map(nonceKey);
    const response = await rpcServer(rpcUrl).getLedgerEntries(...keys);
    const byKey = new Map(response.entries.map((entry) => [entry.key.toXDR("base64"), entry]));
    return {
      latest: response.latestLedger,
      used: keys.map((key) => {
        const entry = byKey.get(key.toXDR("base64"));
        return entry === undefined ? undefined : (entry.lastModifiedLedgerSeq ?? response.latestLedger);
      }),
    };
  },
  async transfers(_network, rpcUrl, query) {
    const server = rpcServer(rpcUrl);
    const name = xdr.ScVal.scvSymbol("transfer").toXDR("base64");
    const from = new Address(query.from).toScVal().toXDR("base64");
    const to = new Address(query.to).toScVal().toXDR("base64");
    // A Stellar Asset Contract adds the asset as a fourth topic (CAP-67); a SEP-41 token may not.
    const filters: rpc.Api.EventFilter[] = [
      { type: "contract", contractIds: [query.asset], topics: [[name, from, to, "*"], [name, from, to]] },
    ];
    const transfers: RecordedTransfer[] = [];
    let response = await server.getEvents({ startLedger: query.fromLedger, filters, limit: EVENTS_PAGE });
    for (let page = 1; ; page += 1) {
      for (const event of response.events) {
        // Only an event the RPC marks as from a failed call is left out. The testnet RPC no
        // longer sends the field at all (observed 2026-11-16, run of slice 4's live check):
        // reading its absence as "failed" dropped every transfer.
        if (event.inSuccessfulContractCall === false) continue;
        const [topic, sender, receiver] = event.topic;
        if (topic?.switch().name !== "scvSymbol" || topic.sym().toString() !== "transfer") continue;
        if (sender === undefined || receiver === undefined) continue;
        if (Address.fromScVal(sender).toString() !== query.from || Address.fromScVal(receiver).toString() !== query.to) continue;
        const data = readTransferData(event.value);
        if (data === undefined) continue;
        transfers.push({ amount: data.amount, reference: event.txHash, ledger: event.ledger });
      }
      if (response.events.length < EVENTS_PAGE) break;
      // Never a partial answer read as complete.
      if (page >= EVENTS_MAX_PAGES) throw new Error("more transfer events than can be read in full");
      response = await server.getEvents({ cursor: response.cursor, filters, limit: EVENTS_PAGE });
    }
    return { latest: response.latestLedger, transfers };
  },
};

/**
 * The payer's signer, gated (spec B17.2): each authorization the x402 client
 * asks it to sign is checked against the terms `gate` was armed with, and the
 * key signs only when it authorizes exactly that transfer, once. There is no
 * `signTransaction`: the scheme has the facilitator pay the fees, so the
 * client never signs the envelope.
 */
function gatedSigner(payerKey: string, network: string, gate: SigningGate) {
  const base = createEd25519Signer(payerKey, network as `${string}:${string}`);
  const signAuthEntry: typeof base.signAuthEntry = async (preimage, opts) => {
    const terms = gate.take();
    if (opts?.address !== undefined && opts.address !== base.address) {
      throw new PaymentGuardRefusedError("signed-terms", "The x402 client asked for a signature for another address than the payer's.");
    }
    if (terms.payer !== base.address) {
      throw new PaymentGuardRefusedError("signed-terms", "The payment's terms name another payer than the key Wasit holds.");
    }
    checkStellarPreimage(preimage, terms);
    const result = await base.signAuthEntry(preimage, opts);
    gate.record({ preimage, signature: Buffer.from(result.signedAuthEntry, "base64") });
    return result;
  };
  return { address: base.address, signAuthEntry };
}

/** The `signature` bytes of an address credential signed by one ed25519 key, if it is that shape. */
function credentialSignature(signature: xdr.ScVal): { readonly publicKey: Buffer; readonly signature: Buffer } | undefined {
  if (signature.switch().name !== "scvVec") return undefined;
  const items = signature.vec() ?? [];
  if (items.length !== 1 || items[0]!.switch().name !== "scvMap") return undefined;
  let publicKey: Buffer | undefined;
  let bytes: Buffer | undefined;
  for (const field of items[0]!.map() ?? []) {
    if (field.key().switch().name !== "scvSymbol" || field.val().switch().name !== "scvBytes") return undefined;
    const key = field.key().sym().toString();
    if (key === "public_key") publicKey = Buffer.from(field.val().bytes());
    else if (key === "signature") bytes = Buffer.from(field.val().bytes());
    else return undefined;
  }
  return publicKey === undefined || bytes === undefined ? undefined : { publicKey, signature: bytes };
}

function notSent(message: string): PaymentGuardRefusedError {
  return new PaymentGuardRefusedError("signed-terms", message, { signed: true });
}

const stellarSignedTerms: SignedTermsBinding = {
  // The x402 Stellar client's fallback ledger close time (DEFAULT_ESTIMATED_LEDGER_SECONDS in
  // @x402/stellar 2.28.0), and the shortest it assumes: a faster close only tightens the bound.
  unitSeconds: 5,
  async latestUnit(_network, rpcUrl) {
    return (await rpcServer(rpcUrl).getLatestLedger()).sequence;
  },
  bind(payload, gate) {
    const signed = gate.signed;
    if (signed === undefined) {
      throw new PaymentGuardRefusedError("signed-terms", "The x402 client built a payment without the signature Wasit checked.");
    }
    const checked = xdr.HashIdPreimage.fromXDR(signed.preimage, "base64").sorobanAuthorization();
    const transaction = payload["transaction"];
    let envelope: xdr.TransactionEnvelope;
    try {
      if (typeof transaction !== "string") throw new Error("no transaction");
      envelope = xdr.TransactionEnvelope.fromXDR(transaction, "base64");
    } catch {
      throw notSent("The payment the x402 client built carries no transaction that decodes.");
    }
    const payer = gate.terms?.payer;
    const operations = envelope.switch().name === "envelopeTypeTx" ? envelope.v1().tx().operations() : [];
    const ours: xdr.SorobanAuthorizationEntry[] = [];
    for (const operation of operations) {
      if (operation.body().switch().name !== "invokeHostFunction") continue;
      for (const entry of operation.body().invokeHostFunctionOp().auth()) {
        const kind = entry.credentials().switch().name;
        if (kind === "sorobanCredentialsSourceAccount") continue;
        if (kind !== "sorobanCredentialsAddress") {
          throw notSent("The payment the x402 client built carries an authorization in a form Wasit did not sign.");
        }
        if (Address.fromScAddress(entry.credentials().address().address()).toString() === payer) ours.push(entry);
      }
    }
    if (ours.length !== 1) {
      throw notSent(`The payment the x402 client built carries ${ours.length} authorizations for the payer; Wasit signed one.`);
    }
    const entry = ours[0]!;
    const credentials = entry.credentials().address();
    if (entry.rootInvocation().toXDR("base64") !== checked.invocation().toXDR("base64")) {
      throw notSent("The payment the x402 client built names another invocation than the one Wasit checked and signed.");
    }
    if (credentials.signatureExpirationLedger() !== checked.signatureExpirationLedger()) {
      throw notSent("The payment the x402 client built carries another expiration ledger than the one signed.");
    }
    if (credentials.nonce().toString() !== checked.nonce().toString()) {
      throw notSent("The payment the x402 client built carries another nonce than the one signed.");
    }
    const sent = credentialSignature(credentials.signature());
    if (
      sent === undefined ||
      payer === undefined ||
      !sent.publicKey.equals(Keypair.fromPublicKey(payer).rawPublicKey()) ||
      !sent.signature.equals(signed.signature)
    ) {
      throw notSent("The payment the x402 client built carries another signature than the one Wasit made.");
    }
  },
};

export const stellarChain: PaymentChain = {
  name: "Stellar",
  networks: ["stellar:testnet", "stellar:pubnet"],
  payerKeyEnv: "STELLAR_PRIVATE_KEY",
  referenceKind: "a settled Stellar transaction hash",
  resolveRpcUrl: (network, override) => resolveRpcUrl(network, override),
  // The x402 Stellar client builds its RPC client without `allowHttp`.
  httpsRpcOnly: true,
  registerPayer(client, network, payerKey, rpcUrl, gate) {
    // The payment is built and simulated through the run's RPC: the one whose
    // network was checked (D-023), the anchor is read from, and the settlement
    // is read from. Not on stellar:pubnet: the SDK refuses it without an RPC of
    // its own, and no endpoint is handed to it before the mainnet opt-in.
    const rpcConfig = network === "stellar:testnet" ? { url: rpcUrl } : undefined;
    client.register("stellar:*", new ExactStellarClientScheme(gatedSigner(payerKey, network, gate), rpcConfig));
  },
  signedTerms: stellarSignedTerms,
  // A one-second lifetime is one ledger (ceil(1 / 5)); ledgers close about
  // every 5 to 6 seconds, so 20 seconds is three or more ledgers past it.
  expiredSigning: async () => ({ terms: { maxTimeoutSeconds: 1 }, holdMs: 20_000 }),
  payerAddress: (payerKey) => Keypair.fromSecret(payerKey).publicKey(),
  payerBalance: stellarTokenBalance,
  generatePayerKey: () => Keypair.random().secret(),
  isSettlementReference: (reference) => TRANSACTION_HASH.test(reference),
  verifySettlement: (_network, rpcUrl, reference, expected) => verifySettlement(rpcUrl, reference, expected),
  corruptPayload: (payload) => ({
    ...payload,
    transaction: corruptAuthSignature(payload["transaction"] as string),
  }),
  authorizations: stellarAuthorizations,
};
