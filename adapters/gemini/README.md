# Gemini CLI Adapter Specification

> **Status:** **NOT IMPLEMENTED** — Gemini CLI is not configured, invoked, or connected in Phase 1.

## Planned Integration Boundary

- **Project Entrypoint:** Generated projects include a concise [GEMINI.md](../../templates/project-starter/GEMINI.md) pointing to `AGENTS.md` and `brain/INDEX.md`. Creating `GEMINI.md` does **not** automatically configure Gemini CLI.
- **Zero Duplication Rule:** `GEMINI.md` must never duplicate requirements, constraints, or ADRs; Gemini CLI reads the same shared `brain/` and `tasks/` files as every other provider.
- **Isolation Rule:** Any Gemini CLI settings, command definitions, or MCP bindings verified in a later phase belong strictly under `adapters/gemini/`.
