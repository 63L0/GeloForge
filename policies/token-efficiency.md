# Token Efficiency Policy

> **Status:** Foundation structural optimizations (`AGENTS.md`/`GEMINI.md` minimal entrypoints, `brain/INDEX.md`, compact handoff/context schemas) are **Implemented**; automated runtime enforcement, token counters, and provider routing are **NOT IMPLEMENTED**.
> **Measurement Rule:** **No token savings percentages are claimed without empirical measurement** from future provider execution logs.

## Structural Efficiencies Established in Phase 1.2

1. **Minimal Provider Entrypoints:** `AGENTS.md` and `GEMINI.md` stay under ~25 lines and point to shared `brain/` files instead of repeating full project specifications.
2. **Relevant-Document Indexing:** `brain/INDEX.md` provides a structured index across layers so future agents locate scoped files without scanning entire repositories.
3. **No Duplicate Knowledge Across Agents:** Shared Second Brain files are read by reference across all roles and future providers.
4. **Compact Handoffs & Evidence References:** [agent-handoff.schema.json](../schemas/agent-handoff.schema.json) and [evidence-manifest.schema.json](../schemas/evidence-manifest.schema.json) transfer concise summaries, file paths, and `EVID-NNNN` IDs rather than raw logs or conversation transcripts.
5. **Task-Specific Context Assembly & Invalidation Contracts:** [context-pack-manifest.schema.json](../schemas/context-pack-manifest.schema.json) and [context-compiler-spec.md](../context/context-compiler-spec.md) specify selective retrieval (`required_inputs`), `omitted_candidates` logging, and `invalidation_triggers` so full-project history loading is unnecessary.

## Future Runtime Policy Rules (Not Implemented Yet)

- **Avoid Duplicate Research:** Check existing `RES-NNNN` (`status !== "stale"`) before re-investigating; revalidate only past `valid_until` or on conflict (`CONF-NNNN`).
- **Filter Long Terminal Output:** Future runners should retain raw command logs in `<workspace-root>/local-runtime/logs/` and pass only exit codes, failing assertions, and concise error excerpts into context.
- **Context Compaction:** Summarize completed milestones into `brain/state/current.yaml`, `HANDOFF-NNNN`, and `CHKPT-NNNN` instead of carrying growing chat transcripts.
- **Model / Task Routing & Usage Measurement:** Route narrow edits/checks to lighter models where verified and record per-task input/cached/output token counts before claiming efficiency gains.

## Starting Context Budget Targets & Proposed Defaults (Policy Targets Only)

| Control / Target | Starting Target | Phase 1 Status |
| :--- | :--- | :--- |
| `quick` context pack | ~2,000 tokens (starting target, not hard truncation) | **Documented only** (**NOT IMPLEMENTED**) |
| `working` context pack | ~8,000 tokens (starting target, not hard truncation) | **Documented only** (**NOT IMPLEMENTED**) |
| `deep` context pack | Task-driven expansion per requirements | **Documented only** (**NOT IMPLEMENTED**) |
| Concurrent specialist agents | Max 2 active specialists; no unlimited nested delegation | **Documented only** (**NOT IMPLEMENTED**) |
| Automatic repair retries | Max 2 automatic retries before escalating | **Documented only** (**NOT IMPLEMENTED**) |
| Paid API / external spend | Disabled without explicit owner `APPR-NNNN` | **Documented only** (**NOT IMPLEMENTED**) |
