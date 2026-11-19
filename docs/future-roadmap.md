# Future Harness Roadmap

> **Status: ALL ITEMS BELOW ARE NOT IMPLEMENTED.**
> Phase 1.2 delivers only the foundational core modules, schemas, templates, project profiles, compatibility checks, transactional generator, and project validator.

## Planned Future Phases (Design Only)

### Phase 2 — Deterministic Context Compiler
- **Status:** **NOT IMPLEMENTED** (specification at [context-compiler-spec.md](../context/context-compiler-spec.md)).
- Implement a deterministic compiler assembling bounded Layer 4 packets into `<workspace-root>/local-runtime/context-cache/` with freshness checks, open-conflict surfacing, and empirical token counting.

### Phase 3 — Restricted Integration Controller & Checkpoint Recovery
- **Status:** **NOT IMPLEMENTED**.
- Build a gated promotion tool validating `EVID-NNNN` and owner `APPR-NNNN` records before promoting `proposals/` into canonical `brain/requirements/` or `brain/decisions/`.
- Add resumable `CHKPT-NNNN` checkpoint tooling in `<workspace-root>/local-runtime/checkpoints/` and isolated Git worktree management in `<workspace-root>/worktrees/`.

### Phase 4 — Provider Adapters & Extension Directories
- **Status:** **NOT IMPLEMENTED** (boundaries documented under [adapters/](../adapters/README.md)).
- Implement and verify provider-specific adapters for Codex CLI, Gemini CLI, and Google Antigravity without duplicating project memory.
- Add future extension directories (`skills/` for reusable procedure specs and `evaluations/` for measurable benchmarks) only when operational tooling requires them.

### Phase 5 — Bounded Multi-Agent Orchestration
- **Status:** **NOT IMPLEMENTED**.
- Enable bounded orchestration strictly enforcing max 2 concurrent specialists, max 2 repair retries, and owner `APPR-NNNN` gates, evaluated empirically against `evaluations/` baselines before expanding autonomy.
