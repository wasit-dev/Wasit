# MCP Guide

The MCP server exposes the same check suites as the CLI over the Model Context
Protocol, so an agent can run a compliance check and read the result as
structured data.

Transport is stdio. As of `@wasit-dev/server@0.1.0` the package is published on
npm, so no local checkout is required to run it — `npx @wasit-dev/server`
downloads and runs the binary on demand. A local checkout still works the same
way (`node packages/server/dist/index.js`) and is only needed if you're
developing Wasit itself.

## Claude Code & Claude Desktop

### Claude Code

Add the server with `claude mcp add`, passing your Stellar testnet credentials
as environment variables:

```bash
claude mcp add --transport stdio wasit \
  --env MPP_STELLAR_NETWORK=stellar:testnet \
  --env STELLAR_PRIVATE_KEY=S... \
  --env MPP_PAYER_SECRET=S... \
  --env COMMITMENT_SECRET_HEX=... \
  -- npx -y @wasit-dev/server
```

This registers the server at `local` scope (current project only). Add
`--scope user` instead if you want it available in every project, or
`--scope project` to commit a shared `.mcp.json` for a team. Verify it
connected with `claude mcp list`, then ask Claude Code directly, for example
"run wasit_x402_test against https://my-service.example.com".

To remove it later: `claude mcp remove wasit`.

### Claude Desktop

Open Settings, go to the Developer tab, and click "Edit Config". This opens
(or creates) the config file at:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add a `wasit` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "wasit": {
      "command": "npx",
      "args": ["-y", "@wasit-dev/server"],
      "env": {
        "MPP_STELLAR_NETWORK": "stellar:testnet",
        "STELLAR_PRIVATE_KEY": "S...",
        "MPP_PAYER_SECRET": "S...",
        "COMMITMENT_SECRET_HEX": "..."
      }
    }
  }
}
```

Save the file and fully quit and restart Claude Desktop (not just close the
window — use the Claude menu, Quit). The wasit tools then appear under the
connectors indicator in the message box. If the server doesn't show up, check
`~/Library/Logs/Claude/mcp-server-wasit.log` (macOS) or
`%APPDATA%\Claude\logs\mcp-server-wasit.log` (Windows) for the stderr output.

## Manual / other clients

Any MCP client that supports stdio works the same way — point `command` at
`npx`, `args` at `["-y", "@wasit-dev/server"]`, and set the environment
variables above. Use absolute paths for `node packages/server/dist/index.js`
if launching from a local checkout instead of npx, since a client launches the
server from a working directory you don't control.

## Tools

| Tool | Checks | Cost |
|---|---|---|
| `wasit_x402_test` | `X402-01`–`07` | `06`/`07` settle real payments |
| `wasit_mpp_charge_test` | `MPP-01` | Settles a real payment every call |
| `wasit_mpp_channel_test` | `MPP-10`–`12`, `14` | Free |
| `wasit_mpp_channel_test_with_close` | + `MPP-13` | **Destroys a channel** |

The fourth is registered **only** when the server is started with
`WASIT_ALLOW_DESTRUCTIVE=1` or `--allow-destructive`. Without that opt-in it
does not appear in `tools/list` at all. Set it as an extra `--env
WASIT_ALLOW_DESTRUCTIVE=1` (Claude Code) or `"env"` entry (Claude Desktop) if
you intend to use it — otherwise leave it out, which is the safer default.

Verify which tools a configuration exposes:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | npx -y @wasit-dev/server \
  | python3 -c "import sys,json; print([t['name'] for t in json.load(sys.stdin)['result']['tools']])"
```

## Resource

`wasit://checks` serves `docs/CHECKS.md` — the authority on what each check
asserts. An agent should read it before interpreting a result rather than
inferring pass criteria from a check's name. As of `@wasit-dev/server@0.1.1`
this works on an `npx`-only install too: the file is copied into the
published package at publish time (`prepack` script), so it needs no local
checkout to resolve.

## Secrets are never tool arguments

Signing keys are read from the server process environment. No tool accepts one
as an argument, so an agent never handles a key, and a key cannot end up in a
transcript. A missing key returns an error result explaining which variable to
set.

## Results

Every tool returns both prose and `structuredContent`:

```json
{
  "outcome": "conformant",
  "passed": 5, "failed": 0, "errored": 0, "skipped": 1,
  "results": [
    { "id": "MPP-11", "name": "...", "status": "PASS",
      "detail": "...", "destructive": false }
  ]
}
```

`outcome` is a name, not an exit code — an integer means nothing to an agent,
and `no-verdict` must never be read as `conformant`. When any check errored, the
prose channel carries an explicit caveat that no statement was made about the
target's conformance.

A result with `"status": "ERROR"` also carries `errorKind`, one of
`unreachable`, `configuration`, `setup` or `harness`. `setup` means a
precondition the check needed could not be established — for the channel checks,
that one correctly advancing commitment was refused three times running, which a
channel in concurrent use produces just as readily as a non-conformant target.
An agent should report that as "no verdict", never as a defect, and suggest a
re-run against a channel nothing else is paying through.

## Why the destructive tool is a separate tool

`MPP-13` closes a payment channel. The settlement is final, the channel cannot
be reopened, and no later check can run against it.

An `allowDestructive: true` parameter would be a boolean an agent could set for
itself, which is not human consent in any meaningful sense. Registration-time
gating is stronger: the tool does not exist unless a person started the process
intending it to. When it does exist it still requires `destructiveChannel`
naming the channel it may close, and still refuses if the target's challenge
advertises a different address.

The reasoning is in
[../design/destructive-checks.md](../design/destructive-checks.md).
