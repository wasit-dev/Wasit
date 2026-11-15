/**
 * Manual commitment signing for the one-way-channel contract.
 *
 * The official client SDK always signs against its own local baseline, which
 * makes a fresh client single-use per channel. Conformance checks need to target
 * an explicit cumulative amount — including deliberately invalid ones — so this
 * module reproduces the server's own commitment-derivation path.
 *
 * Mirrors `verifyCommitmentSignature` in @stellar/mpp channel/server: simulate
 * `prepare_commitment(amount)` read-only, take the returned Bytes, and sign them
 * with the raw ed25519 commitment key. No transaction is submitted, no fee paid.
 *
 * The bytes come from an RPC the caller chooses, and the contract writes the
 * network it runs on into them. So before signing, the bytes are decoded and
 * must name this channel, this amount and the run's network
 * ({@link assertCommitmentBinds}), as the SDK's own client does: the network the
 * guard allowed is then also the network the signature is valid on.
 */

import {
  Account,
  Contract,
  Keypair,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { ConfigurationError } from "../errors.js";

/**
 * Format-valid all-zero account used purely as a simulation source. It need not
 * exist on the ledger: read-only simulation never touches the source account.
 * Matches ALL_ZEROS in @stellar/mpp constants.
 */
const SIMULATION_SOURCE_ACCOUNT =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Base fee in stroops. Never charged — the transaction is only simulated. */
const SIMULATION_FEE = "100";

const DEFAULT_SIMULATION_TIMEOUT_MS = 10_000;

// Exported so wallet.ts can generate a correctly-sized seed without
// restating this number and risking it drifting out of sync.
export const COMMITMENT_SEED_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

export class CommitmentSimulationError extends Error {
  public constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "CommitmentSimulationError";
  }
}

/**
 * The commitment the RPC returned is not one for this run's channel, amount and
 * network. A `ConfigurationError`: it says nothing about the target's
 * conformance, only that the RPC or the channel the run was given does not
 * belong to the run's network, or answered with something that is not a
 * commitment. Nothing is signed when it is thrown.
 */
export class CommitmentBindingError extends ConfigurationError {
  public constructor(reason: string) {
    super(`Refusing to sign the channel commitment: ${reason} Nothing was signed.`);
    this.name = "CommitmentBindingError";
  }
}

/** The domain separator in every one-way-channel commitment (`symbol_short!("chancmmt")` in the contract). */
export const COMMITMENT_DOMAIN = "chancmmt";

export interface CommitmentExpectation {
  /** The channel contract (C...) this run pays through. */
  readonly channelContract: string;
  /** The cumulative amount this run means to sign, in base units. */
  readonly amount: bigint;
  /** The passphrase of the run's network, the one the network guard allowed. */
  readonly networkPassphrase: string;
}

/**
 * Throws unless `bytes` decode to a commitment for exactly this channel, amount
 * and network, under the commitment domain.
 *
 * The same rule as `assertCommitmentBinds` in @stellar/mpp 0.7.1
 * (`dist/channel/commitment.js`), which the package does not export: the network
 * field is the SHA-256 of the network's passphrase, written by the contract from
 * the ledger it runs on, so it says which network the signature would be valid
 * on whatever the run was told.
 *
 * @throws {CommitmentBindingError} On any mismatch, or bytes that are not a commitment.
 */
export function assertCommitmentBinds(bytes: Uint8Array, expected: CommitmentExpectation): void {
  let decoded: unknown;
  try {
    decoded = scValToNative(xdr.ScVal.fromXDR(Buffer.from(bytes)));
  } catch {
    throw new CommitmentBindingError("prepare_commitment did not return a decodable commitment.");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded) || decoded instanceof Uint8Array) {
    throw new CommitmentBindingError("prepare_commitment did not return a commitment struct.");
  }
  const { domain, network, channel, amount } = decoded as Record<string, unknown>;
  if (domain !== COMMITMENT_DOMAIN) {
    throw new CommitmentBindingError("the commitment does not carry the commitment domain.");
  }
  if (channel !== expected.channelContract) {
    throw new CommitmentBindingError("the commitment is for another channel than the one this run pays through.");
  }
  let committed: bigint;
  try {
    committed = BigInt(amount as string | number | bigint);
  } catch {
    throw new CommitmentBindingError("the commitment amount is not an integer.");
  }
  if (committed !== expected.amount) {
    throw new CommitmentBindingError(`the commitment is for ${committed} base units, not the ${expected.amount} this run means to sign.`);
  }
  const runNetwork = hash(Buffer.from(expected.networkPassphrase));
  if (!(network instanceof Uint8Array) || !Buffer.from(network).equals(runNetwork)) {
    throw new CommitmentBindingError(
      "the commitment is for another network than the run's. The RPC or the channel belongs to another network " +
        "(a mainnet RPC on a test-network run, for example); point the run at an RPC of its own network.",
    );
  }
}

