# Google Antigravity Adapter Specification

> **Status:** Documented only — No multi-agent workflow or automated adapter runtime is configured in Phase 1.

## Role in Phase 1

Google Antigravity serves solely as the human-supervised setup and audit agent for establishing and hardening the harness foundation.

## Future Integration Boundary (Not Implemented)

- Reads project Second Brain via [AGENTS.md](../../templates/project-starter/AGENTS.md) and `brain/INDEX.md` without duplicating project knowledge.
- Future Antigravity skills or subagent workflows must treat harness `A0` policies (`policies/approval-boundaries.md`, `policies/memory-policy.md`) and JSON schemas (`schemas/`) as authoritative contracts.
- Antigravity's native skill/subagent conventions must remain isolated inside this adapter directory and never overwrite or alter Codex or Gemini CLI conventions.
