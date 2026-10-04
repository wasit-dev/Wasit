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
 * The fields every payment option must carry, per protocol version (x402 v2
 * spec 5.1.2; v1 spec 5.1).
 *
 * x402 v2 renamed `maxAmountRequired` to `amount` and moved `resource` and
 * `description` out of the option. Checking for whichever price name happens
 * to be present would hide a real conformance failure: a service advertising
 * `x402Version: 2` while emitting the v1 field name is not conformant to the
 * version it claims.
 */
const REQUIRED_FIELDS: Readonly<Record<1 | 2, readonly string[]>> = {
  2: ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds"],
  1: [
    "scheme",
    "network",
    "maxAmountRequired",
    "asset",
    "payTo",
    "resource",
    "description",
    "maxTimeoutSeconds",
  ],
};

const PRICE_FIELD = { 1: "maxAmountRequired", 2: "amount" } as const;

/** One sentence per missing field, saying what to put there. */
const FIELD_FIXES: Readonly<Record<string, string>> = {
  scheme: 'Add `scheme`, e.g. "exact": clients pick a payment option by its scheme.',
  network: "Add `network` as a CAIP-2 id, e.g. stellar:testnet or eip155:84532.",
  amount: 'Add `amount`: the price in the token\'s smallest unit, as a string (e.g. "10000").',
  maxAmountRequired:
    "Add `maxAmountRequired`: the price in the token's smallest unit, as a string.",
  asset: "Add `asset`: the address of the token the client pays in.",
  payTo: "Add `payTo`: the address that receives the payment.",
  resource: "Add `resource`: the URL of the paid resource.",
  description: "Add `description`: a human-readable description of the resource.",
  maxTimeoutSeconds:
    "Add `maxTimeoutSeconds`: the seconds a client has to complete payment.",
};

/** Said once whenever a field is missing: the usual cause is a hand-built 402. */
const SDK_NOTE = "The official x402 server SDK fills every required field, maxTimeoutSeconds defaulting to 300.";

function isSupportedVersion(value: unknown): value is 1 | 2 {
  return value === 1 || value === 2;
}

/** Names one option in a report: unprefixed when it is the only one. */
function optionLabel(index: number, count: number): string {
  return count === 1 ? "" : `accepts[${index}]: `;
}

/** What is wrong with one option, and what to do about it. */
interface OptionProblem {
  readonly detail: string;
  readonly fixes: readonly string[];
  readonly missing: boolean;
}

function describeValue(value: unknown): string {
  return typeof value === "object" ? "an object" : `${typeof value} ${JSON.stringify(value)}`;
}

/** What is wrong with one payment option's fields, or undefined if nothing is. */
function fieldProblem(
  accept: Record<string, unknown> | undefined,
  version: 1 | 2,
): OptionProblem | undefined {
  const expected = PRICE_FIELD[version];
  const wrongVersionField = version === 2 ? "maxAmountRequired" : "amount";

  // A v2 challenge carrying the v1 field name is a specific, actionable
  // failure — say which name was found and which one the version requires,
  // rather than reporting the price as simply absent.
  if (!nonEmptyString(accept?.[expected]) && accept?.[wrongVersionField] !== undefined) {
    return {
      detail:
        `Challenge advertises x402Version ${version} but carries ` +
        `\`${wrongVersionField}\`, which is the v${version === 2 ? 1 : 2} field ` +
        `name. v${version} requires \`${expected}\`.`,
      fixes: [
        `Rename \`${wrongVersionField}\` to \`${expected}\`, which is what v${version} ` +
          `calls the price, or advertise x402Version ${version === 2 ? 1 : 2} if the ` +
          `service speaks that version.`,
      ],
      missing: false,
    };
  }

  const missing: string[] = [];
  const wrongType: string[] = [];
  for (const field of REQUIRED_FIELDS[version]) {
    const value = accept?.[field];
    if (value === undefined || value === null || value === "") {
      missing.push(field);
    } else if (field === "maxTimeoutSeconds") {
      // A zero or negative timeout leaves the client no time to pay.
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        wrongType.push(
          `maxTimeoutSeconds must be a positive number of seconds (got ${describeValue(value)})`,
        );
      }
    } else if (typeof value !== "string") {
      wrongType.push(`${field} must be a string (got ${describeValue(value)})`);
    }
  }

  if (missing.length === 0 && wrongType.length === 0) return undefined;

  const detail = [
    missing.length > 0 ? `Missing: ${missing.join(", ")}.` : undefined,
    wrongType.length > 0 ? `Wrong type: ${wrongType.join("; ")}.` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  const fixes = [
    ...missing.map((field) => FIELD_FIXES[field]!),
    ...(wrongType.length > 0
      ? [
          "Send each field with the type the spec gives it: strings for amounts " +
            "and addresses, a number for maxTimeoutSeconds.",
        ]
      : []),
  ];
  return { detail, fixes, missing: missing.length > 0 };
}

