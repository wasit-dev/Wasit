/**
 * X402-07 sends a payment whose signature is wrong, and nothing else.
 *
 * Before 0.6.0 it overwrote the tail of the base64 envelope, which broke XDR
 * decoding, so a target that decoded the envelope and never verified the
 * signature still refused it and passed. The corruption now touches only the
 * authorization entry's signature bytes; these check that the result still
 * decodes, differs from the original in exactly that signature, and that a
 * payload with no such signature gives no verdict. The transaction is built
 * in the shape `@x402/stellar` produces: one `invokeHostFunction` operation
 * with one address-credential auth entry, and no envelope signature.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

import { CheckSetupError } from "../../src/errors.js";
import { corruptAuthSignature } from "../../src/x402/simulator.js";

const TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAYER = Keypair.random().publicKey();
const SIGNATURE = Buffer.alloc(64, 0x22);
const PUBLIC_KEY = Buffer.alloc(32, 0x11);

const symbol = (value: string): xdr.ScVal => nativeToScVal(value, { type: "symbol" });

function authEntry(credentials: xdr.SorobanCredentials): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(TOKEN).toScAddress(),
          functionName: "transfer",
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
}

function addressCredentials(): xdr.SorobanCredentials {
  return xdr.SorobanCredentials.sorobanCredentialsAddress(
    new xdr.SorobanAddressCredentials({
      address: Address.fromString(PAYER).toScAddress(),
      nonce: xdr.Int64.fromString("7"),
      signatureExpirationLedger: 1000,
      signature: xdr.ScVal.scvVec([
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: symbol("public_key"), val: xdr.ScVal.scvBytes(PUBLIC_KEY) }),
          new xdr.ScMapEntry({ key: symbol("signature"), val: xdr.ScVal.scvBytes(SIGNATURE) }),
        ]),
      ]),
    }),
  );
}

function transaction(credentials: xdr.SorobanCredentials): string {
  return new TransactionBuilder(new Account(PAYER, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: TOKEN,
        function: "transfer",
        args: [],
        auth: [authEntry(credentials)],
      }),
    )
    .setTimeout(30)
    .build()
    .toXDR();
}

/** The signature map inside the first auth entry of a transaction. */
function signatureFields(envelope: xdr.TransactionEnvelope): xdr.ScMapEntry[] {
  const [entry] = envelope.v1().tx().operations()[0]!.body().invokeHostFunctionOp().auth();
  return entry!.credentials().address().signature().vec()![0]!.map()!;
}

describe("corruptAuthSignature", () => {
  it("keeps the transaction decodable and changes only the signature", () => {
    const original = transaction(addressCredentials());
    const corrupted = xdr.TransactionEnvelope.fromXDR(corruptAuthSignature(original), "base64");

    const [publicKey, signature] = signatureFields(corrupted);
    assert.deepEqual(Buffer.from(publicKey!.val().bytes()), PUBLIC_KEY);
    assert.notDeepEqual(Buffer.from(signature!.val().bytes()), SIGNATURE);

    // Restoring the signature must give back the original byte for byte.
    signature!.val(xdr.ScVal.scvBytes(SIGNATURE));
    assert.equal(corrupted.toXDR("base64"), original);
  });

  it("gives no verdict when there is no address signature to corrupt", () => {
    const sourceAccountAuth = transaction(xdr.SorobanCredentials.sorobanCredentialsSourceAccount());
    assert.throws(() => corruptAuthSignature(sourceAccountAuth), CheckSetupError);
  });
});
