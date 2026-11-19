# Harness Foundation Architecture

## 1. Design Goals

Phase 1 establishes a clean separation between **shared harness standards** (`harness/`), **project repositories and memory** (`projects/`), **isolated execution directories** (`worktrees/`), and **ephemeral machine-local state** (`local-runtime/`):

- **Provider Independence:** Project memory resides in plain UTF-8 Markdown and YAML inside each project repository—never trapped inside ChatGPT, Codex, Gemini CLI, or Antigravity session history.
- **Repository Isolation:** The harness itself is a standalone Git repository (`C:\AI-Workspace\harness`). Each future project lives under `C:\AI-Workspace\projects\<slug>` with its own independent Git history. The workspace root (`C:\AI-Workspace\`) is deliberately **not** a Git repository.
- **Zero External Runtime Dependencies:** Phase 1 scripts and validators run purely on built-in Node.js modules (`node:fs`, `node:path`, `node:util`, `node:child_process`) and Git, requiring zero `npm install` calls or network access.
- **Honest Capability Boundaries:** Documentation-only policies and future designs are explicitly labeled **NOT IMPLEMENTED** so future agents never assume unenforced controls are active.

## 2. Workspace Directory Topology

| Directory | Purpose | Version Control | Phase 1 Status |
| :--- | :--- | :--- | :--- |
| `C:\AI-Workspace\` | Top-level workspace root | **No Git repo** | **Implemented** |
| `C:\AI-Workspace\harness\` | Policies, roles, schemas, templates, docs, bootstrap & validator tooling | **Independent Git repo** (`main`) | **Implemented** / **Verified** |
| `C:\AI-Workspace\projects\` | Host folder for individual future projects | Separate Git repo per project | **Implemented** (empty until first project) |
| `C:\AI-Workspace\worktrees\` | Reserved for future parallel Git worktrees | Managed per project worktree later | **Implemented** (scaffold only; **NOT IMPLEMENTED** workflow) |
| `C:\AI-Workspace\local-runtime\` | Ephemeral `logs/`, `context-cache/`, `checkpoints/`, `task-state/` | **Excluded from Git** | **Implemented** (scaffold only; producers **NOT IMPLEMENTED**) |

## 3. Component Breakdown: Phase 1 vs. Future Phases

### Built and Verified in Phase 1
- Directory scaffolding across `harness/`, `projects/`, `worktrees/`, and `local-runtime/`.
- Eleven JSON Schema Draft 2020-12 definitions ([schemas/](../schemas/README.md)) covering manifests, ADRs, tasks, handoffs, research, evidence, state, approvals, conflicts, checkpoints, and context packs.
- Nine contract templates and clearly labeled non-authoritative examples ([contracts/](../contracts/README.md)).
- Reusable project starter ([templates/project-starter/](../templates/project-starter/README.md)) with minimal `AGENTS.md` and `GEMINI.md` entrypoints.
- Zero-dependency project generator ([bootstrap-project.mjs](../scripts/bootstrap-project.mjs)) and foundation validator ([validate-foundation.mjs](../validators/validate-foundation.mjs)).

### Documented Only / Not Implemented Yet
- **Deterministic Context Compiler** ([context-compiler-spec.md](../context/context-compiler-spec.md)) — design specification only.
- **Restricted Integration Controller** ([memory-policy.md](../policies/memory-policy.md)) — future gatekeeper for promoting proposals to Layer 1; not implemented.
- **Agent Role Runners & Provider Adapters** ([roles/](../roles/README.md)) — Codex CLI, Gemini CLI, and Antigravity multi-agent bindings are not configured.
- **Skills (`skills/`) & Evaluations (`evaluations/`)** — empty scaffolds marked **NOT IMPLEMENTED**.

## 4. Related Documents

- [Second Brain Architecture](./second-brain.md)
- [New Project Initialization](./new-projects.md)
- [Future Roadmap](./future-roadmap.md)
- [Known Limitations](./known-limitations.md)
