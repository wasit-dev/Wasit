# @wasit-dev/server

MCP server exposing [Wasit](https://github.com/wasit-dev/wasit)'s **x402** / **MPP** conformance checks as tools, for Claude Code, Claude Desktop, GitHub Copilot, Codex, Cursor, VS Code, and any other MCP-compatible agent.

The suite logic isn't reimplemented here — this is a thin adapter over [`@wasit-dev/core`](https://www.npmjs.com/package/@wasit-dev/core), the same package [`@wasit-dev/cli`](https://www.npmjs.com/package/@wasit-dev/cli) runs. An agent's run and a CLI run against the same target can never disagree.

**Testnet by default.** Several tools settle real transactions. The tools an agent can call with a network pay on test networks only: any other network, `stellar:pubnet` included, is refused before a key is read. The one exception is the [mainnet opt-in](#mainnet-beta) (beta), which a person sets when the server starts, never an agent. In 0.8.0-beta.1 (npm tag `beta`; `latest` is 0.7.0) there is no opt-in: its variables stop the server at start.

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

Verify it connected with `claude mcp list`, then ask directly — for example "run wasit_x402_test against https://my-service.example.com". Remove it later with `claude mcp remove wasit`. To try it with no keys and nothing settled, register it without any `--env` and ask for read-only checks (`readOnly: true`). On native Windows, put `cmd /c` before `npx`, and in PowerShell 5.1 quote the separator: `claude mcp add --transport stdio wasit '--' cmd /c npx -y @wasit-dev/server` (see the [MCP guide](https://github.com/wasit-dev/wasit/blob/main/docs/guides/mcp.md#claude-code)).

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
| <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/wasit-dev/Wasit/main/docs/media/clients/copilot-paper.svg" /><img src="https://raw.githubusercontent.com/wasit-dev/Wasit/main/docs/media/clients/copilot-ink.svg" height="18" alt="" /></picture> GitHub Copilot CLI | `~/.copilot/mcp-config.json` | `copilot mcp add wasit --env KEY=VALUE … -- npx -y @wasit-dev/server`, or export the keys before starting `copilot`; it does not read `envFile` |

Full snippets are in the [MCP guide](https://github.com/wasit-dev/wasit/blob/main/docs/guides/mcp.md#codex-cursor-vs-code-and-other-clients). Keep keys out of a config file that might be committed. Client names and logos are trademarks of their owners. Use an absolute path to `node`/the server entrypoint instead if launching from a local checkout, since a client starts the process from a working directory you don't control.

## Tools

| Tool | Checks | Cost |
|---|---|---|
| `wasit_x402_test` | `X402-01`–`10` | `06` settles a real payment; `07`–`10` send payments the target must refuse; all five run only with a payer key, and `readOnly` skips them |
| `wasit_mpp_charge_test` | `MPP-01` | Settles a real payment every call |
| `wasit_mpp_channel_test` | `MPP-10`–`12`, `14` | Free |
| `wasit_mpp_channel_test_with_close` | + `MPP-13` | **Destroys a channel — permanent** |
| `wasit_x402_mainnet_test` | `X402-01`–`11` on `stellar:pubnet` | **Real USDC (beta).** Registered only with the [mainnet opt-in](#mainnet-beta) |

`wasit_x402_test` also takes an optional `readOnly` (skips the payment checks even when a payer key is set) and optional `method`, `body` and `headers` for a paid endpoint that is not a plain `GET`, matching the CLI's `--method`, `--body` and `--header`. Every probe, including the payment checks, uses the same request shape. Header values appear in the agent's transcript, so never pass a credential as a header; test an endpoint that needs one with the CLI instead. Its optional `rpcUrl`, like the CLI's `--rpc-url`, overrides the Soroban RPC endpoint `X402-06` reads to verify the settlement on-chain.

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

## The RPC lock

`WASIT_RPC_URL`, read when the server starts, fixes the RPC of every tool call, and a tool call that names another `rpcUrl` is then refused before anything is sent. A result that reads the chain names its RPC by origin, where it came from, and when it is not Wasit's default (in the text and in `structuredContent.rpc`). New in 0.8.0-beta.1.

## Mainnet (beta)

Started with all three of `WASIT_MAINNET_OPT_IN=1`, `WASIT_MAINNET_CONFIG` (the absolute path of a `wasit.config.json`) and `WASIT_MAINNET_ENVIRONMENT` (one environment of it), the server reads that config once and registers `wasit_x402_mainnet_test`. Its only argument is the name of an x402 endpoint of that environment: the agent gives no URL, network, RPC, payee or amount, and an edit of the file changes nothing until the server is restarted. The server does not start (exit 2, the reasons on stderr) unless the environment is on `stellar:pubnet` with `operatedByMe: true`, pins mainnet USDC, has an https RPC and an x402 endpoint, `WASIT_MAINNET_PAYER_SECRET` is set, and it is not running in CI.

Each call opens its own mainnet run with every rule of `wasit run --mainnet` (see the [CLI](https://www.npmjs.com/package/@wasit-dev/cli)): its first line says `MAINNET RUN`, it pays only the pinned payee in USDC, at most $1.00 a payment, and it writes a run ledger next to the config. The $5.00 cap (or the config's lower `maxRunUsd`) is for the whole server process, shared by every call; a restart resets it. One call at a time. The service must already be running: the tool never starts it. A call waits for every authorization it signed to expire, so it can take several minutes, and it runs to its end even when the client cancels it. Its result's `mainnet.ledgerResult` compares the run ledger with the payer's balances on public Horizon: `consistent`, `explained` (more USDC left than the run verified settled, within the payments of checks that FAILed) or `inconsistent`. A call that stops, or whose ledger is inconsistent, is `no-verdict` and locks the tool: every later call is refused until you have compared the ledger with the chain and restarted the server.

This is the weakest of the three mainnet switches. An MCP server takes its environment from the client's configuration, so the key may sit in a file the agent can read, and an agent that reads the key is outside every limit of Wasit. Use a dedicated account (the run refuses a payer holding more than $10.00 in USDC), start the server from a shell that already holds `WASIT_MAINNET_PAYER_SECRET`, and never write the key into an MCP config file. An agent with a shell can still read it.

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
