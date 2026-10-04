/**
 * The payment terms an x402 challenge advertises, and the rules X402-04 and
 * X402-05 hold them to.
 *
 * Split from the HTTP calls in simulator.ts so the rules can be exercised
 * without a network. Nothing here is specific to one chain: x402 v2 names the
 * network of every payment option with a CAIP-2 identifier, and a challenge
 * may offer several options on several chains at once.
 */

import { skipped, type CheckResult } from "../check.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Every payment option a challenge offers, in order.
 *
 * x402 v2 nests the payment terms inside `accepts[]`. Each entry is a separate
 * option, typically one per network or asset, so each is checked on its own:
 * judging only the first would pass a challenge whose other options are broken,
 * and fail one whose first option is on a chain the reader did not expect.
 * An entry that is not an object is kept as `undefined`, so it reads as an
 * option with every field missing rather than disappearing from the count.
 */
export function acceptsOf(
  payload: unknown,
): ReadonlyArray<Record<string, unknown> | undefined> | undefined {
  const accepts = asRecord(payload)?.["accepts"];
  return Array.isArray(accepts) ? accepts.map(asRecord) : undefined;
}

/**
 * The field carrying the price, per protocol version.
 *
 * x402 v2 renamed `maxAmountRequired` to `amount` and dropped the embedded
 * resource object. Checking for whichever name happens to be present would
 * hide a real conformance failure: a service advertising `x402Version: 2`
 * while emitting the v1 field name is not conformant to the version it claims.
 */
const PRICE_FIELD: Readonly<Record<1 | 2, "maxAmountRequired" | "amount">> = {
  1: "maxAmountRequired",
  2: "amount",
};

function isSupportedVersion(value: unknown): value is 1 | 2 {
  return value === 1 || value === 2;
}

/** Names one option in a report: unprefixed when it is the only one. */
function optionLabel(index: number, count: number): string {
  return count === 1 ? "" : `accepts[${index}]: `;
}

/** What is wrong with one payment option's fields, or undefined if nothing is. */
function fieldProblem(
  accept: Record<string, unknown> | undefined,
  version: 1 | 2,
): string | undefined {
  const expected = PRICE_FIELD[version];
  const wrongVersionField = version === 2 ? "maxAmountRequired" : "amount";

  // A v2 challenge carrying the v1 field name is a specific, actionable
  // failure — say which name was found and which one the version requires,
  // rather than reporting the price as simply absent.
  if (!nonEmptyString(accept?.[expected]) && accept?.[wrongVersionField] !== undefined) {
    return (
      `Challenge advertises x402Version ${version} but carries ` +
      `\`${wrongVersionField}\`, which is the v${version === 2 ? 1 : 2} field ` +
      `name. v${version} requires \`${expected}\`.`
    );
  }

  const missing = [
    nonEmptyString(accept?.[expected]) ? null : expected,
    nonEmptyString(accept?.["network"]) ? null : "network",
    nonEmptyString(accept?.["payTo"]) ? null : "payTo",
  ].filter((entry): entry is string => entry !== null);

  return missing.length === 0 ? undefined : `Missing: ${missing.join(", ")}.`;
}

/** X402-04: every payment option must carry price, network, and payTo. */
export function checkRequiredFields(payload: unknown): CheckResult {
  const id = "X402-04";
  const name = "Required Fields Present";
  const version = asRecord(payload)?.["x402Version"];

  if (!isSupportedVersion(version)) {
    return {
      id,
      name,
      pass: false,
      detail:
        `Challenge advertises x402Version ${JSON.stringify(version)}, which is ` +
        `neither 1 nor 2. The payment terms use different field names per ` +
        `version, so they cannot be checked against an unknown one.`,
    };
  }

  const accepts = acceptsOf(payload);
  if (accepts === undefined || accepts.length === 0) {
    return {
      id,
      name,
      pass: false,
      detail:
        "Challenge offers no payment options: `accepts` is missing or empty, so " +
        `there is no price, network or payTo to read.`,
    };
  }

  const problems = accepts
    .map((accept, index) => {
      const problem = fieldProblem(accept, version);
      return problem === undefined ? undefined : optionLabel(index, accepts.length) + problem;
    })
    .filter((problem): problem is string => problem !== undefined);

  if (problems.length > 0) {
    return { id, name, pass: false, detail: problems.join(" ") };
  }
  return {
    id,
    name,
    pass: true,
    detail:
      accepts.length === 1
        ? `All required v${version} fields present.`
        : `All required v${version} fields present in each of the ` +
          `${accepts.length} payment options.`,
  };
}

/** CAIP-2: `namespace:reference`, with the character sets the standard fixes. */
const CAIP2 = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32})$/;

/** Base58 (bitcoin alphabet): no 0, O, I or l. */
const BASE58_32 = /^[1-9A-HJ-NP-Za-km-z]{32}$/;

