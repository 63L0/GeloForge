# Future Harness Roadmap

> **Status: ALL PHASES BELOW ARE NOT IMPLEMENTED.**
> Phase 1 delivers only the foundational directory layout, Second Brain templates, schemas, policies, local validation, and project bootstrapper.

## Planned Future Phases (Design Only)

### Phase 2 — Deterministic Context Compiler & Schema Tooling
- **Status:** **NOT IMPLEMENTED** (spec at [context-compiler-spec.md](../context/context-compiler-spec.md)).
- Implement a deterministic Context Compiler script that builds Layer 4 context packets into `C:\AI-Workspace\local-runtime\context-cache\`, verifies freshness (`valid_until` / `review_by`), flags `CONF-NNNN` conflicts, and writes `CPACK-NNNN` manifests.
- Implement CLI helpers for linting individual project repositories against `harness/schemas/*.schema.json`.

### Phase 3 — Restricted Integration Controller & Recovery Tooling
- **Status:** **NOT IMPLEMENTED**.
- Build a validation gatekeeper (`Restricted Integration Controller`) that verifies `EVID-NNNN` and owner `APPR-NNNN` records before promoting `proposals/` into canonical `brain/requirements/` or `brain/decisions/`.
- Implement resumable `CHKPT-NNNN` checkpoint snapshots inside `C:\AI-Workspace\local-runtime\checkpoints\` and worktree helpers inside `C:\AI-Workspace\worktrees\`.

### Phase 4 — Provider Adapters (Codex CLI, Gemini CLI, Google Antigravity)
- **Status:** **NOT IMPLEMENTED**.
- Investigate and author provider-specific configuration adapters for Codex CLI and Gemini CLI without assuming identical config formats or duplicating the Second Brain.
- Wire provider usage/token logging into `C:\AI-Workspace\local-runtime\logs\` for [token-efficiency.md](../policies/token-efficiency.md) audits.

### Phase 5 — Bounded Orchestration & Evaluations
- **Status:** **NOT IMPLEMENTED**.
- Enable bounded task orchestration strictly respecting max 2 active specialist agents, max 2 repair retries, and mandatory owner approval boundaries (`APPR-NNNN`).
- Build evaluation benchmarks in `harness/evaluations/` to measure defect rates, conflict detection accuracy, and token cost before granting higher autonomy.
