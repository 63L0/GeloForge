# Harness Foundation Architecture

## 1. Design Goals

The harness isolates **shared core tooling and contracts** (`harness/`), **project repositories and memory** (`projects/`), **isolated execution directories** (`worktrees/`), and **machine-local ephemeral state** (`local-runtime/`):

- **Simplicity First:** Only files and directories needed today exist in the template; secondary Second Brain folders (`research/`, `conflicts/`, `incidents/`, `evidence/`, `proposals/`) are created on demand.
- **Provider Independence:** Project memory lives in plain Markdown and YAML inside each project repository (`brain/` and `tasks/`), separate from provider adapters ([adapters/](../adapters/README.md)) and vendor chat sessions.
- **Repository Isolation:** `<harness-root>` is its own Git repository; each initialized project under `projects/<slug>` can hold an independent Git repository; `<workspace-root>` itself has no `.git`.
- **Zero External Dependencies:** Runs strictly on Node.js `>= 20.0.0` built-ins and Git with zero `npm install` packages or network access.

## 2. Workspace Layout

| Directory | Purpose | Version Control | Status |
| :--- | :--- | :--- | :--- |
| `<workspace-root>/` | Top-level workspace container | **No Git repo** | **Implemented** |
| `<harness-root>/` (`harness/`) | `core/`, `adapters/`, `policies/`, `roles/`, `schemas/`, `contracts/`, `templates/`, `scripts/`, `tests/`, `docs/` | **Independent Git repo** | **Implemented** / **Verified** |
| `<workspace-root>/projects/` | Host directory for generated projects | Separate Git repo per project | **Implemented** |
| `<workspace-root>/worktrees/` | Reserved for future Git worktree isolation | Managed per project later | **Implemented** (unused in Phase 1) |
| `<workspace-root>/local-runtime/` | Non-versioned `logs/`, `context-cache/`, `checkpoints/`, `task-state/` | **Excluded from Git** | **Implemented** (producers **NOT IMPLEMENTED**) |

## 3. Harness Internal Structure

- `core/` — Portable zero-dependency engines: [yaml-subset.mjs](../core/yaml-subset.mjs), [json-schema-lite.mjs](../core/json-schema-lite.mjs), [path-safety.mjs](../core/path-safety.mjs), [compatibility.mjs](../core/compatibility.mjs), [compatibility.json](../core/compatibility.json), [project-validator.mjs](../core/project-validator.mjs).
- `adapters/` — Documentation-only provider boundaries (`antigravity/`, `codex/`, `gemini/`).
- `templates/` — Minimal `project-starter/` base template + 5 small domain profiles (`templates/profiles/`).
- `schemas/` & `contracts/` — 12 JSON Schemas, 10 record templates, and 10 marked `is_example: true` examples.
- `scripts/` — [bootstrap-project.mjs](../scripts/bootstrap-project.mjs) and [validate-project.mjs](../scripts/validate-project.mjs).
- `tests/` — Modular `node:test` verification suite (`npm test`).

## 4. Related Documents

- [Second Brain Architecture](./second-brain.md)
- [New Project Initialization](./new-projects.md)
- [Versioning & Upgrades](./versioning-and-upgrades.md)
- [Future Roadmap](./future-roadmap.md)
- [Known Limitations](./known-limitations.md)
