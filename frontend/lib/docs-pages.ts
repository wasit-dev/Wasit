/**
 * The hand-authored docs pages — Overview, Getting Started and Install.
 *
 * Everything under CLI Guide, MCP Guide, Core Guide, Configuration, Check
 * Catalogue and Security Policy is republished from a repo markdown file
 * and cannot drift (see GROUP_SOURCE_FILES in lib/content.ts). These
 * three groups have no such file behind them: they orient a reader and
 * get them running, which is a job the repo's own docs do not have.
 *
 * They live here rather than in lib/content.ts so that file stays what
 * it is — the resolver — instead of half resolver and half prose.
 *
 * Two rules keep these pages honest, since nothing mechanical enforces
 * them the way assertDocsInSync enforces the republished ones:
 *
 *   - Every command shown here must be one that actually works against
 *     the published packages. `wasit test` is shown WITH --read-only,
 *     matching README.md: without it, the payment checks run whenever
 *     STELLAR_PRIVATE_KEY is set, and dotenv reads .env from whatever
 *     directory the command was run in.
 *   - Version and support claims state what the repo declares or what
 *     has actually been verified, and say which is which.
 */

/** Getting Started → Requirements. */
export const REQUIREMENTS_MD = `# Requirements

Wasit is a Node command-line tool and an MCP server. There is nothing to
compile, no native dependency, and no service to run.

## Runtime

- **Node.js 22 or newer.** All three packages declare \`"node": ">=22"\`.
- **npm**, which ships with Node.
- **macOS, Linux, or Windows.** Nothing in Wasit is platform-specific.

Continuous integration builds and tests on Node 22 and Node 24. Node 26
works too — the full build, typecheck and test suite has been run on it.

> **Note** — Wasit is testnet-only. Every check, and every key it reads,
> targets Stellar testnet. There is no mainnet mode and no flag that
> enables one.

## A Stellar testnet account

Only for the checks that move money. The read-only x402 checks
(\`X402-01\`–\`05\`) need no key, no funds, and no account — that is the
whole point of starting there.

This table is about what you have to **obtain**. For the authoritative
list of which environment variable each check reads — including
\`MPP_STELLAR_NETWORK\` and the extra opt-in \`MPP-13\` needs — see
[What each check needs](/docs/configuration/check-requirements).

| You want to run | You need to have |
| --- | --- |
| \`X402-01\`–\`05\` | Nothing at all |
| \`X402-06\`, \`07\` | A testnet account funded with XLM **and** the asset the target charges in, usually USDC |
| \`MPP-01\` | A testnet account funded with XLM **and** USDC |
| \`MPP-10\`–\`14\` | A commitment signing key — no funds, no account |

\`wasit wallet create\` generates any of these and \`wasit wallet fund\`
funds them from Friendbot — see [Quick setup](/docs/start/quick-setup).

## AI clients, for the MCP server

The MCP server speaks **stdio**, so it needs a client that can launch a
local server process. A client that only supports remote HTTP connectors
cannot run it at all.

| Client | Works with Wasit |
| --- | --- |
| Claude Code | Verified — exact \`claude mcp add\` command in the [MCP Guide](/docs/mcp/overview) |
| Claude Desktop | Verified — config file snippet in the [MCP Guide](/docs/mcp/overview) |
| VS Code (GitHub Copilot) | Compatible, not yet verified — supports local stdio servers |
| Cursor | Compatible, not yet verified — supports local stdio servers |
| ChatGPT | **Not compatible** — its connectors are remote HTTP only |

> **Note** — "Verified" means the exact steps in the MCP Guide were run
> against this package. "Compatible, not yet verified" means the client
> documents support for local stdio MCP servers, which is all Wasit
> needs, but nobody has run it there yet. If you do, the repo would
> welcome the report.

The CLI needs none of this. Only the MCP server does.
`;

