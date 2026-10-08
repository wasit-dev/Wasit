export interface EnvironmentCheck {
  readonly label: string;
  readonly ready: boolean;
}

/**
 * What Home shows before anything runs, so a missing key surfaces up front
 * on the menu screen instead of after picking an action, typing a target
 * URL, and only then hitting RunView's "could not run this check" screen.
 *
 * All three payer roles are listed, including x402's: the wallet screen can
 * create and fund a key for every one of them, and showing only two of the
 * three made the third look like it was not a role the tool knew about. The
 * x402 payer keys for Base Sepolia and Solana devnet are listed too: `wasit
 * test --network` pays with them, and `wasit wallet create --network` makes
 * them.
 */
export function getEnvironmentStatus(): readonly EnvironmentCheck[] {
  return [
    {
      label: "STELLAR_PRIVATE_KEY (x402 payment)",
      ready: Boolean(process.env.STELLAR_PRIVATE_KEY),
    },
    {
      label: "EVM_PRIVATE_KEY (x402 payment, Base Sepolia)",
      ready: Boolean(process.env.EVM_PRIVATE_KEY),
    },
    {
      label: "SVM_PRIVATE_KEY (x402 payment, Solana devnet)",
      ready: Boolean(process.env.SVM_PRIVATE_KEY),
    },
    {
      label: "MPP_PAYER_SECRET (MPP charge)",
      ready: Boolean(process.env.MPP_PAYER_SECRET),
    },
    {
      label: "COMMITMENT_SECRET_HEX (MPP channel)",
      ready: Boolean(process.env.COMMITMENT_SECRET_HEX),
    },
  ];
}
