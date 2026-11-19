# AI Development Harness Foundation

**Version:** `0.1.0-foundation`  
**Phase:** Phase 1 — Foundational Workspace, Second Brain, and Reusable Project Templates

> **IMPORTANT HONESTY NOTICE:** This repository establishes the **foundation only**—folder layout, policies, role specifications, JSON schemas, contract templates, a reusable Second Brain starter template, a local project bootstrapper, and local validation tools. **The autonomous multi-agent harness itself is NOT operational yet.**

## Workspace Layout

```text
C:\AI-Workspace\
├── harness\          # This Git repository (policies, roles, schemas, templates, scripts, validators)
├── projects\         # Future isolated project repositories (each with its own Git repo)
├── worktrees\        # Reserved for future isolated Git worktrees (unused in Phase 1)
└── local-runtime\    # Machine-local non-versioned runtime folders (producers NOT IMPLEMENTED)
```

## Phase 1 Capability Status

| Capability | Status | Details |
| :--- | :--- | :--- |
| Workspace & folder structure (`C:\AI-Workspace`) | **Implemented** / **Verified** | Created and verified via [validate-foundation.mjs](./validators/validate-foundation.mjs) |
| Second Brain template (`templates/project-starter/`) | **Implemented** / **Verified** | Provider-independent Markdown/YAML structure, `AGENTS.md` / `GEMINI.md` entrypoints |
| 11 JSON Schemas (`schemas/`) & 9 contract templates + examples (`contracts/`) | **Implemented** / **Verified** | Local JSON Schema Draft 2020-12 subset validation and YAML parsing |
| New-project bootstrap script (`scripts/bootstrap-project.mjs`) | **Implemented** / **Verified** | Zero-dependency Node.js CLI with `--dry-run`, path safety, overwrite refusal, optional `--git` |
| Local foundation validation suite (`validators/validate-foundation.mjs`) | **Implemented** / **Verified** | Verifies structure, schemas, examples, markdown links, bootstrap behavior, Git hygiene |
| Governance policies (`policies/`) & 5 agent role specs (`roles/`) | **Documented only** | No runtime or filesystem write-ownership enforcement in Phase 1 |
| Deterministic Context Compiler (`context/context-compiler-spec.md`) | **Documented only** / **Not implemented** | Architecture and manifest schema exist; compiler runtime not built |
| Restricted Integration Controller & automatic knowledge promotion | **Not implemented** | All knowledge promotion remains manual |
| Codex CLI, Gemini CLI, and operational subagent configs | **Not implemented** | Deliberately out of scope for Phase 1 |
| Automated orchestration, schedulers, worktrees, checkpoints, evaluations | **Not implemented** | Reserved scaffolds only |
| Paid API integrations, vector DB, RAG, remote Git hosting | **Not implemented** | Explicitly excluded from Phase 1 |
| Live multi-agent execution & OS ACL enforcement checks | **Blocked** *(by scope / unbuilt runtime)* | Cannot be tested until Phase 2+ runtime components exist |

## Quick Commands

Run from `C:\AI-Workspace\harness`:

```powershell
# 1. Validate the entire Phase 1 foundation locally (zero dependencies, zero network calls)
node validators/validate-foundation.mjs
# or:
npm run validate

# 2. Preview new project creation without writing any files
node scripts/bootstrap-project.mjs --name "My Sample App" --owner "Project Owner" --dry-run

# 3. Initialize a new project under C:\AI-Workspace\projects\my-sample-app with its own Git repo
node scripts/bootstrap-project.mjs --name "My Sample App" --owner "Project Owner" --git
```

## Documentation Map

- [Architecture Overview](./docs/architecture.md) — Workspace separation, Git repo boundaries, and Phase 1 vs. future components.
- [Second Brain Guide](./docs/second-brain.md) — Four memory layers, authority classes (`A0`–`A6`), and project-starter structure.
- [New Projects Guide](./docs/new-projects.md) — How to safely bootstrap new projects and initialize their Second Brain.
- [Future Roadmap](./docs/future-roadmap.md) — Phased plan for later Context Compiler, integration controller, and Codex/Gemini phases (**NOT IMPLEMENTED**).
- [Known Limitations](./docs/known-limitations.md) — Explicit breakdown of what is verified vs. documentation-only vs. not implemented.
- [Policies](./policies/memory-policy.md) — [Memory Policy](./policies/memory-policy.md), [Approval Boundaries](./policies/approval-boundaries.md), and [Token Efficiency](./policies/token-efficiency.md).
- [Schemas](./schemas/README.md) & [Contracts](./contracts/README.md) — Machine-validatable schemas, templates, and marked examples.
- [Roles](./roles/README.md) & [Context Compiler Spec](./context/context-compiler-spec.md) — Future agent role contracts and context compilation design.
