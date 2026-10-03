# @wasit-dev/server

MCP server exposing [Wasit](https://github.com/wasit-dev/wasit)'s **x402** / **MPP** conformance checks as tools, for Claude Code, Claude Desktop, GitHub Copilot, Codex, Cursor, VS Code, and any other MCP-compatible agent.

The suite logic isn't reimplemented here — this is a thin adapter over [`@wasit-dev/core`](https://www.npmjs.com/package/@wasit-dev/core), the same package [`@wasit-dev/cli`](https://www.npmjs.com/package/@wasit-dev/cli) runs. An agent's run and a CLI run against the same target can never disagree.

**Testnet only.** Several tools settle real transactions.

## Install

Nothing to install ahead of time — an MCP client launches it on demand:

```bash
npx -y @wasit-dev/server
```

Transport is stdio. Requires Node.js `>=22`.

## <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/wasit-dev/Wasit/main/docs/media/clients/claude-paper.svg" /><img src="https://raw.githubusercontent.com/wasit-dev/Wasit/main/docs/media/clients/claude-ink.svg" height="22" alt="" /></picture> Claude Code

```bash
claude mcp add --transport stdio wasit \
  --env MPP_STELLAR_NETWORK=stellar:testnet \
  --env STELLAR_PRIVATE_KEY=S... \
  --env MPP_PAYER_SECRET=S... \
  --env COMMITMENT_SECRET_HEX=... \
  -- npx -y @wasit-dev/server
```

Verify it connected with `claude mcp list`, then ask directly — for example "run wasit_x402_test against https://my-service.example.com". Remove it later with `claude mcp remove wasit`.

## <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/wasit-dev/Wasit/main/docs/media/clients/claude-paper.svg" /><img src="https://raw.githubusercontent.com/wasit-dev/Wasit/main/docs/media/clients/claude-ink.svg" height="22" alt="" /></picture> Claude Desktop

Settings → Developer → Edit Config, then add a `wasit` entry under `mcpServers`:

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

Fully quit and restart Claude Desktop (not just close the window — use the Claude menu, Quit) for it to pick up the new server. If it doesn't show up under the connectors indicator, check `~/Library/Logs/Claude/mcp-server-wasit.log` (macOS) or `%APPDATA%\Claude\logs\mcp-server-wasit.log` (Windows).

## Codex, Cursor, VS Code and other clients

Any stdio-based MCP client works the same way: `command: "npx"`, `args: ["-y", "@wasit-dev/server"]`, plus the environment variables above. Where each client keeps it:

| Client | Config file | Shape |
|---|---|---|
| <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/wasit-dev/Wasit/main/docs/media/clients/openai-paper.svg" /><img src="https://raw.githubusercontent.com/wasit-dev/Wasit/main/docs/media/clients/openai-ink.svg" height="18" alt="" /></picture> Codex | `~/.codex/config.toml` | `[mcp_servers.wasit]` with `command`, `args`, and `env_vars` to forward keys from your shell |
| <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/wasit-dev/Wasit/main/docs/media/clients/cursor-paper.svg" /><img src="https://raw.githubusercontent.com/wasit-dev/Wasit/main/docs/media/clients/cursor-ink.svg" height="18" alt="" /></picture> Cursor | `.cursor/mcp.json` or `~/.cursor/mcp.json` | `mcpServers.wasit`, with `envFile` pointing at your `.env` |
| <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/wasit-dev/Wasit/main/docs/media/clients/vscode-paper.svg" /><img src="https://raw.githubusercontent.com/wasit-dev/Wasit/main/docs/media/clients/vscode-ink.svg" height="18" alt="" /></picture> VS Code (Copilot agent mode) | `.vscode/mcp.json` | `servers.wasit` with `"type": "stdio"` and `envFile` |
| <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/wasit-dev/Wasit/main/docs/media/clients/copilot-paper.svg" /><img src="https://raw.githubusercontent.com/wasit-dev/Wasit/main/docs/media/clients/copilot-ink.svg" height="18" alt="" /></picture> GitHub Copilot CLI | `~/.copilot/mcp-config.json` | `copilot mcp add wasit --env KEY=VALUE … -- npx -y @wasit-dev/server`; `--allow-tool wasit` for `copilot -p` |

Full snippets are in the [MCP guide](https://github.com/wasit-dev/wasit/blob/main/docs/guides/mcp.md#codex-cursor-vs-code-and-other-clients). Keep keys out of a config file that might be committed. Client names and logos are trademarks of their owners. Use an absolute path to `node`/the server entrypoint instead if launching from a local checkout, since a client starts the process from a working directory you don't control.

## Tools

| Tool | Checks | Cost |
|---|---|---|
| `wasit_x402_test` | `X402-01`–`07` | `06`/`07` settle real payments |
| `wasit_mpp_charge_test` | `MPP-01` | Settles a real payment every call |
| `wasit_mpp_channel_test` | `MPP-10`–`12`, `14` | Free |
| `wasit_mpp_channel_test_with_close` | + `MPP-13` | **Destroys a channel — permanent** |

`wasit_x402_test` also takes optional `method`, `body` and `headers` for a paid endpoint that is not a plain `GET`, matching the CLI's `--method`, `--body` and `--header`. Every probe, including the payment checks, uses the same request shape. Header values appear in the agent's transcript, so never pass a credential as a header; test an endpoint that needs one with the CLI instead. Its optional `rpcUrl`, like the CLI's `--rpc-url`, overrides the Soroban RPC endpoint `X402-06` reads to verify the settlement on-chain.

The fourth tool is registered **only** when the server is started with `WASIT_ALLOW_DESTRUCTIVE=1` or `--allow-destructive`. Without that opt-in it's absent from `tools/list` entirely — an agent can't call what it can't see. Even then it refuses unless a `destructiveChannel` is named and the target's own challenge advertises that same address.

Verify which tools a given configuration exposes:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | npx -y @wasit-dev/server \
  | python3 -c "import sys,json; print([t['name'] for t in json.load(sys.stdin)['result']['tools']])"
```

## Resource

`wasit://checks` serves the full check catalogue — every check's exact pass criteria and spec reference. An agent should read it before interpreting a result rather than inferring pass criteria from a check's name.

## Secrets never travel through tool arguments

Signing keys are read from the server process's own environment, never accepted as a tool parameter — so an agent handles a result, never a key, and a key can't end up in a transcript. A missing key returns an error result naming which variable to set.

## Results

Every tool returns both prose and `structuredContent`:

```json
{
  "outcome": "conformant",
  "passed": 5, "failed": 0, "errored": 0, "skipped": 1,
  "results": [
    { "id": "MPP-11", "name": "...", "status": "PASS", "detail": "...", "destructive": false }
  ]
}
```

`outcome` is a name (`"conformant" | "non-conformant" | "no-verdict"`), not an exit code — an integer means nothing to an agent, and `no-verdict` must never be read as `conformant`. When any check errored, the prose channel carries an explicit caveat that no statement was made about the target's conformance.

## Why the destructive tool is separate

`MPP-13` closes a payment channel. The settlement is final, the channel cannot be reopened, and no later check can run against it. An `allowDestructive: true` parameter would just be a boolean an agent could set for itself — not human consent in any meaningful sense. Registration-time gating is stronger: the tool doesn't exist unless a person started the process intending it to.

## Related

- [Website](https://usewasit.dev)
- [`@wasit-dev/cli`](https://www.npmjs.com/package/@wasit-dev/cli) — the same checks, from a terminal
- [`@wasit-dev/core`](https://www.npmjs.com/package/@wasit-dev/core) — the underlying check suite
- [Full MCP guide](https://github.com/wasit-dev/wasit/blob/main/docs/guides/mcp.md) — Claude Desktop logs, other clients, the destructive-tool design rationale in full

## License

Apache-2.0 — see [LICENSE](https://github.com/wasit-dev/wasit/blob/main/LICENSE).
