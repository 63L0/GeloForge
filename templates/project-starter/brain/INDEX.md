# Second Brain Index — {{PROJECT_NAME}}

**Project ID:** `{{PROJECT_ID}}`  
**Owner:** {{PROJECT_OWNER}}

This index maps the project's four-layer, provider-independent Second Brain. All project memory lives here in plain Markdown and YAML rather than inside any AI vendor's chat history.

## Layer 1 — Authoritative Knowledge (`L1_AUTHORITATIVE`)

- [Project Manifest](./manifest.yaml) — Canonical metadata, version compatibility, and path map.
- [Product Requirements Document](./requirements/prd.md) — Goals, scope, and functional requirements (`A1` once owner-approved).
- [Project Constraints](./requirements/constraints.md) — Non-functional, technical, budget, and compliance boundaries (`A1` once owner-approved).
- [Architecture Overview](./architecture/overview.md) — System boundaries and architectural summary (`A2` once approved).
- [Architecture Decision Records](./decisions/) — Immutable `ADR-NNNN-*.md` history (`A2` when `status: "accepted"`).

## Layer 2 — Operational Memory (`L2_OPERATIONAL`)

- [Current Project State](./state/current.yaml) — Active tasks, blockers, pending approvals, and open conflicts (`A4`).
- [Tasks](../tasks/) — Scoped `TASK-NNNN` contracts and `HANDOFF-NNNN` transfers (`A4`; create status subdirectories on demand if helpful).

## Layer 3 — Research and Evidence (`L3_RESEARCH_EVIDENCE`) and On-Demand Folders

Create these folders only when needed to avoid empty-directory clutter:

- `brain/research/` — Verified/proposed `RES-NNNN-*.md` findings (`A5`).
- `brain/lessons/` — Post-mortem takeaways (`A3`/`A4`).
- `brain/conflicts/` — `CONF-NNNN-*.yaml` contradiction records (`A4`).
- `brain/incidents/` — Optional `INC-NNNN-*.yaml` failure/postmortem records.
- `proposals/` — Staged drafts (`ADR-NNNN`, `RES-NNNN`, `APPR-NNNN`) awaiting owner approval.
- `evidence/` — Reproducible verification manifests `EVID-NNNN-*.yaml` (`A3`).
- `docs/` — Project-specific user or developer guides.

## Layer 4 — Temporary Context (`L4_TEMPORARY_CONTEXT`)

- Compile deterministic, trust-tiered context packs on demand with `geloforge context --task TASK-0001 --map` (supports `quick`, `working`, and `deep` profiles).

## Code Directories

- [Source](../src/) — Application/library source code.
- [Tests](../tests/) — Automated tests.
