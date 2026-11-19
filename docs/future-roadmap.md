# Future Harness Roadmap

> **Status:** Stage 2 (`Context Compiler` + `geloforge` CLI) and Stage 3 (`Selective Codebase Mapping` + `Cross-Agent File Handoffs`) are **IMPLEMENTED in v0.3.0 RC**. Items below remain **NOT IMPLEMENTED**.

## Planned Future Phases (Design Only)

### Phase 3 Extensions — On-Disk Cache, Restricted Integration Controller & Checkpoint Recovery
- **Status:** **NOT IMPLEMENTED** (on-disk packet caching under `<workspace-root>/local-runtime/context-cache/` deferred pending multi-project cache-invalidation benchmarks).
- Build a gated promotion tool validating `EVID-NNNN` and owner `APPR-NNNN` records before promoting `proposals/` into canonical `brain/requirements/` or `brain/decisions/`.
- Add resumable `CHKPT-NNNN` checkpoint tooling in `<workspace-root>/local-runtime/checkpoints/` and isolated Git worktree management in `<workspace-root>/worktrees/`.

### Phase 4 — Provider Adapters & Extension Directories
- **Status:** **NOT IMPLEMENTED** (boundaries documented under [adapters/](../adapters/README.md)).
- Implement and verify provider-specific adapters for Codex CLI, Gemini CLI, and Google Antigravity without duplicating project memory.
- Add future extension directories (`skills/` for reusable procedure specs and `evaluations/` for measurable benchmarks) only when operational tooling requires them.

### Phase 5 — Bounded Multi-Agent Orchestration
- **Status:** **NOT IMPLEMENTED**.
- Enable bounded orchestration strictly enforcing max 2 concurrent specialists, max 2 repair retries, and owner `APPR-NNNN` gates, evaluated empirically against `evaluations/` baselines before expanding autonomy.
