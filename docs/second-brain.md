# Second Brain Architecture

The Second Brain is the canonical, provider-independent project memory system packaged inside [templates/project-starter/](../templates/project-starter/README.md). Every project created from the starter carries its own self-contained Second Brain alongside `src/` and `tests/`.

## 1. Provider Independence and Concise Entrypoints

- AI tools (future Codex, Gemini CLI, Google Antigravity, or VS Code workflows) read **shared Markdown and YAML files** under `brain/` and `tasks/`.
- `AGENTS.md` and `GEMINI.md` at a project's root are intentionally brief **entrypoints** pointing to `brain/INDEX.md`, `brain/manifest.yaml`, `brain/state/current.yaml`, and global harness policies.
- Duplicating requirements or decisions inside provider-specific files is prohibited because duplication creates silent divergence (`CONF-NNNN`).
- Including `AGENTS.md` and `GEMINI.md` in a project does **not** automatically configure Codex, Gemini CLI, or autonomous agent execution.

## 2. Four Memory Layers

| Layer | Purpose | Key Files / Directories | Schema Coverage |
| :--- | :--- | :--- | :--- |
| **Layer 1 — Authoritative Knowledge** (`L1_AUTHORITATIVE`) | Owner-approved requirements, accepted ADRs, constraints, standards | `brain/manifest.yaml`, `brain/requirements/prd.md`, `brain/requirements/constraints.md`, `brain/architecture/overview.md`, `brain/decisions/` | [project-manifest.schema.json](../schemas/project-manifest.schema.json), [adr.schema.json](../schemas/adr.schema.json) |
| **Layer 2 — Operational Memory** (`L2_OPERATIONAL`) | Active tasks, verified state, dependencies, blockers, pending approvals, conflicts, checkpoints | `brain/state/current.yaml`, `tasks/{inbox,active,review,completed,blocked}/`, `proposals/`, `brain/conflicts/` | [project-state.schema.json](../schemas/project-state.schema.json), [task-contract.schema.json](../schemas/task-contract.schema.json), [agent-handoff.schema.json](../schemas/agent-handoff.schema.json), [approval-record.schema.json](../schemas/approval-record.schema.json), [conflict-record.schema.json](../schemas/conflict-record.schema.json), [recovery-checkpoint.schema.json](../schemas/recovery-checkpoint.schema.json) |
| **Layer 3 — Research and Evidence** (`L3_RESEARCH_EVIDENCE`) | Source-backed findings, lessons learned, verification evidence manifests | `brain/research/`, `brain/lessons/`, `evidence/`, `proposals/` | [research-record.schema.json](../schemas/research-record.schema.json), [evidence-manifest.schema.json](../schemas/evidence-manifest.schema.json) |
| **Layer 4 — Temporary Context** (`L4_TEMPORARY_CONTEXT`) | Compiled task-specific context packets and revision manifests | `C:\AI-Workspace\local-runtime\context-cache\` (**NOT IMPLEMENTED**) | [context-pack-manifest.schema.json](../schemas/context-pack-manifest.schema.json) |

## 3. Authority Hierarchy (`A0`–`A6`) and Conflict Handling

The authority scale (`A0` global security -> `A1` requirements -> `A2` accepted ADRs -> `A3` verified evidence -> `A4` operational records -> `A5` external research -> `A6` unverified observations) defines **trust classes, not permission to ignore contradictory evidence**.

Full governance rules—including write ownership and the future proposal/approval/promotion/revalidation lifecycle—are specified in [memory-policy.md](../policies/memory-policy.md).

## 4. Starter Template Layout

See [templates/project-starter/brain/INDEX.md](../templates/project-starter/brain/INDEX.md) for the exact project-level directory index generated for every new project.
