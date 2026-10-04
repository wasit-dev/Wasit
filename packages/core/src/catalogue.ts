/**
 * Structured summary of every check in the catalogue.
 *
 * This is a short-form companion to docs/CHECKS.md, not a replacement for
 * it: full pass-criteria prose, spec citations, and the revision/status
 * notes only live in the markdown doc. This file exists so the CLI's
 * `wasit checks` command (and any future consumer that needs the catalogue
 * as data rather than prose) has one small, typed source instead of
 * parsing markdown or duplicating IDs by hand.
 *
 * MAINTENANCE: kept in sync with docs/CHECKS.md manually. If you add,
 * rename, or re-scope a check there, update the matching entry here in the
 * same change — there is currently no generator tying the two together.
 */

export type ProtocolId = "x402" | "mpp-charge" | "mpp-channel";

export const PROTOCOL_IDS: readonly ProtocolId[] = ["x402", "mpp-charge", "mpp-channel"];

export interface CheckCatalogueEntry {
  /** Stable catalogue identifier, e.g. "MPP-11". Must match docs/CHECKS.md. */
  readonly id: string;
  readonly name: string;
  readonly protocol: ProtocolId;
  /** Where in the spec (or SDK behavior) this check is grounded. */
  readonly specRef: string;
  /** One-line summary of what the check verifies. Full pass criteria: docs/CHECKS.md. */
  readonly summary: string;
  /** True for a check that only passes because the target correctly REJECTED something. */
  readonly negative?: true;
  /** True for a check that permanently alters the target's state (see SECURITY.md). */
  readonly destructive?: true;
  /** True for a check that settles or risks settling a real on-chain payment. */
  readonly costsFunds?: true;
}

export const CHECK_CATALOGUE: readonly CheckCatalogueEntry[] = [
  {
    id: "X402-01",
    name: "402 Response Status",
    protocol: "x402",
    specRef: "x402 spec, HTTP semantics",
    summary: "An unpaid request must be answered with status code 402.",
  },
  {
    id: "X402-02",
    name: "Payment Header Present",
    protocol: "x402",
    specRef: "x402 built-on-stellar guide",
    summary: "The 402 response must include a payment header.",
  },
  {
    id: "X402-03",
    name: "Header Payload Decodable",
    protocol: "x402",
    specRef: "x402 spec §payment-required-object",
    summary: "The header value must be valid base64 that decodes to JSON.",
  },
  {
    id: "X402-04",
    name: "Required Fields Present",
    protocol: "x402",
    specRef: "x402 spec §payment-required-object",
    summary:
      "The payload must include the core payment terms, under the field names its advertised version requires.",
  },
  {
    id: "X402-05",
    name: "Network Identifier Valid",
    protocol: "x402",
    specRef: "x402 v2 spec §11.1; CAIP-2",
    summary:
      "Every advertised network identifier must be CAIP-2, and follow its namespace's rules where Wasit knows them (stellar, eip155, solana).",
  },
  {
    id: "X402-06",
    name: "Signature Resubmit Accepted",
    protocol: "x402",
    specRef: "x402 spec §payment-flow",
    summary: "A resubmitted request carrying a valid signature must be accepted.",
    costsFunds: true,
  },
  {
    id: "X402-07",
    name: "Invalid Signature Rejected",
    protocol: "x402",
    specRef: "x402 spec §payment-flow",
    summary: "A deliberately corrupted signature must be rejected, not accepted.",
    negative: true,
    costsFunds: true,
  },
  {
    id: "MPP-01",
    name: "Charge Settlement On-Chain",
    protocol: "mpp-charge",
    specRef: "MPP Charge Guide; CAP-46 transfer events",
    summary: "The charge settles on-chain for exactly what the target advertised.",
    costsFunds: true,
  },
  {
    id: "MPP-10",
    name: "Channel Deploy",
    protocol: "mpp-channel",
    specRef: "MPP Channel Guide",
    summary:
      "The channel contract deploys correctly and is the same channel the target bills through.",
  },
  {
    id: "MPP-11",
    name: "Cumulative Commitment Ordering",
    protocol: "mpp-channel",
    specRef: "MPP Channel Guide §closing-the-channel; @stellar/mpp channel server",
    summary:
      "A commitment must exceed the stored cumulative and cover the price of the current request.",
  },
  {
    id: "MPP-12",
    name: "Challenge Replay Rejection",
    protocol: "mpp-channel",
    specRef: "MPP Channel Guide §closing-the-channel; @stellar/mpp channel server",
    summary: "A byte-identical credential resubmitted against the same challenge must be rejected.",
    negative: true,
  },
  {
    id: "MPP-13",
    name: "Close Settlement",
    protocol: "mpp-channel",
    specRef: "MPP Channel Guide §closing-the-channel",
    summary: "Closing with the highest commitment settles on-chain. Permanently ends the channel.",
    destructive: true,
    costsFunds: true,
  },
  {
    id: "MPP-14",
    name: "Commitment Replay Rejection",
    protocol: "mpp-channel",
    specRef: "MPP Channel Guide §closing-the-channel; @stellar/mpp channel server",
    summary: "A captured (amount, signature) pair must not be redeemable against a new challenge.",
    negative: true,
  },
];
