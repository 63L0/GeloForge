# Codex CLI

Open the GeloForge project root in Codex. The [project starter AGENTS.md](../../templates/project-starter/AGENTS.md) points Codex to shared memory and task-based skill lookup.

For interactive MCP, register the installed GeloForge CLI with the absolute project path:

```shell
codex mcp add geloforge -- geloforge mcp --project "<absolute-project-path>" --read-only
```

For staging audits, configure `"provider": "codex"` with the absolute path to the installed executable. The worker uses a private run directory, read-only sandbox mode, and a fresh session. It reads the final response as JSON. [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
