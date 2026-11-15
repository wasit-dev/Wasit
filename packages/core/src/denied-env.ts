/**
 * The environment variables Wasit keeps away from the service it starts, and
 * whose values it keeps out of every output.
 *
 * The names are fixed in code, not configurable (spec A1): a changed config must
 * never be able to make a run read another key, or let one reach a service. They
 * are the five variables the checks read their keys from, the one mainnet payer
 * variable, and the whole `WASIT_` namespace, which covers `WASIT_HEADER_*`,
 * `WASIT_RPC_URL` and anything added later.
 *
 * A deny-list, not an allow-list, on purpose: the service is the builder's own
 * app and needs variables Wasit cannot list (PATH, HOME, NODE_OPTIONS, its own
 * facilitator and database settings). The threat is Wasit's own variable names,
 * and those are known. A key under a name Wasit does not know is not removed.
 */

/** The variables the checks read a key from. */
export const DENIED_ENV_NAMES: readonly string[] = [
  "STELLAR_PRIVATE_KEY",
  "EVM_PRIVATE_KEY",
  "SVM_PRIVATE_KEY",
  "MPP_PAYER_SECRET",
  "COMMITMENT_SECRET_HEX",
  "WASIT_MAINNET_PAYER_SECRET",
];

/**
 * The runner's own variables, kept from the service as well. The command files
 * are read by the runner after the step: a service that writes `GITHUB_ENV` or
 * `GITHUB_PATH` changes the environment or the PATH of the later steps, which
 * hold the job's token. The tokens are the job's own credentials. This is
 * hygiene, not isolation: the service runs as the job's user and can still look
 * in the runner's directories. Not in {@link DENIED_ENV_NAMES}: their values are
 * paths, not keys, and `GITHUB_STEP_SUMMARY` is what `wasit ci-report` writes to.
 */
const RUNNER_ENV_NAMES: readonly string[] = [
  "GITHUB_ENV",
  "GITHUB_PATH",
  "GITHUB_OUTPUT",
  "GITHUB_STATE",
  "GITHUB_STEP_SUMMARY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
];

/** Every variable in this namespace is Wasit's own. */
const WASIT_PREFIX = "WASIT_";

/** The variables whose value is a header Wasit sends or the RPC url, in the `WASIT_` namespace. */
const HEADER_PREFIX = "WASIT_HEADER_";
const RPC_VARIABLE = "WASIT_RPC_URL";

/**
 * True when a service must not see this variable.
 *
 * Compared in upper case: a Windows environment is case-insensitive, so a
 * variable spelt `Stellar_Private_Key` is the same one there. Dropping a
 * differently spelt variable on other systems costs nothing.
 */
export function isDeniedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return DENIED_ENV_NAMES.includes(upper) || RUNNER_ENV_NAMES.includes(upper) || upper.startsWith(WASIT_PREFIX);
}

/** A copy of `env` without the denied variables and without unset ones. */
export function scrubEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !isDeniedEnvName(name)) clean[name] = value;
  }
  return clean;
}

/**
 * The values no output may carry: the keys, the header values and the RPC url
 * (which often carries a key). Pass them to the sanitiser's `redact` option.
 * Empty values are left out.
 */
export function deniedEnvValues(env: Readonly<Record<string, string | undefined>>): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === "") continue;
    const upper = name.toUpperCase();
    if (DENIED_ENV_NAMES.includes(upper) || upper.startsWith(HEADER_PREFIX) || upper === RPC_VARIABLE) values.push(value);
  }
  return values;
}
