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
  /**
   * What to change when the check fails, in one or two sentences. A result
   * may carry a more specific `hint` for the cause it found; this is the
   * fallback, so every failure comes with something to act on.
   */
  readonly fix: string;
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
    fix: "Answer an unpaid request with 402 Payment Required and the challenge in a PAYMENT-REQUIRED header. A 200 means the route serves without payment; a 404 often means the wrong path or method (try --method POST).",
  },
  {
    id: "X402-02",
    name: "Payment Header Present",
    protocol: "x402",
    specRef: "x402 built-on-stellar guide",
    summary: "The 402 response must include a payment header.",
    fix: "Send the challenge as base64-encoded JSON in a PAYMENT-REQUIRED response header, as the x402 v2 HTTP transport defines.",
  },
  {
    id: "X402-03",
    name: "Header Payload Decodable",
    protocol: "x402",
    specRef: "x402 spec §payment-required-object",
    summary: "The header value must be valid base64 that decodes to JSON.",
    fix: "Base64-encode the JSON PaymentRequired object for the PAYMENT-REQUIRED header; the value must decode to valid JSON.",
  },
  {
    id: "X402-04",
    name: "Required Fields Present",
    protocol: "x402",
    specRef: "x402 spec §payment-required-object",
    summary:
      "Every payment option must carry each field its advertised version requires, with the right types.",
    fix: "Give every option in `accepts` the fields its x402Version requires (v2: scheme, network, amount, asset, payTo, maxTimeoutSeconds).",
  },
  {
    id: "X402-05",
    name: "Network Identifier Valid",
    protocol: "x402",
    specRef: "x402 v2 spec §11.1; CAIP-2",
    summary:
      "Every advertised network identifier must be CAIP-2, and follow its namespace's rules where Wasit knows them (stellar, eip155, solana).",
    fix: "Name each network with its CAIP-2 id, such as stellar:testnet or eip155:84532.",
  },
  {
    id: "X402-06",
    name: "Signature Resubmit Accepted",
    protocol: "x402",
    specRef: "x402 spec §payment-flow",
    summary: "A resubmitted request carrying a valid signature must be accepted.",
    costsFunds: true,
    fix: "After a valid payment, settle it, serve the resource with a 2xx, and return a PAYMENT-RESPONSE header naming the transaction that moved exactly the advertised amount of the asset to payTo.",
  },
  {
    id: "X402-07",
    name: "Invalid Signature Rejected",
    protocol: "x402",
    specRef: "x402 spec §payment-flow",
    summary: "A deliberately corrupted signature must be rejected, not accepted.",
    negative: true,
    costsFunds: true,
    fix: "Verify every payment before serving: pass it to the facilitator's verify step and refuse it when verification fails. Never serve on a payload that was only decoded.",
  },
  {
    id: "MPP-01",
    name: "Charge Settlement On-Chain",
    protocol: "mpp-charge",
    specRef: "MPP Charge Guide; CAP-46 transfer events",
    summary: "The charge settles on-chain for exactly what the target advertised.",
    costsFunds: true,
    fix: "Settle each charge on-chain for exactly the advertised amount, currency and recipient, from the paying account, and reference that transaction in the Payment-Receipt header.",
  },
  {
    id: "MPP-10",
    name: "Channel Deploy",
    protocol: "mpp-channel",
    specRef: "MPP Channel Guide",
    summary:
      "The channel contract deploys correctly and is the same channel the target bills through.",
    fix: "Bill through the channel advertised in the 402 challenge, opened with the token, funder, recipient and refund waiting period you expect.",
  },
  {
    id: "MPP-11",
    name: "Cumulative Commitment Ordering",
    protocol: "mpp-channel",
    specRef: "MPP Channel Guide §closing-the-channel; @stellar/mpp channel server",
    summary:
      "A commitment must exceed the stored cumulative and cover the price of the current request.",
    fix: "Refuse with 402 any commitment that does not exceed the stored cumulative amount, or that does not cover the price of the current request.",
  },
  {
    id: "MPP-12",
    name: "Challenge Replay Rejection",
    protocol: "mpp-channel",
    specRef: "MPP Channel Guide §closing-the-channel; @stellar/mpp channel server",
    summary: "A byte-identical credential resubmitted against the same challenge must be rejected.",
    negative: true,
    fix: "Record each challenge id when a credential for it is accepted, and refuse a second credential for the same challenge with 402.",
  },
  {
    id: "MPP-13",
    name: "Close Settlement",
    protocol: "mpp-channel",
    specRef: "MPP Channel Guide §closing-the-channel",
    summary: "Closing with the highest commitment settles on-chain. Permanently ends the channel.",
    destructive: true,
    costsFunds: true,
    fix: "On close, settle the highest commitment on-chain: `withdrawn` must equal the committed amount and `closeEffectiveAtLedger` must be set.",
  },
  {
    id: "MPP-14",
    name: "Commitment Replay Rejection",
    protocol: "mpp-channel",
    specRef: "MPP Channel Guide §closing-the-channel; @stellar/mpp channel server",
    summary: "A captured (amount, signature) pair must not be redeemable against a new challenge.",
    negative: true,
    fix: "Refuse with 402 a previously accepted commitment presented under a new challenge: the cumulative amount must strictly increase.",
  },
];

/** Where each protocol's checks are documented on the site. */
const DOCS_URLS: Readonly<Record<ProtocolId, string>> = {
  x402: "https://usewasit.dev/docs/checks/x402",
  "mpp-charge": "https://usewasit.dev/docs/checks/mpp-charge-mode",
  "mpp-channel": "https://usewasit.dev/docs/checks/mpp-channel-mode",
};

/** The catalogue entry for a check id, if there is one (PREFLIGHT has none). */
export function catalogueEntry(id: string): CheckCatalogueEntry | undefined {
  return CHECK_CATALOGUE.find((entry) => entry.id === id);
}

/** The docs page for a check id, if it is in the catalogue. */
export function docsUrlFor(id: string): string | undefined {
  const entry = catalogueEntry(id);
  return entry === undefined ? undefined : DOCS_URLS[entry.protocol];
}
