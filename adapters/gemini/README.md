# Gemini CLI

Run `geloforge mcp init --client gemini --read-only` in the GeloForge project. This adds the server to `.gemini/settings.json` and updates the selected instructions file. The default guide is [GEMINI.md](../../templates/project-starter/GEMINI.md).

For staging audits, configure `"provider": "gemini"` with the absolute path to the installed CLI or its Node.js entry point. The worker uses plan mode and reads the JSON response envelope. [Gemini CLI plan mode](https://geminicli.com/docs/cli/plan-mode/) · [Headless mode](https://geminicli.com/docs/cli/headless/)