/** Getting Started → Try it in one command. */
export const TRY_IT_MD = `# Try it in one command

No install, no keys, no signup, and nothing settles on-chain:

\`\`\`bash
npx @wasit-dev/cli test --target https://your-service.example/paid --read-only
\`\`\`

Point \`--target\` at any endpoint that answers HTTP 402. That runs
\`X402-01\` through \`X402-05\` — the read-only half of the x402 suite —
and prints one line per check:

\`\`\`
PASS  X402-01  402 Response Status
      Server responded with 402 as required.

PASS  X402-02  Payment Header Present
      Challenge header present on the 402 response.

FAIL  X402-03  Header Payload Decodable
      Base64 decoded, but the result is not valid JSON.

2 passed, 1 failed.
\`\`\`

Every result carries its own detail line, passes included — a check that
passed still tells you what it accepted.

> **Note** — \`--read-only\` is what keeps this free. Drop it and the
> payment checks \`X402-06\`/\`07\` run as soon as a \`STELLAR_PRIVATE_KEY\`
> is available, settling a real testnet payment. The CLI reads \`.env\`
> from the directory you run it in, so "I did not pass a key" is not the
> same as "no key is set".

## What the exit code means

Useful immediately, because it is what a CI job reads:

| Code | Meaning |
| --- | --- |
| \`0\` | Every check that ran conformed |
| \`1\` | At least one conformance failure |
| \`2\` | At least one check produced no verdict — unreachable target, bad config |

A run with both a failure and an error exits \`1\`: a real finding
outranks a missing one.

## Browse the checks without running any

\`\`\`bash
npx @wasit-dev/cli checks
\`\`\`

Lists all sixteen checks with the subcommand that runs each, and flags
the ones that are negative, destructive, or spend funds. It contacts
nothing.

Ready for the checks that settle? [Quick setup](/docs/start/quick-setup)
gets you a funded testnet wallet.
`;

/** Getting Started → Quick setup. */
export const QUICK_SETUP_MD = `# Quick setup

For the checks that settle a payment — \`X402-06\`/\`07\`, \`MPP-01\`, and the
channel suite. If you only need the read-only checks, [Try it in one
command](/docs/start/try-it) is the whole story and you can stop there.

Three steps: install the CLI, generate testnet keys, fund them.

## Install the CLI

\`\`\`bash
npm install -g @wasit-dev/cli
\`\`\`

Identical on every platform. [Packages](/docs/install/packages) covers
running it without a global install, and the other two packages.

## Create a working directory

The CLI reads a \`.env\` file from the directory you run it in, so give it
one of its own rather than scattering keys through your projects.

### macOS / Linux

\`\`\`bash
mkdir wasit-testnet && cd wasit-testnet
touch .env
chmod 600 .env
\`\`\`

### Windows (PowerShell)

\`\`\`powershell
New-Item -ItemType Directory wasit-testnet
Set-Location wasit-testnet
New-Item -ItemType File .env
\`\`\`

> **Note** — \`.env\` holds Stellar secret keys. On macOS and Linux,
> \`chmod 600\` makes it readable only by you; Windows files are already
> restricted to your user profile by default. Never commit it.

## Generate and fund a key

\`wasit wallet\` does both. It is testnet-only and has no \`--network\`
flag, so there is nothing here that can be pointed at mainnet by mistake.

\`\`\`bash
wasit wallet create --role mpp-charge --fund
\`\`\`

That prints a new keypair, funds it with 10,000 testnet XLM through
Friendbot, and shows the exact \`.env\` lines to paste. Repeat with
\`--role x402\` or \`--role mpp-channel\` for the other suites.

> **Note** — the secret is printed to your terminal. Do not run this on a
> screen you are recording, and never paste a mainnet key into these
> variables.

Paste what it printed into \`.env\`:

\`\`\`
MPP_PAYER_SECRET=S...
MPP_PAYER_PUBLIC=G...
\`\`\`

### Adding USDC

\`MPP-01\` pays in USDC, so that key needs a USDC balance as well as XLM:

\`\`\`bash
wasit wallet fund --role mpp-charge --asset usdc
\`\`\`

An x402 target charges in whatever asset its challenge advertises, which
is usually USDC too; fund that key the same way with \`--role x402\`.

This opens the Circle testnet USDC trustline automatically. Receiving an
actual balance needs one manual step, because no scriptable testnet USDC
faucet exists for Stellar: paste the printed public key into
[faucet.circle.com](https://faucet.circle.com), or set
\`WASIT_USDC_DISTRIBUTOR_SECRET\` to an account you already funded that
way and every later run sends from it automatically.

## Check what you have

\`\`\`bash
wasit wallet status
\`\`\`

Prints each configured role's address and balances, or tells you which
variable is still unset.

## Run a settling check

\`\`\`bash
wasit mpp-charge --target https://your-service.example/data
\`\`\`

> **Note** — this one is not idempotent and has no read-only mode. Every
> run settles a real testnet payment and moves funds.

From here: the [CLI Guide](/docs/cli/overview) has every subcommand and
flag, [Configuration](/docs/configuration/overview) every environment
value, and the [Check Catalogue](/docs/checks/overview) each check's pass
criteria and spec citation.
`;