/** X402-04: every payment option must carry the fields its version requires. */
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
      hint: "Set `x402Version` to 2, the current protocol version, and use its field names.",
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
      hint:
        "List at least one payment option in `accepts`, each with " +
        `${REQUIRED_FIELDS[version].join(", ")}.`,
    };
  }

  const problems = accepts
    .map((accept, index) => {
      const problem = fieldProblem(accept, version);
      return problem === undefined
        ? undefined
        : { ...problem, detail: optionLabel(index, accepts.length) + problem.detail };
    })
    .filter((problem): problem is OptionProblem => problem !== undefined);

  if (problems.length > 0) {
    const fixes = [
      ...new Set([
        ...problems.flatMap((problem) => problem.fixes),
        ...(problems.some((problem) => problem.missing) ? [SDK_NOTE] : []),
      ]),
    ];
    return {
      id,
      name,
      pass: false,
      detail: problems.map((problem) => problem.detail).join(" "),
      hint: fixes.join(" "),
    };
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

/** Why a network id is wrong, and what to write instead. */
interface NetworkProblem {
  readonly reason: string;
  readonly fix: string;
}

const CAIP2_EXAMPLES =
  "stellar:testnet, eip155:84532 (Base Sepolia) or " +
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 (Solana devnet)";

/** `eip155:0x14a34` is a common slip: `eth_chainId` returns hex. */
function eip155Fix(reference: string): string {
  if (/^0x[0-9a-f]+$/i.test(reference)) {
    return `Write the chain id in base 10: eip155:${BigInt(reference).toString()}.`;
  }
  return "Use the chain id in base 10, as eth_chainId returns it converted from hex (Base Sepolia is eip155:84532).";
}

/**
 * Reference rules for the namespaces whose CAIP-2 definition fixes them.
 * Each returns what is wrong with a reference, or undefined when it is right.
 *
 * - stellar: the namespace knows exactly two networks.
 * - eip155: the EIP-155 chain id, in base 10 (`eth_chainId` returns hex,
 *   which the namespace converts).
 * - solana: the first 32 characters of the base58 genesis hash.
 *
 * Sources: ChainAgnostic/namespaces `stellar`, `eip155`, `solana` caip2.md.
 */
const NAMESPACE_RULES: Readonly<
  Record<string, (reference: string) => NetworkProblem | undefined>
> = {
  stellar: (reference) =>
    reference === "testnet" || reference === "pubnet"
      ? undefined
      : {
          reason:
            `"stellar:${reference}" does not match stellar:testnet or stellar:pubnet, ` +
            `the only Stellar networks CAIP-2 defines.`,
          fix: "Use stellar:testnet or stellar:pubnet.",
        },
  eip155: (reference) =>
    /^[1-9][0-9]*$/.test(reference)
      ? undefined
      : {
          reason:
            `"eip155:${reference}" does not carry an EIP-155 chain id in base 10, ` +
            `which the eip155 namespace requires (Base Sepolia is eip155:84532).`,
          fix: eip155Fix(reference),
        },
  solana: (reference) =>
    BASE58_32.test(reference)
      ? undefined
      : {
          reason:
            `"solana:${reference}" is not the first 32 characters of a base58 ` +
            `genesis hash, which the solana namespace requires (devnet is ` +
            `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1).`,
          fix:
            "Use the first 32 characters of the cluster's genesis hash (RPC " +
            "getGenesisHash): solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 for devnet, " +
            "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp for mainnet.",
        },
};

/** What X402-05 established about one network identifier. */
export type NetworkVerdict =
  | { readonly valid: true; readonly namespace: string; readonly known: boolean }
  | { readonly valid: false; readonly reason: string; readonly fix: string };

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
      fix: `Use the network's CAIP-2 id, namespace:reference, such as ${CAIP2_EXAMPLES}.`,
    };
  }
  const namespace = match[1]!;
  const rule = NAMESPACE_RULES[namespace];
  if (rule === undefined) return { valid: true, namespace, known: false };
  const problem = rule(match[2]!);
  return problem === undefined
    ? { valid: true, namespace, known: true }
    : { valid: false, ...problem };
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
    const problems = invalid.map((entry) => entry.verdict as NetworkProblem);
    const reasons = invalid.map(
      (entry, i) => optionLabel(entry.index, accepts.length) + problems[i]!.reason,
    );
    // x402 v1 named networks plainly ("base-sepolia"); saying so turns a bare
    // FAIL into the one change that fixes it.
    const v1Note = v1 ? " x402 v1 used plain names; v2 requires CAIP-2." : "";
    return {
      id,
      name,
      pass: false,
      detail: reasons.join(" ") + v1Note,
      hint: [...new Set(problems.map((problem) => problem.fix))].join(" "),
    };
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