export interface PrepareCommitmentParams {
  /** Channel contract address (C...). */
  readonly channelContract: string;
  /** Cumulative amount in base units. */
  readonly amount: bigint;
  readonly networkPassphrase: string;
  readonly rpcUrl: string;
  readonly simulationTimeoutMs?: number;
}

export interface SignChannelCommitmentParams extends PrepareCommitmentParams {
  /** Raw ed25519 seed as a 64-char hex string (NOT a Stellar S... secret). */
  readonly commitmentSecretHex: string;
}

/**
 * Builds a Keypair from the raw ed25519 seed used for channel commitments.
 * This is deliberately not a Stellar secret key: the contract verifies the
 * signature with `env.crypto().ed25519_verify`.
 */
export function commitmentKeypairFromHex(secretHex: string): Keypair {
  const seed = Buffer.from(secretHex, "hex");
  if (seed.length !== COMMITMENT_SEED_BYTES) {
    throw new CommitmentSimulationError(
      `Commitment secret must decode to ${COMMITMENT_SEED_BYTES} bytes, got ${seed.length}.`,
    );
  }
  return Keypair.fromRawEd25519Seed(seed);
}

/**
 * The exact amount the server will accept next, given the cumulative it
 * currently holds and the price of this request.
 *
 * Server rule (cumulativeMonotonicityError):
 *   commitmentAmount >  previousCumulative
 *   commitmentAmount >= previousCumulative + requestedAmount
 *
 * Since requestedAmount is always positive, the second condition subsumes the
 * first, and the minimum accepted value is their sum.
 */
export function nextValidCumulative(
  previousCumulative: bigint,
  requestedAmount: bigint,
): bigint {
  return previousCumulative + requestedAmount;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new CommitmentSimulationError(`${label} timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Simulates a read-only contract call and returns its raw return value.
 *
 * Read-only simulation costs nothing and touches no ledger state, so the source
 * account need only be well-formed, not funded or even existent.
 */
async function simulateRead(parameters: {
  readonly contractId: string;
  readonly method: string;
  readonly args: readonly xdr.ScVal[];
  readonly networkPassphrase: string;
  readonly rpcUrl: string;
  readonly simulationTimeoutMs: number;
}): Promise<xdr.ScVal> {
  const { contractId, method, args, networkPassphrase, rpcUrl, simulationTimeoutMs } =
    parameters;

  const server = new rpc.Server(rpcUrl);
  const contract = new Contract(contractId);
  const source = new Account(SIMULATION_SOURCE_ACCOUNT, "0");
  const transaction = new TransactionBuilder(source, {
    fee: SIMULATION_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(Math.ceil(simulationTimeoutMs / 1000))
    .build();

  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    simulation = await withTimeout(
      server.simulateTransaction(transaction),
      simulationTimeoutMs,
      `${method} simulation`,
    );
  } catch (error) {
    if (error instanceof CommitmentSimulationError) throw error;
    throw new CommitmentSimulationError(
      `${method} simulation failed at transport level: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }

  if (rpc.Api.isSimulationError(simulation)) {
    throw new CommitmentSimulationError(
      `${method} simulation returned an error: ${simulation.error}`,
    );
  }

  // Checked BEFORE isSimulationSuccess: the restore response type structurally
  // extends the success type, so a success check alone would swallow it.
  if (rpc.Api.isSimulationRestore(simulation)) {
    throw new CommitmentSimulationError(
      `Contract ${contractId} requires a storage restore before it can be read. ` +
        "Extend its TTL first.",
    );
  }

  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new CommitmentSimulationError(
      `${method} simulation returned an unrecognised response shape.`,
    );
  }

  const returnValue = simulation.result?.retval;
  if (!returnValue) {
    throw new CommitmentSimulationError(`${method} returned no value.`);
  }
  return returnValue;
}

/**
 * Reads the channel contract's `withdrawn` getter: the cumulative amount already
 * paid out to the recipient. After a close this must equal the commitment that
 * was closed with.
 */
