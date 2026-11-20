/**
 * The inputs of the Action and the command lines built from them.
 *
 * Nothing here imports Wasit: this file runs in the step that checks the inputs,
 * before the install step has built anything. Every value reaches the CLI as one
 * element of an argument list, never as text for a shell, and a value that is
 * not a plain name is refused without being printed back.
 */

/** A name of an endpoint or an environment, as the config loader allows (packages/core/src/config.ts). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ENDPOINTS = 50;
const MAX_CONFIG_PATH = 300;
const DEFAULT_CONFIG = "wasit.config.json";

/** The inputs are wrong. The message says which input and what is allowed, and never quotes the value. */
export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

/**
 * The input asked for mainnet (spec B5). This version has no mainnet opt-in, so
 * the input exists only to be refused, before Wasit is installed (spec B12). The
 * step that checks the inputs writes this message to the job summary too.
 */
export class MainnetRefusedError extends InputError {
  constructor(message) {
    super(message);
    this.name = "MainnetRefusedError";
  }
}

/** An event name as GitHub writes them; anything else is never echoed. */
const EVENT_NAME = /^[a-z_]{1,64}$/;

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Refuses `mainnet: true`, always; refuses a value that is not true or false. */
function checkMainnet(env) {
  const value = trimmed(env["INPUT_MAINNET"]).toLowerCase();
  if (value === "" || value === "false") return;
  if (value !== "true") throw new InputError("mainnet must be true or false.");
  const event = typeof env["GITHUB_EVENT_NAME"] === "string" ? env["GITHUB_EVENT_NAME"] : "";
  const eventRule =
    event === "workflow_dispatch"
      ? ""
      : ` The input is also refused on every event but workflow_dispatch, and this run's event is ${EVENT_NAME.test(event) ? event : "another event"}.`;
  throw new MainnetRefusedError(
    "mainnet: true is refused: the mainnet opt-in is not part of this version. Wasit pays on test networks only." +
      `${eventRule} Nothing was installed, started, sent or signed.`,
  );
}

/**
 * Reads and checks the inputs from the step's environment (`INPUT_CONFIG`,
 * `INPUT_ENVIRONMENT`, `INPUT_TIER`, `INPUT_ENDPOINTS`, `INPUT_MAINNET`, and the
 * event name). `mainnet: true` is refused here, so it never reaches the CLI.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ config: string, environment: string | undefined, tier: "read-only" | "payment", endpoints: string[] }}
 */
export function parseInputs(env) {
  // pull_request_target hands the base repository's token and secrets to a workflow that runs a pull request's code.
  if (env["GITHUB_EVENT_NAME"] === "pull_request_target") {
    throw new InputError(
      "this action does not run on pull_request_target: it would give the code of a pull request the token and the secrets of the base repository. Use pull_request.",
    );
  }

  // B12: no mainnet opt-in in this version. Refused before anything else is read.
  checkMainnet(env);

  // Whether this event may pay is the CLI's to say (D-022a): on a pull request it runs the
  // read-only checks and says so, and it refuses a payer key given to a run that may not pay.
  const tier = trimmed(env["INPUT_TIER"]) || "read-only";
  if (tier !== "read-only" && tier !== "payment") throw new InputError("tier must be read-only or payment.");

  const config = trimmed(env["INPUT_CONFIG"]) || DEFAULT_CONFIG;
  if (/[\u0000-\u001f\u007f]/.test(config) || config.length > MAX_CONFIG_PATH || config.startsWith("-")) {
    throw new InputError(`config must be a file path of at most ${MAX_CONFIG_PATH} characters, with no control character, that does not start with a hyphen.`);
  }

  const environment = trimmed(env["INPUT_ENVIRONMENT"]);
  if (environment !== "" && !NAME.test(environment)) {
    throw new InputError("environment must be a name: letters, digits, dot, underscore and hyphen, at most 64 characters.");
  }

  const endpoints = [
    ...new Set(
      trimmed(env["INPUT_ENDPOINTS"])
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    ),
  ];
  if (endpoints.length > MAX_ENDPOINTS) throw new InputError(`endpoints lists more than ${MAX_ENDPOINTS} names.`);
  if (endpoints.some((entry) => !NAME.test(entry))) {
    throw new InputError("each entry of endpoints must be a name: letters, digits, dot, underscore and hyphen, at most 64 characters; separate them with commas or line breaks.");
  }

  return { config, environment: environment === "" ? undefined : environment, tier, endpoints };
}

/**
 * The one call that runs Wasit: `wasit run [--read-only] --start-if-local --json --out`: the CLI starts service.start only when it is set and the environment is on this machine.
 * The payment tier is the same call without --read-only. No flag that opts into mainnet or carries a key is offered.
 *
 * @param {ReturnType<typeof parseInputs>} inputs
 * @param {{ cli: string, report: string, baseline?: string }} paths
 * @returns {string[]} the arguments after `node`
 */
export function buildRunArgs(inputs, paths) {
  return [
    paths.cli,
    "run",
    ...(inputs.tier === "payment" ? [] : ["--read-only"]),
    "--start-if-local",
    "--json",
    "--out",
    paths.report,
    ...(paths.baseline === undefined || paths.baseline === "" ? [] : ["--baseline", paths.baseline]),
    "--config",
    inputs.config,
    ...(inputs.environment === undefined ? [] : ["--env", inputs.environment]),
    ...inputs.endpoints.flatMap((name) => ["--endpoint", name]),
  ];
}

/**
 * The call that turns the report into the comment, the summary and the next baseline.
 *
 * The history file and the run id (D-022b) come after the baseline; each is left
 * out when it is empty.
 *
 * @param {{ cli: string, report: string, comment: string, baselineOut: string, checkRun?: string, baseline?: string, history?: string, baselineRun?: string }} paths
 * @returns {string[]}
 */
export function buildReportArgs(paths) {
  return [
    paths.cli,
    "ci-report",
    "--report",
    paths.report,
    "--comment",
    paths.comment,
    "--baseline-out",
    paths.baselineOut,
    ...(paths.checkRun === undefined || paths.checkRun === "" ? [] : ["--check-run", paths.checkRun]),
    ...(paths.baseline === undefined || paths.baseline === "" ? [] : ["--baseline", paths.baseline]),
    ...(paths.history === undefined || paths.history === "" ? [] : ["--history", paths.history]),
    ...(paths.baselineRun === undefined || paths.baselineRun === "" ? [] : ["--baseline-run", paths.baselineRun]),
  ];
}

/**
 * The variables that carry the job's token. The steps that run Wasit are not
 * given them, and the wrapper takes them out of the environment it hands the CLI
 * all the same: the service the CLI starts runs code from the pull request.
 */
export const TOKEN_VARIABLES = Object.freeze([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
]);

/**
 * A copy of `env` without the job's token variables and the runner's own
 * `ACTIONS_` ones (the cache and the OIDC endpoints). Names are compared in upper case.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function scrubTokens(env) {
  const clean = {};
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (value === undefined || upper === "GH_TOKEN" || upper === "GITHUB_TOKEN" || upper.startsWith("ACTIONS_")) continue;
    clean[name] = value;
  }
  return clean;
}
