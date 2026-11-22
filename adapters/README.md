# Provider Adapters

All adapters read shared GeloForge project memory. Interactive clients use a project-pinned MCP server. The [staging worker](../docs/advanced-usage.md#autonomous-mode-staging-pilot) sends a bounded packet and sanitized execution metadata to an approved headless provider.

| Provider | Headless settings | Project entrypoint |
| --- | --- | --- |
| [Codex CLI](./codex/README.md) | `codex` | `AGENTS.md` |
| [Gemini CLI](./gemini/README.md) | `gemini` | `GEMINI.md` |
| [Google Antigravity](./antigravity/README.md) | `antigravity` via `agy` | `AGENTS.md` and workspace MCP server |
| [n8n](./n8n/staging-audit-error-workflow.json) | Staging execution delivery | Per-project staging inbox |

The adapter tests simulate each provider's CLI response contract. Each deployed runner uses its own authenticated CLI and a dedicated staging account or container.
