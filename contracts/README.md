# Harness Contract and Record Templates

This directory contains reusable YAML and Markdown templates corresponding to the machine-validatable JSON Schemas in [schemas/](../schemas/README.md).

## Template to Schema Mapping

| Template | Schema | Intended Project Location |
| :--- | :--- | :--- |
| [adr-template.md](./adr-template.md) | [adr.schema.json](../schemas/adr.schema.json) | `brain/decisions/ADR-NNNN-<slug>.md` or `proposals/` |
| [task-contract-template.yaml](./task-contract-template.yaml) | [task-contract.schema.json](../schemas/task-contract.schema.json) | `tasks/TASK-NNNN-<slug>.yaml` or `tasks/<queue>/` |
| [agent-handoff-template.yaml](./agent-handoff-template.yaml) | [agent-handoff.schema.json](../schemas/agent-handoff.schema.json) | `tasks/` or `proposals/` |
| [research-record-template.md](./research-record-template.md) | [research-record.schema.json](../schemas/research-record.schema.json) | `brain/research/RES-NNNN-<slug>.md` or `proposals/` |
| [evidence-manifest-template.yaml](./evidence-manifest-template.yaml) | [evidence-manifest.schema.json](../schemas/evidence-manifest.schema.json) | `evidence/EVID-NNNN-<slug>.yaml` |
| [approval-record-template.yaml](./approval-record-template.yaml) | [approval-record.schema.json](../schemas/approval-record.schema.json) | `proposals/APPR-NNNN-<slug>.yaml` |
| [conflict-record-template.yaml](./conflict-record-template.yaml) | [conflict-record.schema.json](../schemas/conflict-record.schema.json) | `brain/conflicts/CONF-NNNN-<slug>.yaml` |
| [incident-record-template.yaml](./incident-record-template.yaml) | [incident-record.schema.json](../schemas/incident-record.schema.json) | `brain/incidents/INC-NNNN-<slug>.yaml` |
| [recovery-checkpoint-template.yaml](./recovery-checkpoint-template.yaml) | [recovery-checkpoint.schema.json](../schemas/recovery-checkpoint.schema.json) | `<workspace-root>/local-runtime/checkpoints/CHKPT-NNNN.yaml` |
| [context-pack-manifest-template.yaml](./context-pack-manifest-template.yaml) | [context-pack-manifest.schema.json](../schemas/context-pack-manifest.schema.json) | `<workspace-root>/local-runtime/context-cache/CPACK-NNNN.yaml` |

> **Note:** Project Manifest (`brain/manifest.yaml`) and Project State (`brain/state/current.yaml`) templates live in [templates/project-starter/](../templates/project-starter/README.md).
> Complete schema-valid examples (explicitly marked as non-authoritative examples) live in [examples/](./examples/README.md).
