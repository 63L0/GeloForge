# Memory and Contract Schemas

This directory contains machine-validatable JSON Schema (Draft 2020-12) definitions for all Phase 1 Second Brain records, operational contracts, and future context/recovery manifests.

## Schema Inventory

| Schema File | Record Type | ID Pattern | Primary Memory Layer |
| :--- | :--- | :--- | :--- |
| [project-manifest.schema.json](./project-manifest.schema.json) | Project manifest (`brain/manifest.yaml`) | `^proj-[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$` | `L1_AUTHORITATIVE` |
| [adr.schema.json](./adr.schema.json) | Architecture Decision Record frontmatter | `^ADR-\d{4}$` | `L1_AUTHORITATIVE` |
| [task-contract.schema.json](./task-contract.schema.json) | Task contract | `^TASK-\d{4}$` | `L2_OPERATIONAL` |
| [agent-handoff.schema.json](./agent-handoff.schema.json) | Agent handoff | `^HANDOFF-\d{4}$` | `L2_OPERATIONAL` |
| [research-record.schema.json](./research-record.schema.json) | Research record frontmatter | `^RES-\d{4}$` | `L3_RESEARCH_EVIDENCE` |
| [evidence-manifest.schema.json](./evidence-manifest.schema.json) | Evidence manifest | `^EVID-\d{4}$` | `L3_RESEARCH_EVIDENCE` |
| [project-state.schema.json](./project-state.schema.json) | Project state (`brain/state/current.yaml`) | `project_id` + `state_revision` | `L2_OPERATIONAL` |
| [approval-record.schema.json](./approval-record.schema.json) | Approval record | `^APPR-\d{4}$` | `L1_AUTHORITATIVE` or `L2_OPERATIONAL` |
| [conflict-record.schema.json](./conflict-record.schema.json) | Conflict record | `^CONF-\d{4}$` | `L2_OPERATIONAL` |
| [recovery-checkpoint.schema.json](./recovery-checkpoint.schema.json) | Recovery checkpoint | `^CHKPT-\d{4}$` | `L2_OPERATIONAL` |
| [context-pack-manifest.schema.json](./context-pack-manifest.schema.json) | Context-pack manifest | `^CPACK-\d{4}$` | `L4_TEMPORARY_CONTEXT` |

## Conventions

### Memory Layers (`memory_layer`)
- `L1_AUTHORITATIVE` — Owner-approved requirements, accepted architecture decisions, constraints, and standards.
- `L2_OPERATIONAL` — Active tasks, verified project state, dependencies, blockers, conflicts, checkpoints, and pending approvals.
- `L3_RESEARCH_EVIDENCE` — Research findings, sources, experiments, verification evidence manifests, and lessons learned.
- `L4_TEMPORARY_CONTEXT` — Task-specific compiled context packets and source revision references.

### Authority Levels (`authority_level`)
`A0` (Global harness security rules) through `A6` (Unverified agent observations). See [memory-policy.md](../policies/memory-policy.md) for semantics.

### Strict Property Control
All schemas set `"additionalProperties": false` so stray or misspelled keys fail validation immediately.

### YAML Placeholder Quoting Rule
When a template file contains `{{PLACEHOLDER}}` tokens inside YAML (or Markdown YAML frontmatter), wrap the placeholder in double quotes (`"{{TASK_ID}}"`). Unquoted `{{...}}` is treated as nested flow mappings by YAML parsers and will fail strict YAML parsing.

### Example Record Rule
Every example file in [contracts/examples/](../contracts/examples/README.md) must set `"is_example": true` and `"example_notice"` explicitly marking it as an example, not real evidence or an approved decision.

### Local Validation Scope
In Phase 1, schemas are validated locally using the zero-dependency validator [validate-foundation.mjs](../validators/validate-foundation.mjs) and [json-schema-lite.mjs](../validators/lib/json-schema-lite.mjs). Full runtime enforcement and automated knowledge promotion are **NOT IMPLEMENTED**.
