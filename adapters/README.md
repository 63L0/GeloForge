# Provider Adapters

> **Status:** Documented only — Operational provider configurations, CLI integrations, and multi-agent runners are **NOT IMPLEMENTED** in Phase 1.

## Purpose

The harness separates **provider-neutral core contracts** (`core/`, `schemas/`, `policies/`, `contracts/`, `templates/`) from **provider-specific adapters** (`adapters/`).

- Every project keeps a single canonical Second Brain under `brain/` and `tasks/`.
- Provider adapters must only map a specific tool's entrypoint format and tool capabilities onto those shared contracts—never duplicate requirements, architecture decisions, or project state across providers.
- Do not assume configuration formats are interchangeable across Google Antigravity, Codex CLI, and Gemini CLI.

## Adapter Specifications (Documentation Only)

| Provider | Adapter Doc | Entrypoint in Generated Projects | Phase 1 Status |
| :--- | :--- | :--- | :--- |
| Google Antigravity | [antigravity/README.md](./antigravity/README.md) | `AGENTS.md` / `brain/INDEX.md` | **Documented only** (setup agent only) |
| Codex CLI | [codex/README.md](./codex/README.md) | `AGENTS.md` | **Not implemented** |
| Gemini CLI | [gemini/README.md](./gemini/README.md) | `GEMINI.md` | **Not implemented** |
