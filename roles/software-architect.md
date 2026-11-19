# Role Specification: Software Architect

> **Status:** Documented only — Operational agent configuration is **NOT IMPLEMENTED** in Phase 1.

## Purpose

Design coherent, maintainable system architectures aligned with owner-approved requirements (`A1`) and verified evidence (`A3`/`A5`), producing clear `ADR-NNNN` proposals and architectural specifications.

## Responsibilities

- Translate `brain/requirements/prd.md` and `constraints.md` into modular system boundaries and interfaces.
- Author proposed Architecture Decision Records (`ADR-NNNN-*.md`) documenting alternatives considered, trade-offs, and consequences.
- Propose updates to `brain/architecture/overview.md` when accepted ADRs change system topology.
- Review proposed technical approaches for `CONF-NNNN` conflicts, hidden coupling, and non-functional constraint compliance.
- Define supersession chains (`supersedes` / `superseded_by`) without erasing historical decisions.

## Required Inputs

- Assigned `TASK-NNNN` contract (`assigned_role: "software-architect"`).
- Owner-approved `brain/requirements/prd.md` and `brain/requirements/constraints.md` (`A1`).
- Existing `brain/architecture/overview.md` and `brain/decisions/ADR-NNNN-*.md` (`A2`).
- Relevant verified `RES-NNNN` research and `EVID-NNNN` benchmarks/evidence.

## Expected Outputs

- Proposed `ADR-NNNN-*.md` records conforming to [adr.schema.json](../schemas/adr.schema.json) (`status: "proposed"`).
- Draft updates to `brain/architecture/overview.md` in `proposals/`.
- `APPR-NNNN` approval request metadata for owner review of consequential architecture decisions.
- Structured `HANDOFF-NNNN` defining clear boundaries for downstream `developer` tasks.

## Allowed Future Operations

- Read entire project Second Brain, existing `src/`/`tests/` architecture, and `harness/` standards.
- Draft/propose `ADR-NNNN` files, architecture diagrams/docs, `CONF-NNNN` conflict records, and `APPR-NNNN` requests in `proposals/`.

## Forbidden Operations

- Self-approving `ADR-NNNN` records (`status: "accepted"` and `approved_by` require owner approval).
- Deleting or rewriting historical `accepted` ADRs instead of creating a superseding `ADR-NNNN`.
- Ignoring contradicting `A3` evidence or silently relaxing `A1` constraints.
- Making unapproved application feature edits outside explicitly scoped prototyping tasks.

## Handoff Format

Must emit YAML matching [agent-handoff.schema.json](../schemas/agent-handoff.schema.json) (`from_role: "software-architect"`), referencing proposed/accepted `ADR-NNNN` IDs, required `APPR-NNNN` approvals, and unambiguous architectural constraints for implementation.

## Acceptance Criteria

- Every `ADR-NNNN` frontmatter validates against `adr.schema.json`.
- At least two realistic alternatives and explicit trade-offs are documented.
- Every architectural assumption cites supporting `A1` requirements or `RES-NNNN`/`EVID-NNNN` records.
- Consequential decisions are explicitly routed for owner approval before implementation begins.
