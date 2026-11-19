# Memory Architecture, Knowledge Authority, and Write Ownership Policy

> **Status:** Governance Specification (`Documented only`) for write ownership and automated promotion.
> **Important:** **No OS/filesystem-level write enforcement exists in Phase 1.** Local schema, duplicate-ID, and reference validation is provided by [scripts/validate-project.mjs](../scripts/validate-project.mjs).

## 1. Provider-Independent Second Brain

Project knowledge (`brain/` and `tasks/`) is stored as plain Markdown and YAML inside each project repository—independent of any AI provider's chat history. Entrypoints such as `AGENTS.md` and `GEMINI.md` point to shared project files without duplicating content.

## 2. Four Memory Layers

| Layer | Enum ID | Contents | Canonical Locations |
| :--- | :--- | :--- | :--- |
| **Layer 1** | `L1_AUTHORITATIVE` | Owner-approved requirements, accepted ADRs, constraints, standards | `brain/manifest.yaml`, `brain/requirements/`, `brain/architecture/`, `brain/decisions/`, harness `policies/` |
| **Layer 2** | `L2_OPERATIONAL` | Active tasks, verified state, blockers, pending approvals, conflicts, incidents, checkpoints | `brain/state/current.yaml`, `tasks/`, optional `brain/conflicts/`, `brain/incidents/`, `proposals/` |
| **Layer 3** | `L3_RESEARCH_EVIDENCE` | Source-backed findings, lessons learned, verification evidence manifests | Optional `brain/research/`, `brain/lessons/`, `evidence/`, `proposals/` |
| **Layer 4** | `L4_TEMPORARY_CONTEXT` | Task-specific compiled context packets and source revision references | `<workspace-root>/local-runtime/context-cache/` (**NOT IMPLEMENTED**) |

## 3. Knowledge Authority Hierarchy (`A0`–`A6`)

| Level | Trust Class | Examples |
| :--- | :--- | :--- |
| **A0** | Global harness security rules | [approval-boundaries.md](./approval-boundaries.md), [token-efficiency.md](./token-efficiency.md), [memory-policy.md](./memory-policy.md) |
| **A1** | Owner-approved requirements | Approved `brain/requirements/prd.md` and `constraints.md` |
| **A2** | Approved architecture decisions | Accepted `ADR-NNNN` records (`approved_by` + `decided_at`) and approved `brain/architecture/overview.md` |
| **A3** | Verified implementation & test evidence | Verified `EVID-NNNN` manifests linked to real commands and revisions |
| **A4** | Operational records | `TASK-NNNN`, `HANDOFF-NNNN`, `brain/state/current.yaml`, `APPR-NNNN`, `CONF-NNNN`, `INC-NNNN`, `CHKPT-NNNN` |
| **A5** | External research | `RES-NNNN` summaries of external docs or benchmarks (never automatically authoritative) |
| **A6** | Unverified agent observations | Unchecked notes, hypotheses, or draft proposals lacking `A3` verification |

> **CRITICAL RULE:** Authority levels (`A0`–`A6`) represent **trust classes, NOT automatic permission to ignore contradictory evidence**. Any credible contradiction against an `A1`–`A4` record must be logged as a `CONF-NNNN` conflict (`schemas/conflict-record.schema.json`) and reviewed rather than discarded.

## 4. Write Ownership Rules (Documented Only — Not Filesystem-Enforced)

| Role / Component | Authorized Future Write Scope | Prohibited Direct Canonical Writes |
| :--- | :--- | :--- |
| **Researcher** | Drafts `RES-NNNN` and lessons in `proposals/` or `brain/research/` | Must NOT alter `A0`–`A2` records or mark `EVID-NNNN` verified |
| **Software Architect** | Drafts `ADR-NNNN` and architecture proposals in `proposals/` | Must NOT self-approve `A2` ADRs (`approved_by` requires owner) |
| **Developer** | Updates assigned `TASK-NNNN`, writes `src/` / `tests/`, emits `HANDOFF-NNNN` | Must NOT alter `A0`–`A2` canonical records or self-certify QA evidence |
| **QA / Security Reviewer** | Proposes `EVID-NNNN` verification manifests, `CONF-NNNN` conflicts, `INC-NNNN` incidents | Must NOT modify `A1` requirements or grant `APPR-NNNN` approvals |
| **Orchestrator** | Coordinates `TASK-NNNN`, `HANDOFF-NNNN`, and `proposals/` transitions | Must NOT self-approve `A1`/`A2` changes or skip `APPR-NNNN` |
| **Restricted Integration Controller** *(**NOT IMPLEMENTED**)* | Sole automated gatekeeper validating approved promotions into `L1`/`L2` | Not built yet; human owner integrates canonical changes manually |
| **Project Owner** | Approves `A1` requirements, `A2` ADRs, `APPR-NNNN` records, and `CONF-NNNN` resolutions | — |

## 5. Future Knowledge Lifecycle (Automatic Promotion NOT Implemented)

1. **Propose:** Draft `RES-NNNN`, `ADR-NNNN`, or updates in `proposals/`.
2. **Validate Evidence:** QA verifies reproducible commands, environment, and limitations in `EVID-NNNN`.
3. **Detect Contradictions:** Log `CONF-NNNN` whenever evidence or sources contradict existing records.
4. **Request Approval:** Create `APPR-NNNN` (`pending`) for boundary-crossing or `A1`/`A2` changes.
5. **Promote Accepted Knowledge:** Manual in Phase 1 (future controller requires approved `APPR-NNNN` + schema pass).
6. **Preserve History:** Transition outdated ADRs to `status: "superseded"` with bidirectional `supersedes`/`superseded_by` links instead of deleting history.
7. **Revalidate Stale Records:** Flag expired `RES-NNNN` (`valid_until`) via `validate-project.mjs` warnings before reuse.
