# Second Brain Index — {{PROJECT_NAME}}

**Project ID:** `{{PROJECT_ID}}`  
**Owner:** {{PROJECT_OWNER}}

This index maps the project's four-layer, provider-independent Second Brain. All project memory lives here in plain Markdown and YAML rather than inside any AI vendor's chat history.

## Layer 1 — Authoritative Knowledge (`L1_AUTHORITATIVE`)

- [Project Manifest](./manifest.yaml) — Canonical metadata and path map.
- [Product Requirements Document](./requirements/prd.md) — Goals, scope, and functional requirements (`A1` once owner-approved).
- [Project Constraints](./requirements/constraints.md) — Non-functional, technical, budget, and compliance boundaries (`A1` once owner-approved).
- [Architecture Overview](./architecture/overview.md) — System boundaries and architectural summary (`A2` once approved).
- [Architecture Decision Records](./decisions/) — Immutable `ADR-NNNN-*.md` history (`A2` when `status: "accepted"`).

## Layer 2 — Operational Memory (`L2_OPERATIONAL`)

- [Current Project State](./state/current.yaml) — Active tasks, blockers, pending approvals, and open conflicts (`A4`).
- [Conflicts](./conflicts/) — Unresolved or historical `CONF-NNNN-*.yaml` contradiction records (`A4`).
- [Task Inbox](../tasks/inbox/), [Active](../tasks/active/), [Review](../tasks/review/), [Completed](../tasks/completed/), [Blocked](../tasks/blocked/) — Scoped `TASK-NNNN` contracts and `HANDOFF-NNNN` transfers (`A4`).
- [Proposals](../proposals/) — Staged `RES-NNNN`, `ADR-NNNN`, and `APPR-NNNN` drafts awaiting review or owner approval.

## Layer 3 — Research and Evidence (`L3_RESEARCH_EVIDENCE`)

- [Research Records](./research/) — Verified/proposed `RES-NNNN-*.md` technical findings (`A5`).
- [Lessons Learned](./lessons/) — Post-mortem notes and reusable engineering takeaways (`A3`/`A4`).
- [Evidence Manifests](../evidence/) — Reproducible verification and test evidence `EVID-NNNN-*.yaml` (`A3`).

## Layer 4 — Temporary Context (`L4_TEMPORARY_CONTEXT`)

- Ephemeral compiled context packs are designed to live outside Git under `C:\AI-Workspace\local-runtime\context-cache\` (Context Compiler **NOT IMPLEMENTED** in Phase 1).

## Code & Documentation Directories

- [Docs](../docs/) — User/developer documentation for this project.
- [Source](../src/) — Application/library source code.
- [Tests](../tests/) — Automated tests.
