/**
 * The mainnet opt-in switches (spec B5), as this version has them: switches
 * that always refuse (spec B12).
 *
 * A later version may let an x402 run pay on `stellar:pubnet` behind an
 * explicit opt-in. This one does not, and it has no code path that answers
 * "allowed" for it. The switches that opt-in would read exist here only so
 * that a run, a workflow or a server that asks for mainnet is stopped and told
 * why, instead of being run on whatever else it was given:
 *
 * - `--mainnet` on `wasit run` (never read from the config or the environment);
 * - `WASIT_MAINNET_OPT_IN` and `WASIT_MAINNET_CONFIG`, the MCP server's
 *   start-up variables, and `--mainnet` among its arguments: the server does
 *   not start.
 *
 * The Action's `mainnet` input is refused by the Action's own input check,
 * which runs before Wasit is installed and so cannot import this module.
 *
 * Every function here throws, or only says which switches are set.
 */

import { ConfigurationError } from "../errors.js";
import { NETWORK_CLASSES } from "./networks.js";

/** The sentence of spec B12. */
export const MAINNET_OPT_IN_ABSENT = "the mainnet opt-in is not part of this version";

/** A switch that asks for mainnet: the CLI's flag, or one of the MCP server's start-up settings. */
export type MainnetSwitch = "--mainnet" | "WASIT_MAINNET_OPT_IN" | "WASIT_MAINNET_CONFIG";

/** The MCP server's start-up variables that ask for mainnet. */
const STARTUP_VARIABLES = ["WASIT_MAINNET_OPT_IN", "WASIT_MAINNET_CONFIG"] as const;

/** An event name as GitHub writes them; anything else is never echoed. */
const EVENT_NAME = /^[a-z_]{1,64}$/;

/**
 * A switch asked for mainnet, and this version has no mainnet opt-in. A
 * `ConfigurationError`: it says nothing about any service. Nothing was read,
 * sent or signed when it is thrown.
 */
export class MainnetOptInRefusedError extends ConfigurationError {
  public readonly switchName: MainnetSwitch;

  public constructor(switchName: MainnetSwitch, message: string) {
    super(message);
    this.name = "MainnetOptInRefusedError";
    this.switchName = switchName;
  }
}

function testNetworks(): string {
  return [...NETWORK_CLASSES]
    .filter(([, kind]) => kind === "test")
    .map(([network]) => network)
    .join(", ");
}

/**
 * Refuses a switch that asks for mainnet. Always throws.
 *
 * For `--mainnet`, `context.event` is the GitHub event of the run when it runs
 * in GitHub Actions: on any event but `workflow_dispatch` the message says that
 * rule as well, so a push or a schedule with the switch set reads as refused for
 * that reason too.
 *
 * @throws {MainnetOptInRefusedError} Always.
 */
export function refuseMainnetSwitch(switchName: MainnetSwitch, context: { readonly event?: string } = {}): never {
  const networks = `Wasit pays on test networks only (${testNetworks()}).`;
  if (switchName === "--mainnet") {
    const event = context.event;
    const eventRule =
      event === undefined || event === "workflow_dispatch"
        ? ""
        : ` --mainnet is also refused on every GitHub event but workflow_dispatch, and this run's event is ` +
          `${EVENT_NAME.test(event) ? event : "another event"}.`;
    throw new MainnetOptInRefusedError(
      switchName,
      `--mainnet is refused: ${MAINNET_OPT_IN_ABSENT}. ${networks}${eventRule} ` +
        `The config was not read, and nothing was started, sent or signed.`,
    );
  }
  throw new MainnetOptInRefusedError(
    switchName,
    `${switchName} is set: ${MAINNET_OPT_IN_ABSENT}, so this server does not start. ${networks} ` +
      `Nothing was read, sent or signed. Remove ${switchName} from the server's environment to start it.`,
  );
}

/**
 * The switches that ask the MCP server for mainnet at start-up: `--mainnet`
 * among its arguments (with or without a value), and each start-up variable
 * that holds a value that is not blank. Any value counts, "0" included: the
 * variable is there to be removed. Names are compared in upper case, as a
 * Windows environment does.
 *
 * @param env the server's environment
 * @param args the server's arguments, after the script (`process.argv.slice(2)`)
 */
export function mainnetStartupSwitches(
  env: Readonly<Record<string, string | undefined>>,
  args: readonly string[],
): MainnetSwitch[] {
  const found: MainnetSwitch[] = [];
  if (args.some((arg) => arg === "--mainnet" || arg.startsWith("--mainnet="))) found.push("--mainnet");
  const set = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim() !== "") set.add(name.toUpperCase());
  }
  for (const name of STARTUP_VARIABLES) if (set.has(name)) found.push(name);
  return found;
}