/** Install → Packages. */
export const PACKAGES_MD = `# Packages

Wasit ships as three npm packages under the \`@wasit-dev\` scope. Install
only the ones you need — most people need the first.

| Package | What it is |
| --- | --- |
| [\`@wasit-dev/cli\`](https://www.npmjs.com/package/@wasit-dev/cli) | The \`wasit\` terminal command, and the interactive dashboard |
| [\`@wasit-dev/server\`](https://www.npmjs.com/package/@wasit-dev/server) | The MCP server, for Claude Code, Claude Desktop, and other stdio clients |
| [\`@wasit-dev/core\`](https://www.npmjs.com/package/@wasit-dev/core) | The check suites as a library, for building on top of Wasit directly |

The CLI and the MCP server are both thin adapters over core, so there is
exactly one implementation of every check: a terminal run and an agent's
run can never disagree about the same target.

## Run it without installing

\`\`\`bash
npx @wasit-dev/cli test --target https://your-service.example/paid --read-only
\`\`\`

Right for a one-off check or a CI job that should pin nothing.

## Install it globally

\`\`\`bash
npm install -g @wasit-dev/cli
wasit --version
\`\`\`

Right if you will run it more than once. Gives you the bare \`wasit\`
command, which with no arguments opens the interactive dashboard.

## As a dependency

\`\`\`bash
npm install @wasit-dev/core
\`\`\`

For calling the check suites from your own code — a custom reporter, a
test harness, a service of your own. The [Core Guide](/docs/core/overview)
documents every exported function and result shape.

## The MCP server

Not installed by hand. The client launches it, usually through \`npx\`, so
it stays up to date without a global install:

\`\`\`bash
npx -y @wasit-dev/server
\`\`\`

The [MCP Guide](/docs/mcp/overview) has the exact registration command for
Claude Code and the config file for Claude Desktop.
`;

/** Install → From source. */
export const FROM_SOURCE_MD = `# From source

Only needed to change Wasit itself, or to run the bundled fixture servers
that let you try a full settlement run against something you control.

\`\`\`bash
git clone https://github.com/wasit-dev/wasit.git
cd wasit
npm install
npm run build
cp .env.example .env
\`\`\`

On Windows PowerShell the last line is:

\`\`\`powershell
Copy-Item .env.example .env
\`\`\`

> **Note** — build order matters. \`npm run build\` builds core first, then
> the CLI and the server, because both compile against core's emitted
> type declarations rather than its source. Building a package on its own
> after changing core will typecheck against the previous build.

## Run the checks against your own fixtures

Three fixture servers ship with the repo — real servers built on the
official SDKs, not mocks. Each runs in its own terminal:

\`\`\`bash
npx tsx packages/core/test/fixtures/x402-real-server.ts
npx tsx packages/core/test/fixtures/mpp-charge-server.ts
npx tsx packages/core/test/fixtures/mpp-channel-server.ts
\`\`\`

Then point the CLI at them:

\`\`\`bash
node packages/cli/dist/index.js test --target http://localhost:3001/protected
\`\`\`

## Tests

\`\`\`bash
npm test
npm run typecheck -w packages/core
npm run typecheck -w packages/cli
\`\`\`

The whole suite is offline: no keys, no target, no network. Run
\`npm run build\` before \`npm run typecheck -w packages/cli\`, since the CLI
typechecks against core's compiled declarations.
`;

/** Install → Verify the install. */
export const VERIFY_MD = `# Verify the install

Four checks, in the order worth running them.

## The command exists

\`\`\`bash
wasit --version
\`\`\`

Prints the installed version, read from the package's own manifest at
runtime rather than a hardcoded string, so it cannot disagree with what
npm actually published.

If your shell reports "command not found" after a global install, npm's
global \`bin\` directory is not on your \`PATH\`. \`npm prefix -g\` prints
where it went.

## It can list its own checks

\`\`\`bash
wasit checks
\`\`\`

Contacts nothing and needs no keys. If this prints sixteen checks, the
install is sound and the problem in any later failure is configuration or
the target, not Wasit.

## It reads your configuration

\`\`\`bash
wasit wallet status
\`\`\`

Prints each configured role's address and balances. A role you have not
set up reports which variable is missing rather than failing.

> **Note** — a key that is set but malformed — a truncated paste, or a
> \`G...\` public key where a secret belongs — is reported by name against
> that one role, and the other roles are still checked.

## It exits the way CI expects

\`\`\`bash
wasit test --target https://your-service.example/paid --read-only
echo $?
\`\`\`

On Windows PowerShell:

\`\`\`powershell
wasit test --target https://your-service.example/paid --read-only
$LASTEXITCODE
\`\`\`

\`0\` means everything that ran conformed, \`1\` a conformance failure, and
\`2\` that a check produced no verdict at all — an unreachable target or a
misconfigured run. A CI job that treats \`2\` as a test failure will blame
your service for what is really a broken pipeline.
`;
