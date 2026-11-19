# Second Brain Architecture

The Second Brain is the canonical, provider-independent project memory system packaged in [templates/project-starter/](../templates/project-starter/README.md).

## 1. Design Principles

- **Minimal Mandatory Footprint:** Every project starts with 5 core record areas (`brain/manifest.yaml`, `brain/requirements/`, `brain/state/current.yaml`, `brain/decisions/`, `tasks/`) rather than dozens of empty folders.
- **On-Demand Extensions:** Optional folders (`brain/research/`, `brain/lessons/`, `brain/conflicts/`, `brain/incidents/`, `proposals/`, `evidence/`, `docs/`) are created only when needed and validated automatically whenever present.
- **Concise Provider Entrypoints:** `AGENTS.md` and `GEMINI.md` link to shared `brain/` files without duplicating project knowledge or assuming automatic tool configuration.

## 2. Four Memory Layers

| Layer | Purpose | Canonical Locations | Key Schemas |
| :--- | :--- | :--- | :--- |
| **Layer 1 (`L1_AUTHORITATIVE`)** | Owner-approved requirements, accepted ADRs, constraints, standards | `brain/manifest.yaml`, `brain/requirements/`, `brain/architecture/`, `brain/decisions/` | [project-manifest.schema.json](../schemas/project-manifest.schema.json), [adr.schema.json](../schemas/adr.schema.json) |
| **Layer 2 (`L2_OPERATIONAL`)** | Active tasks, verified state, blockers, pending approvals, conflicts, incidents, checkpoints | `brain/state/current.yaml`, `tasks/`, `brain/conflicts/`, `brain/incidents/`, `proposals/` | [project-state.schema.json](../schemas/project-state.schema.json), [task-contract.schema.json](../schemas/task-contract.schema.json), [agent-handoff.schema.json](../schemas/agent-handoff.schema.json), [approval-record.schema.json](../schemas/approval-record.schema.json), [conflict-record.schema.json](../schemas/conflict-record.schema.json), [incident-record.schema.json](../schemas/incident-record.schema.json), [recovery-checkpoint.schema.json](../schemas/recovery-checkpoint.schema.json) |
| **Layer 3 (`L3_RESEARCH_EVIDENCE`)** | External research, lessons learned, verification evidence manifests | `brain/research/`, `brain/lessons/`, `evidence/`, `proposals/` | [research-record.schema.json](../schemas/research-record.schema.json), [evidence-manifest.schema.json](../schemas/evidence-manifest.schema.json) |
| **Layer 4 (`L4_TEMPORARY_CONTEXT`)** | Task-specific compiled context packets and source revision references | `<workspace-root>/local-runtime/context-cache/` (**NOT IMPLEMENTED**) | [context-pack-manifest.schema.json](../schemas/context-pack-manifest.schema.json) |

## 3. Knowledge Integrity and Validation

Running `node scripts/validate-project.mjs --project <path>` verifies:

- Valid YAML/frontmatter syntax and JSON Schema compliance (`schema_version` `"1.0"` or `"1.1"`).
- No duplicate record IDs (`ADR-NNNN`, `TASK-NNNN`, `RES-NNNN`, `EVID-NNNN`, `CONF-NNNN`, `INC-NNNN`, etc.).
- No broken cross-record references (`state.active_tasks`, `TASK` dependencies/inputs/evidence, `ADR` supersession/research/approvals, `CONF` paths, `INC` refs).
- No `is_example: true` fixtures placed inside canonical directories, no `accepted` ADRs missing `approved_by`/`decided_at`, and freshness warnings for expired `RES-NNNN` (`valid_until`).

Governance rules (`A0`–`A6` trust classes, write ownership, proposal promotion) are documented in [memory-policy.md](../policies/memory-policy.md).
