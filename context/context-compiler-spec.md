# Deterministic Context Compiler Specification

> **Status:** Design Specification Only — **NOT IMPLEMENTED** in Phase 1.
> No compiler script, cache generator, or automated context packet assembler runs in Phase 1.

## 1. Objective

The future **Context Compiler** will deterministically assemble **Layer 4 (`L4_TEMPORARY_CONTEXT`)** task packets from the project's Second Brain (`L1`–`L3`) and global harness policies (`A0`), outputting:

1. A bounded context payload tailored to a single `TASK-NNNN` and target agent role.
2. A machine-validatable [context-pack-manifest.schema.json](../schemas/context-pack-manifest.schema.json) (`CPACK-NNNN`) recording included files, omitted candidates, source revisions, freshness warnings, unresolved conflicts, and cache invalidation triggers.

Deterministic compilation avoids ad-hoc prompt bloat, makes context reproducible across providers (future Codex / Gemini CLI adapters), and enforces [token-efficiency.md](../policies/token-efficiency.md).

## 2. Ten-Step Compilation Pipeline (Future Design)

1. **Identify the Task:** Read the target `TASK-NNNN` contract (`schemas/task-contract.schema.json`), extracting `project_id`, `assigned_role`, `context_budget`, `required_inputs`, `dependencies`, and `scope_in` / `scope_out`.
2. **Load Mandatory Harness Policies (`A0`):** Always include applicable sections of [approval-boundaries.md](../policies/approval-boundaries.md), [memory-policy.md](../policies/memory-policy.md), and [token-efficiency.md](../policies/token-efficiency.md).
3. **Read Approved Project Requirements (`A1`):** Load `brain/manifest.yaml`, `brain/requirements/constraints.md`, and requirement sections of `brain/requirements/prd.md` relevant to the task.
4. **Retrieve Relevant Architecture Decisions (`A2`):** Load `brain/architecture/overview.md` and `status: "accepted"` ADRs (`brain/decisions/ADR-NNNN-*.md`) whose `related_requirements` or `tags` intersect the task scope (plus any `supersedes` pointer needed to understand current state).
5. **Retrieve Relevant Research and Evidence (`A3`, `A5`):** Select verified `EVID-NNNN` manifests and `RES-NNNN` records linked by `required_inputs`, `evidence_refs`, `related_tasks`, or `related_adrs`, along with current `brain/state/current.yaml`.
6. **Check Document Freshness:** Inspect `valid_until` (`RES-NNNN`), `review_by` (`ADR-NNNN`), and Git revision drift against `required_inputs[].revision`. Emit entries into `freshness_warnings` for any expired or modified source.
7. **Detect Unresolved Conflicts:** Scan `brain/conflicts/CONF-NNNN-*.yaml` (`status: "open"` or `"under_review"`) and `brain/state/current.yaml#open_conflicts`. Surface any conflict touching included documents in `unresolved_conflicts` (and include the conflict summary).
8. **Produce a Concise Context Packet:** Trim non-mandatory low-priority materials first to stay near the profile budget target, log excluded items in `omitted_candidates` with clear reasons, and write the compiled packet and `CPACK-NNNN` manifest.
9. **Record Source Revisions:** Record exact Git commit SHA or file content hash (`revision`) for every entry in `included_documents` so stale packets cannot masquerade as current truth.
10. **Support Caching and Invalidation:** Store ephemeral packets in `local-runtime/context-cache/` keyed by `cache_key` (derived from `task_id`, `profile`, and sorted `(path, revision)` pairs) and populate `invalidation_triggers`.

## 3. Preliminary Context Budget Profiles

> **Note:** These are **preliminary targets**, not rigid truncation cliffs.

| Profile | Target Token Budget | Intended Use Case |
| :--- | :--- | :--- |
| `quick` | ~2,000 tokens | Narrow validation, status update, single-file lookup, or focused review handoff |
| `working` | ~8,000 tokens | Standard feature implementation, bug fix, test authoring, or targeted ADR drafting |
| `deep` | Expand when necessary | Complex architectural design, multi-module debugging, security audit, or conflict resolution |

## 4. Non-Negotiable Safety Rule: Why Budgets Must Never Omit Critical Rules

Token efficiency targets (`quick` ~2,000, `working` ~8,000) are **optimization ceilings for discretionary context**, **never justification to drop safety, authority, or conflict signals**. Specifically, a future Context Compiler **MUST NOT**:

1. **Omit `A0` Security & Approval Boundaries:** Dropping forbidden actions, secret hygiene, or spend gates to save tokens would allow an autonomous agent to violate safety boundaries unknowingly.
2. **Omit Mandatory `A1` Requirements or Hard Constraints:** Implementing a task without `constraints.md` risks violating non-negotiable business, legal, or technical invariants, creating expensive rework far larger than the tokens saved.
3. **Omit Accepted `A2` Architectural Invariants in Scope:** Skipping governing ADRs leads to conflicting implementations that fail review and trigger retry loops.
4. **Hide Open `CONF-NNNN` Conflicts or Stale Warnings:** Concealing known contradictions violates [memory-policy.md](../policies/memory-policy.md) and causes agents to build on disputed assumptions.

### Required Behavior When Mandatory Context Exceeds Target Budget

If mandatory documents (`mandatory: true` for `A0`, scoped `A1`/`A2`, `brain/state/current.yaml`, and open `CONF-NNNN`) alone exceed `quick` (~2,000) or `working` (~8,000):

- **Escalate Profile Instead of Silently Dropping:** Automatically promote `quick -> working` or `working -> deep` (or halt and request scope splitting if even `deep` exceeds model limits).
- **Never Silently Truncate Mandatory Policy/Constraint Text:** Log the budget overrun explicitly in `CPACK-NNNN` (`estimated_tokens > token_budget_target`) and adjust task granularity in the Orchestrator.

## 5. Cache Storage and Invalidation Rules (Future Design)

- **Storage Path:** `C:\AI-Workspace\local-runtime\context-cache\` (never committed to Git).
- **Immediate Invalidation Triggers:**
  - Any edit to `harness/policies/*`
  - Any change to `brain/manifest.yaml`, `brain/state/current.yaml`, `brain/requirements/*`
  - Any ADR transition (`proposed -> accepted` or `accepted -> superseded`)
  - Any new or updated `CONF-NNNN` conflict touching the project
  - Any change to the target `TASK-NNNN` contract or `expires_at` expiration
