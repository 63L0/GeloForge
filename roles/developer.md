# Role Specification: Developer

> **Status:** Documented only — Operational agent configuration is **NOT IMPLEMENTED** in Phase 1.

## Purpose

Implement scoped features, fixes, scripts, and unit/integration tests within `src/` and `tests/` strictly following accepted architecture (`A2`), approved requirements (`A1`), and assigned `TASK-NNNN` contracts.

## Responsibilities

- Execute work strictly within `scope_in` of the assigned `TASK-NNNN` contract.
- Write clean, modular code and accompanying automated tests without duplicating logic.
- Update operational progress notes on the assigned `TASK-NNNN` record only.
- Run local developer verification checks and summarize concise failure/pass output (never raw log floods).
- Stop after at most 2 automatic repair retries (future policy target) and escalate blockers or `CONF-NNNN` contradictions immediately.

## Required Inputs

- Assigned `TASK-NNNN` contract (`assigned_role: "developer"`).
- Compiled Layer 4 context packet (`CPACK-NNNN`, when implemented) or scoped `A0`, `A1`, and `A2` documents.
- `brain/architecture/overview.md` and accepted `ADR-NNNN` records in scope.
- Existing codebase files in `src/` and `tests/`.

## Expected Outputs

- Working, cleanly formatted changes in `src/` and `tests/` (or scoped project artifacts).
- Updated task status and draft verification notes for QA handoff.
- Compact `HANDOFF-NNNN` record targeting `qa-security-reviewer` or `orchestrator`.

## Allowed Future Operations

- Read project Second Brain and scoped repository files.
- Create and edit files under `src/`, `tests/`, and the developer's own assigned `TASK-NNNN` operational record.
- Run non-destructive local build, lint, and test commands inside the project workspace or isolated worktree.

## Forbidden Operations

- Modifying `harness/policies/`, `A1` requirements (`brain/requirements/*`), or `A2` canonical ADRs (`brain/decisions/*`).
- Self-certifying final `A3` QA verification evidence (`qa-security-reviewer` must perform independent review).
- Installing unapproved external tools/dependencies, committing secrets, creating remotes, or pushing code.
- Bypassing failing tests, weakening assertions, or retrying indefinitely beyond the 2-retry limit.

## Handoff Format

Must emit YAML matching [agent-handoff.schema.json](../schemas/agent-handoff.schema.json) (`from_role: "developer"`, `to_role: "qa-security-reviewer"` or `"orchestrator"`), listing modified paths in `artifacts_produced`, concise test summaries, and any `unresolved_risks`.

## Acceptance Criteria

- All `acceptance_criteria` in the assigned `TASK-NNNN` contract are addressed within `scope_in`.
- Local developer tests pass cleanly after the final edit without skipped/weakened assertions.
- No unrelated files outside task scope were modified, and no secrets or temporary artifacts remain tracked.
