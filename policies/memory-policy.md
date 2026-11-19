# Memory Architecture, Knowledge Authority, and Write Ownership Policy

> **Status:** Documented only — Automated knowledge promotion, Restricted Integration Controller enforcement, and filesystem-level write restrictions are **NOT IMPLEMENTED** in Phase 1.
> **Important:** No filesystem-level enforcement exists today; these rules govern how Phase 1 templates are structured and how future agents and controllers must operate.

## 1. Provider-Independent Second Brain

Every project's Second Brain (`projects/<slug>/brain/` and adjacent `tasks/`, `proposals/`, `evidence/`) is stored as plain Markdown and YAML files inside the project repository. It must remain **completely independent of any AI provider's chat history, proprietary memory store, or vendor session state**.

Provider entrypoints such as `AGENTS.md` and `GEMINI.md` are concise pointers to shared Second Brain files—never duplicate copies of project memory.

## 2. Four Memory Layers

| Layer | Enum ID | Scope & Contents | Canonical Project Locations |
| :--- | :--- | :--- | :--- |
| **Layer 1 — Authoritative Knowledge** | `L1_AUTHORITATIVE` | Owner-approved requirements, accepted architecture decisions, constraints, standards | `brain/manifest.yaml`, `brain/requirements/`, `brain/architecture/`, `brain/decisions/`, global `harness/policies/` |
| **Layer 2 — Operational Memory** | `L2_OPERATIONAL` | Active tasks, verified project state, dependencies, blockers, pending approvals, conflicts, checkpoints | `brain/state/current.yaml`, `tasks/`, `brain/conflicts/`, `proposals/` |
| **Layer 3 — Research and Evidence** | `L3_RESEARCH_EVIDENCE` | Findings, external sources, experiments, verification manifests, lessons learned | `brain/research/`, `brain/lessons/`, `evidence/`, `proposals/` |
| **Layer 4 — Temporary Context** | `L4_TEMPORARY_CONTEXT` | Task-specific context packets, selected relevant knowledge, source revision references | `local-runtime/context-cache/` (ephemeral, outside Git; **NOT IMPLEMENTED**) |

## 3. Knowledge Authority Hierarchy (`A0`–`A6`)

| Level | Classification | Examples |
| :--- | :--- | :--- |
| **A0** | Global harness security rules | [approval-boundaries.md](./approval-boundaries.md), [token-efficiency.md](./token-efficiency.md), [memory-policy.md](./memory-policy.md) |
| **A1** | Owner-approved requirements | Approved `brain/requirements/prd.md` and `brain/requirements/constraints.md` |
| **A2** | Approved architecture decisions | Owner-approved `ADR-NNNN` records (`status: "accepted"`) and approved `brain/architecture/overview.md` |
| **A3** | Verified implementation and test evidence | Verified `EVID-NNNN` manifests tied to real command output and Git revisions |
| **A4** | Operational records | `TASK-NNNN`, `HANDOFF-NNNN`, `brain/state/current.yaml`, `APPR-NNNN`, `CONF-NNNN`, `CHKPT-NNNN` |
| **A5** | External research | `RES-NNNN` files summarizing vendor docs, benchmarks, or external specifications |
| **A6** | Unverified agent observations | Unchecked notes, speculative hypotheses, or draft proposals lacking `A3` verification |

> **CRITICAL RULE:** Authority levels (`A0`–`A6`) represent **trust classes, NOT automatic permission to ignore contradictory evidence**.
> If `A3` verification evidence (for example, a reproducible local test failure) or credible `A5` primary documentation contradicts an `A1` requirement or `A2` ADR, the agent **must NOT silently discard the contradiction**. It must record a `CONF-NNNN` conflict (`schemas/conflict-record.schema.json`) and escalate for review.

## 4. Write Ownership Rules (Policy Specification Only)

In Phase 1, write ownership is a documented governance rule without OS/filesystem enforcement:

| Role / Component | Authorized Write Scope (Future Policy) | Prohibited Direct Canonical Writes |
| :--- | :--- | :--- |
| **Researcher** | May propose findings (`RES-NNNN`, lessons) in `proposals/` or draft `brain/research/` | Must NOT alter `A0`–`A2` records or mark `EVID-NNNN` verified |
| **Software Architect** | May draft/propose `ADR-NNNN` and architecture updates in `proposals/` | Must NOT self-approve `A2` ADRs (`approved_by` requires owner) |
| **Developer** | May update their own assigned `TASK-NNNN` progress, produce `src/` / `tests/`, and emit `HANDOFF-NNNN` | Must NOT alter `A0`–`A2` canonical records or forge `A3` QA evidence |
| **QA / Security Reviewer** | May propose/record verification evidence (`EVID-NNNN`) and log `CONF-NNNN` conflicts | Must NOT alter `A1` requirements or bypass approval gates |
| **Orchestrator** | May coordinate task routing, `TASK-NNNN` transitions, `HANDOFF-NNNN`, and `proposals/` | Must NOT self-approve `A1`/`A2` changes or skip `APPR-NNNN` gates |
| **Restricted Integration Controller** *(**NOT IMPLEMENTED**)* | Sole automated gatekeeper permitted to validate and commit accepted promotions into canonical `L1`/`L2` locations | Does not exist in Phase 1; human owner performs canonical integration manually |
| **Project Owner** | Full approval authority over `A1` requirements, `A2` architecture changes, `APPR-NNNN` records, and `CONF-NNNN` resolution | — |

## 5. Future Knowledge Lifecycle Workflows (Not Automatically Implemented)

> **Phase 1 Status:** Automatic knowledge promotion is **NOT IMPLEMENTED**. All promotions require explicit human review and manual updates.

1. **Propose Changes:** Specialist roles author draft `RES-NNNN`, `ADR-NNNN`, or update proposals inside `proposals/` (or with `status: "proposed"`), linking supporting `TASK-NNNN` and `EVID-NNNN` references.
2. **Validate Evidence:** QA / Security Reviewer verifies reproducible commands, environment details, source Git revisions, and limitations in `EVID-NNNN` before elevating trust to `A3`.
3. **Detect Contradictions:** Any mismatch between new `A3`/`A5` evidence and existing `A1`/`A2`/`A4` records triggers a `CONF-NNNN` record (`status: "open"`) referencing both records and claims.
4. **Request Approvals:** Consequential changes (major requirements, `ADR-NNNN` acceptance/supersession, security boundary changes, conflict resolutions) generate an `APPR-NNNN` request (`status: "pending"`).
5. **Promote Accepted Knowledge:** Only after owner approval (`APPR-NNNN` `status: "approved"`) and clean schema validation may future Restricted Integration Controller tooling promote a proposal into canonical `L1` (`brain/requirements/`, `brain/decisions/`).
6. **Preserve Historical Decisions:** Accepted `ADR-NNNN` and resolved `CONF-NNNN` records are never silently deleted or rewritten to erase history. Outdated ADRs transition to `status: "superseded"` with `superseded_by` pointing to the new `ADR-NNNN` (and the new ADR listing the old ID in `supersedes`).
7. **Revalidate Stale Information:** Records carrying `valid_until` or `review_by` dates (especially `A5` research and time-sensitive `A2` assumptions) must be flagged when expired (`status: "stale"` or freshness warning in Layer 4 context packs) and re-verified before reuse.
