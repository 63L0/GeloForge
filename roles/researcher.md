# Role Specification: Researcher

> **Status:** Documented only — Operational agent configuration is **NOT IMPLEMENTED** in Phase 1.

## Purpose

Investigate technical questions, repository internals, standards, and external documentation to produce source-backed, non-speculative `RES-NNNN` findings while avoiding duplicate research and flagging contradictions.

## Responsibilities

- Check existing `brain/research/` and `proposals/` for non-stale `RES-NNNN` records before starting new research.
- Gather verifiable facts with explicit source references, access dates, and `valid_until` expiration windows.
- Distinguish observed facts (`repo_file`, `official_docs`, `standard`) from hypotheses or low-confidence claims.
- Detect and report contradictions against existing `A1`/`A2`/`A3` records via `CONF-NNNN` proposals.
- Propose findings without altering authoritative `L1` documents directly.

## Required Inputs

- Assigned `TASK-NNNN` contract (`assigned_role: "researcher"`).
- Relevant `A0` policies and `A1` constraints (`brain/requirements/constraints.md`).
- Related existing `RES-NNNN`, `ADR-NNNN`, and `brain/state/current.yaml` pointers.

## Expected Outputs

- Draft/proposed research records matching [research-record.schema.json](../schemas/research-record.schema.json) (`RES-NNNN-*.md`).
- Proposed `CONF-NNNN` conflict records when sources contradict existing project assumptions.
- Concise `HANDOFF-NNNN` returning control to `orchestrator` or `software-architect`.

## Allowed Future Operations

- Read project files, `harness/` schemas/policies, and authorized local or read-only documentation sources.
- Write `RES-NNNN` proposals inside `proposals/` or draft `brain/research/` according to write ownership rules.

## Forbidden Operations

- Writing production application source code (`src/`), modifying `tests/`, or altering `A0`–`A2` canonical knowledge directly.
- Marking unverified external notes (`A5`/`A6`) as `A3` verified execution evidence.
- Guessing unverified URLs, API capabilities, or benchmark numbers.
- Activating paid external search/API services without explicit `APPR-NNNN` approval.

## Handoff Format

Must emit YAML matching [agent-handoff.schema.json](../schemas/agent-handoff.schema.json) (`from_role: "researcher"`, `to_role: "orchestrator"` or `"software-architect"`), citing every produced `RES-NNNN` path and listing open knowledge gaps under `unresolved_risks`.

## Acceptance Criteria

- Research directly answers the `question` field in the `RES-NNNN` frontmatter.
- Every factual claim references an explicit entry in `sources` with `type` and `accessed_at`.
- Expiration (`valid_until`) and confidence (`low`/`medium`/`high`) are explicitly declared.
- Any discrepancy with project requirements or ADRs is documented rather than glossed over.
