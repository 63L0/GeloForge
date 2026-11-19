# Deterministic Context Compiler Specification

> **Status:** Design Specification Only — **NOT IMPLEMENTED** in Phase 1.
> No compiler script, token counter, or runtime context packet generator executes today, and **no token savings are claimed without empirical measurement**.

## 1. Objective

The future **Context Compiler** will deterministically assemble **Layer 4 (`L4_TEMPORARY_CONTEXT`)** task packets from a project's Second Brain (`L1`–`L3`) and global harness policies (`A0`), emitting:

1. A focused context payload tailored to one `TASK-NNNN` and assigned role without loading full project history.
2. A machine-validatable [context-pack-manifest.schema.json](../schemas/context-pack-manifest.schema.json) (`CPACK-NNNN`) listing included documents, omitted candidates, source revisions, freshness warnings, unresolved conflicts, and invalidation triggers.

## 2. Ten-Step Compilation Pipeline (Future Design)

1. **Identify the Task:** Read `TASK-NNNN` (`schemas/task-contract.schema.json`), extracting `project_id`, `assigned_role`, `context_budget`, `required_inputs`, `dependencies`, and `scope_in` / `scope_out`.
2. **Load Mandatory Harness Policies (`A0`):** Include applicable sections of [approval-boundaries.md](../policies/approval-boundaries.md), [memory-policy.md](../policies/memory-policy.md), and [token-efficiency.md](../policies/token-efficiency.md).
3. **Read Approved Requirements (`A1`):** Include `brain/manifest.yaml`, `brain/requirements/constraints.md`, and relevant sections of `brain/requirements/prd.md`.
4. **Retrieve Relevant Architecture (`A2`):** Load `brain/architecture/overview.md` and `status: "accepted"` ADRs (`brain/decisions/ADR-NNNN-*.md`) matching task scope or `related_requirements`.
5. **Retrieve Relevant Research & Evidence (`A3`, `A5`):** Pull referenced `EVID-NNNN` manifests, `RES-NNNN` summaries (via `brain/INDEX.md` and task links), and `brain/state/current.yaml`.
6. **Check Document Freshness:** Inspect `valid_until` (`RES-NNNN`), `review_by` (`ADR-NNNN`), and Git revision drift; populate `freshness_warnings` for stale records.
7. **Detect Unresolved Conflicts:** Scan `brain/conflicts/CONF-NNNN-*.yaml` (`open` / `under_review`) and `brain/state/current.yaml#open_conflicts`; include conflict summaries in `unresolved_conflicts`.
8. **Assemble Concise Packet:** Trim optional background materials first to approach the starting budget target, recording skipped candidates in `omitted_candidates` with explicit reasons.
9. **Record Source Revisions:** Record exact Git commit SHA or file hash in `included_documents[].revision`.
10. **Cache and Invalidate:** Store temporary packets outside Git in `<workspace-root>/local-runtime/context-cache/` keyed by `cache_key` with explicit `invalidation_triggers`.

## 3. Starting Context Budget Targets (Not Hard Truncation Cliffs)

| Profile | Starting Target | Intended Use Case |
| :--- | :--- | :--- |
| `quick` | ~2,000 tokens | Narrow validation, status updates, or single-file checks |
| `working` | ~8,000 tokens | Standard feature tasks, bug fixes, tests, or targeted ADR drafting |
| `deep` | Task-driven expansion | Complex architecture, multi-module debugging, security reviews, or conflict resolution |

## 4. Non-Negotiable Safety Rule: Never Omit Mandatory Rules for Budget Targets

Budget targets (`~2,000` / `~8,000`) apply strictly to discretionary context and **MUST NEVER omit**:

1. Applicable `A0` security and approval boundaries.
2. Scoped `A1` requirements and hard `constraints.md` invariants.
3. Accepted `A2` ADRs governing the touched subsystem.
4. Open `CONF-NNNN` conflicts or freshness warnings touching included records.

If mandatory items exceed the selected target, the compiler must **escalate the profile** (`quick -> working -> deep`) or request task decomposition rather than silently dropping safety or requirement context.
