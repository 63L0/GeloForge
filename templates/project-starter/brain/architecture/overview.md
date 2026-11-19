# Architecture Overview — {{PROJECT_NAME}}

- **Project ID:** `{{PROJECT_ID}}`
- **Status:** `DRAFT — NOT YET APPROVED`
- **Memory Layer:** `L1_AUTHORITATIVE` (once approved)
- **Authority Level:** `A6` (draft) -> `A2` (after ADR/owner approval)
- **Owner:** {{PROJECT_OWNER}}
- **Created:** {{CREATED_DATE}}

## 1. High-Level Topology

Document major modules, boundaries, data flow, and external dependencies once architectural planning begins.

## 2. Key Architectural Decisions

Accepted Architecture Decision Records live in [brain/decisions/](../decisions/) (`ADR-NNNN-*.md`).

| ADR ID | Title | Status |
| :--- | :--- | :--- |
| `(none yet)` | — | — |

## 3. Repository Layout

- `src/` — Implementation source code
- `tests/` — Automated tests
- `docs/` — Project documentation
- `brain/` — Second Brain memory (`L1`–`L3`)
- `tasks/` — Task lifecycle queues (`inbox`, `active`, `review`, `completed`, `blocked`)
- `proposals/` — Pending proposals awaiting review or owner approval
- `evidence/` — Verification evidence manifests (`EVID-NNNN`)
