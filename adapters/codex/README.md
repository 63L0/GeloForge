# Codex Adapter Specification

> **Status:** **NOT IMPLEMENTED** — Codex CLI is not configured, invoked, or connected in Phase 1.

## Planned Integration Boundary

- **Project Entrypoint:** Generated projects include a concise [AGENTS.md](../../templates/project-starter/AGENTS.md) pointing to `brain/INDEX.md` and shared policies. Creating `AGENTS.md` does **not** automatically configure Codex.
- **Role Mapping:** Future Codex execution profiles must map strictly to the provider-neutral specifications in [roles/](../../roles/README.md) (`orchestrator`, `researcher`, `software-architect`, `developer`, `qa-security-reviewer`).
- **Isolation Rule:** Any Codex-specific configuration syntax verified in a later phase belongs strictly under `adapters/codex/`, keeping `core/`, `schemas/`, and project `brain/` directories vendor-neutral.