export async function readChannelWithdrawn(parameters: {
  readonly channelContract: string;
  readonly networkPassphrase: string;
  readonly rpcUrl: string;
  readonly simulationTimeoutMs?: number;
}): Promise<bigint> {
  const value = await simulateRead({
    contractId: parameters.channelContract,
    method: "withdrawn",
    args: [],
    networkPassphrase: parameters.networkPassphrase,
    rpcUrl: parameters.rpcUrl,
    simulationTimeoutMs: parameters.simulationTimeoutMs ?? DEFAULT_SIMULATION_TIMEOUT_MS,
  });
  return BigInt(scValToNative(value) as string | number | bigint);
}

/**
 * Simulates `prepare_commitment(amount)` and returns the bytes to be signed.
 */
export async function prepareCommitmentBytes(
  params: PrepareCommitmentParams,
): Promise<Buffer> {
  const {
    channelContract,
    amount,
    networkPassphrase,
    rpcUrl,
    simulationTimeoutMs = DEFAULT_SIMULATION_TIMEOUT_MS,
  } = params;

  const server = new rpc.Server(rpcUrl);
  const contract = new Contract(channelContract);
  const operation = contract.call(
    "prepare_commitment",
    nativeToScVal(amount, { type: "i128" }),
  );

  const source = new Account(SIMULATION_SOURCE_ACCOUNT, "0");
  const transaction = new TransactionBuilder(source, {
    fee: SIMULATION_FEE,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(Math.ceil(simulationTimeoutMs / 1000))
    .build();

  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    simulation = await withTimeout(
      server.simulateTransaction(transaction),
      simulationTimeoutMs,
      "prepare_commitment simulation",
    );
  } catch (error) {
    if (error instanceof CommitmentSimulationError) throw error;
    throw new CommitmentSimulationError(
      `prepare_commitment simulation failed at transport level: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }

  if (rpc.Api.isSimulationError(simulation)) {
    throw new CommitmentSimulationError(
      `prepare_commitment simulation returned an error: ${simulation.error}`,
    );
  }

  // Checked BEFORE isSimulationSuccess: the restore response type structurally
  // extends the success type, so a success check alone would swallow it. A
  // restore preamble means the channel contract's storage has expired; Wasit
  // reports that rather than silently restoring someone else's contract.
  if (rpc.Api.isSimulationRestore(simulation)) {
    throw new CommitmentSimulationError(
      "Channel contract requires a storage restore before it can be simulated. " +
        "Extend the contract's TTL before running channel checks.",
    );
  }

  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new CommitmentSimulationError(
      "prepare_commitment simulation returned an unrecognised response shape.",
    );
  }

  const returnValue = simulation.result?.retval;
  if (!returnValue) {
    throw new CommitmentSimulationError("prepare_commitment returned no value.");
  }

  return Buffer.from(returnValue.bytes());
}

/** What `signChannelCommitment` can be given instead of its own steps, for tests. */
export interface SignChannelCommitmentDeps {
  /** In place of the simulation of `prepare_commitment` on the RPC. */
  readonly prepare?: (params: PrepareCommitmentParams) => Promise<Buffer>;
}

/**
 * Signs a channel commitment for an explicit cumulative amount, after
 * {@link assertCommitmentBinds} has checked what it is about to sign.
 *
 * @returns The raw 64-byte ed25519 signature, hex-encoded, ready to be placed
 *   in the credential payload's `signature` field.
 */
export async function signChannelCommitment(
  params: SignChannelCommitmentParams,
  deps: SignChannelCommitmentDeps = {},
): Promise<string> {
  const { commitmentSecretHex, ...prepareParams } = params;
  const keypair = commitmentKeypairFromHex(commitmentSecretHex);
  const commitmentBytes = await (deps.prepare ?? prepareCommitmentBytes)(prepareParams);
  // Before the key touches the bytes: they must commit to this channel, this
  // amount and the run's network, whatever the RPC that produced them.
  assertCommitmentBinds(commitmentBytes, {
    channelContract: prepareParams.channelContract,
    amount: prepareParams.amount,
    networkPassphrase: prepareParams.networkPassphrase,
  });
  const signature = keypair.sign(commitmentBytes);

  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new CommitmentSimulationError(
      `Expected a ${ED25519_SIGNATURE_BYTES}-byte signature, got ${signature.length}.`,
    );
  }

  return signature.toString("hex");
}
