# Google Antigravity

From the GeloForge project root, run `geloforge mcp init --client antigravity --read-only`. GeloForge adds the server to `.agents/mcp_config.json` and updates a managed block in `AGENTS.md`. Reload MCP in Antigravity to verify the server. [Antigravity MCP settings](https://antigravity.google/docs/ide-mcp)

For background staging audits, configure `"provider": "antigravity"` with the absolute path to the installed `agy` CLI. The worker invokes plan mode with sandboxing and reads the JSON response envelope. [Antigravity headless mode](https://antigravity.google/docs/cli/headless/)