/**
 * Reference rules for the namespaces whose CAIP-2 definition fixes them.
 * Each returns why a reference is wrong, or undefined when it is right.
 *
 * - stellar: the namespace knows exactly two networks.
 * - eip155: the EIP-155 chain id, in base 10 (`eth_chainId` returns hex,
 *   which the namespace converts).
 * - solana: the first 32 characters of the base58 genesis hash.
 *
 * Sources: ChainAgnostic/namespaces `stellar`, `eip155`, `solana` caip2.md.
 */
const NAMESPACE_RULES: Readonly<Record<string, (reference: string) => string | undefined>> = {
  stellar: (reference) =>
    reference === "testnet" || reference === "pubnet"
      ? undefined
      : `"stellar:${reference}" does not match stellar:testnet or stellar:pubnet, ` +
        `the only Stellar networks CAIP-2 defines.`,
  eip155: (reference) =>
    /^[1-9][0-9]*$/.test(reference)
      ? undefined
      : `"eip155:${reference}" does not carry an EIP-155 chain id in base 10, ` +
        `which the eip155 namespace requires (Base Sepolia is eip155:84532).`,
  solana: (reference) =>
    BASE58_32.test(reference)
      ? undefined
      : `"solana:${reference}" is not the first 32 characters of a base58 ` +
        `genesis hash, which the solana namespace requires (devnet is ` +
        `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1).`,
};

/** What X402-05 established about one network identifier. */
export type NetworkVerdict =
  | { readonly valid: true; readonly namespace: string; readonly known: boolean }
  | { readonly valid: false; readonly reason: string };

/**
 * Validates one network identifier against CAIP-2, which x402 v2 requires,
 * and against its namespace's own rules where Wasit knows them.
 *
 * A well-formed identifier in a namespace Wasit has no rules for is valid:
 * x402 v2 asks for CAIP-2 and nothing more, and even encourages non-blockchain
 * networks to follow it (`ach:us`). Failing it would report Wasit's own
 * ignorance as the target's defect.
 */
export function validateNetwork(network: string): NetworkVerdict {
  const match = CAIP2.exec(network);
  if (match === null) {
    return {
      valid: false,
      reason:
        `"${network}" is not a CAIP-2 identifier (namespace:reference, e.g. ` +
        `stellar:testnet or eip155:84532), which x402 v2 requires.`,
    };
  }
  const namespace = match[1]!;
  const rule = NAMESPACE_RULES[namespace];
  if (rule === undefined) return { valid: true, namespace, known: false };
  const reason = rule(match[2]!);
  return reason === undefined
    ? { valid: true, namespace, known: true }
    : { valid: false, reason };
}

/** X402-05: every advertised network identifier must be CAIP-2. */
export function checkNetworkIdentifier(payload: unknown): CheckResult {
  const id = "X402-05";
  const name = "Network Identifier Valid";
  const accepts = acceptsOf(payload) ?? [];
  const advertised = accepts
    .map((accept, index) => ({ index, network: accept?.["network"] }))
    .filter((entry): entry is { index: number; network: string } =>
      nonEmptyString(entry.network),
    );

  // Absent is X402-04's finding, not a second one: report it there only.
  if (advertised.length === 0) {
    return skipped(id, name, "the challenge carries no network field to validate (see X402-04).");
  }

  const v1 = asRecord(payload)?.["x402Version"] === 1;
  const verdicts = advertised.map((entry) => ({ ...entry, verdict: validateNetwork(entry.network) }));
  const invalid = verdicts.filter((entry) => !entry.verdict.valid);

  if (invalid.length > 0) {
    const reasons = invalid.map(
      (entry) =>
        optionLabel(entry.index, accepts.length) +
        (entry.verdict as { reason: string }).reason,
    );
    // x402 v1 named networks plainly ("base-sepolia"); saying so turns a bare
    // FAIL into the one change that fixes it.
    const v1Note = v1 ? " x402 v1 used plain names; v2 requires CAIP-2." : "";
    return { id, name, pass: false, detail: reasons.join(" ") + v1Note };
  }

  const unknownNamespaces = [
    ...new Set(
      verdicts
        .map((entry) => entry.verdict)
        .filter((verdict) => verdict.valid && !verdict.known)
        .map((verdict) => (verdict as { namespace: string }).namespace),
    ),
  ];
  const unknownNote =
    unknownNamespaces.length === 0
      ? ""
      : ` Wasit has no further rules for the ${unknownNamespaces
          .map((namespace) => `"${namespace}"`)
          .join(", ")} namespace${unknownNamespaces.length === 1 ? "" : "s"}, ` +
        `so only the CAIP-2 format was checked there.`;

  const networks = advertised.map((entry) => entry.network);
  return {
    id,
    name,
    pass: true,
    detail:
      (networks.length === 1
        ? `Network identifier "${networks[0]}" is valid.`
        : `Network identifiers are valid: ${networks.join(", ")}.`) + unknownNote,
  };
}
