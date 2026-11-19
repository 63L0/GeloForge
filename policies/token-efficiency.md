# Token Efficiency Policy

> **Status:** Documented only — Runtime and budget enforcement are **NOT IMPLEMENTED** in Phase 1.
> The rules and thresholds below are policy targets for future harness runtime components, not currently enforced runtime limits.

## Purpose

Autonomous multi-step engineering can waste large token budgets through broad codebase dumps, repeated web searches, verbose terminal output, and unbounded retries. This policy establishes twelve discipline rules and proposed default guardrails for future harness execution.

## 1. Selective Context Loading

- Load only the task contract (`TASK-NNNN`), mandatory `A0` policies, relevant `A1` requirements/constraints, directly implicated `A2` ADRs, and verified `A3` evidence.
- Never load an entire repository or an entire `brain/` directory into a worker prompt when targeted files satisfy the task scope.
- Future context compilation will use the deterministic Context Compiler specified in [context-compiler-spec.md](../context/context-compiler-spec.md) (**NOT IMPLEMENTED**).

## 2. Avoiding Duplicate Research

- Before starting new external or codebase research, check `brain/research/` and `proposals/` for active, non-stale `RES-NNNN` records matching the question or tags.
- Reuse valid `RES-NNNN` records whose `valid_until` date has not passed and whose `status` is `verified` or `proposed`.
- Only re-research when an existing record is `stale`, contradicted (`CONF-NNNN`), or missing required revision details.

## 3. Reusing Verified Knowledge

- Prefer distilled `L1_AUTHORITATIVE` decisions (`ADR-NNNN`) and `L3_RESEARCH_EVIDENCE` summaries (`EVID-NNNN`, `RES-NNNN`) over re-reading raw source files or raw command transcripts.
- Reference immutable record IDs and Git revisions instead of pasting full prior documents into new prompts.

## 4. Compact Task Handoffs

- Cross-role transfers must use the structured compact contract defined in [agent-handoff.schema.json](../schemas/agent-handoff.schema.json) (`HANDOFF-NNNN`).
- Handoffs carry concise summaries, explicit artifact paths, evidence IDs (`EVID-NNNN`), open risks, detected conflicts (`CONF-NNNN`), and a single recommended next action—never full conversation transcripts.

## 5. Limiting Subagent Delegation

- Proposed future default (**NOT IMPLEMENTED**): **maximum two (2) active specialist agents** concurrently per task chain.
- Proposed future default (**NOT IMPLEMENTED**): **no unlimited nested delegation** (specialist workers must not recursively spawn arbitrary subagent trees).
- Keep coordination flat through the Orchestrator role unless an explicit approved workflow justifies bounded parallelism.

## 6. Filtering Long Terminal Output

- Never feed raw, unfiltered build logs, package-manager logs, or multi-thousand-line test traces into context packets or handoffs.
- Filter and summarize terminal output to: exact command executed, exit code, failing test names, concise stack/error excerpts, and counts (`passed` / `failed` / `skipped`).
- Retain raw full logs only in machine-local `local-runtime/logs/` (**NOT IMPLEMENTED**).

## 7. Context Compaction

- Long-running future task chains must compact operational history into updated `brain/state/current.yaml`, `HANDOFF-NNNN`, and `CHKPT-NNNN` checkpoints rather than retaining growing chat transcripts.
- Authoritative decisions and verified findings belong in the Second Brain, allowing temporary Layer 4 packets to be discarded and regenerated cleanly.

## 8. Finite Retries

- Proposed future default (**NOT IMPLEMENTED**): **maximum two (2) automatic repair retries** for a failing build, test, or validation step.
- After two failed repair attempts, execution must pause, record a structured failure/blocker handoff or `CONF-NNNN` conflict, and escalate to the Software Architect, Orchestrator, or Project Owner rather than looping indefinitely.

## 9. Model / Task Routing

- Future task execution should match model capability and cost profile to task risk and complexity (design-only; no provider routing is implemented in Phase 1):
  - Lightweight checks, formatting, and narrow scoped edits -> smaller/faster models where sufficient.
  - Architecture, security review, ambiguity resolution, and multi-file root-cause debugging -> higher-reasoning models.
- Routing rules remain provider-agnostic until Codex and Gemini CLI adapters are evaluated in future phases.

## 10. Provider Usage Measurement

- Future runtime adapters (**NOT IMPLEMENTED**) should log per-task token counts (input, cached, output), retry counts, and provider identifiers into `local-runtime/logs/` so token efficiency can be measured objectively in `evaluations/`.
- Provider billing dashboards and local logs must never be guessed or fabricated in evidence records.

## 11. Cache Invalidation

- Cached Layer 4 context packs (`local-runtime/context-cache/`, **NOT IMPLEMENTED**) must declare explicit `invalidation_triggers` in [context-pack-manifest.schema.json](../schemas/context-pack-manifest.schema.json).
- Whenever a referenced `A0` policy, `A1` requirement/constraint, `A2` ADR, `brain/state/current.yaml`, or task contract changes revision, dependent cached context packs must be invalidated immediately.

## 12. Cost Approval Requirements

- Proposed future defaults (**NOT IMPLEMENTED**):
  - **No automatic paid API activation.**
  - **No automatic spending.**
- Any action that enables metered paid third-party APIs, cloud resources, external SaaS subscriptions, or spend beyond pre-authorized local CLI usage requires an explicit owner-approved `APPR-NNNN` record (`boundary_category: "spend_or_paid_api"`) per [approval-boundaries.md](./approval-boundaries.md).

## Summary of Proposed Future Defaults (Not Currently Enforced)

| Control | Proposed Future Policy Target | Phase 1 Status |
| :--- | :--- | :--- |
| Concurrent specialist agents | Maximum 2 active specialist agents | **Not implemented** (Policy target only) |
| Automatic repair retries | Maximum 2 automatic retries | **Not implemented** (Policy target only) |
| Paid API activation | Disabled without explicit `APPR-NNNN` | **Not implemented** (Policy target only) |
| Nested delegation | No unlimited nested delegation | **Not implemented** (Policy target only) |
| Automatic spending | Zero autonomous spend permitted | **Not implemented** (Policy target only) |
