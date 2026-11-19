# AI Development Harness Foundation

**Version:** `0.2.0` (`package.json` `"private": true` — select a public `LICENSE` before making any remote repository public)

> **Honesty Boundary:** This repository provides the **foundation only** (schemas, templates, profiles, compatibility checks, local project validation, and a transactional project generator). **Multi-agent orchestration, Codex CLI, Gemini CLI, Context Compiler runtime, and automated knowledge promotion are NOT implemented yet.**

## 1. What Is This Harness Foundation?

A lightweight, provider-neutral workspace and Second Brain template system for organizing software projects in persistent, machine-validatable Markdown and YAML—completely independent of any AI provider's chat history.

## 2. What Is Implemented?

- **Provider-neutral core (`core/`):** Zero-dependency YAML 1.2 subset parser ([yaml-subset.mjs](./core/yaml-subset.mjs)), JSON Schema subset validator ([json-schema-lite.mjs](./core/json-schema-lite.mjs)), portable path/symlink safety ([path-safety.mjs](./core/path-safety.mjs)), version compatibility engine ([compatibility.mjs](./core/compatibility.mjs)), and full project validator ([project-validator.mjs](./core/project-validator.mjs)).
- **12 JSON Schemas (`schemas/`) & 10 contract templates + marked examples (`contracts/`):** Covering project manifests (`1.0`/`1.1`), project state (`1.0`/`1.1`), ADRs, tasks, handoffs, research, evidence, approvals, conflicts, incidents, checkpoints, and context packs.
- **Base Second Brain + 5 optional profiles (`templates/`):** Minimal `project-starter/` plus domain overlays (`web`, `desktop`, `mobile`, `automation`, `ai-system`) sharing one core structure and concise `AGENTS.md` / `GEMINI.md` entrypoints.
- **Transactional project bootstrapper ([bootstrap-project.mjs](./scripts/bootstrap-project.mjs)):** Stages into a temporary sibling directory, validates before commit, prevents overwrites/traversal/symlinks/double-interpolation, supports `--dry-run`, `--profile`, and optional `--git`.
- **Standalone project validator ([validate-project.mjs](./scripts/validate-project.mjs)) & `node:test` suite (`tests/`).**

## 3. What Is Not Implemented?

- Deterministic Context Compiler execution ([context-compiler-spec.md](./context/context-compiler-spec.md) is design-only).
- Restricted Integration Controller and automatic knowledge promotion.
- Operational Codex CLI, Gemini CLI, or Antigravity subagent runners ([adapters/](./adapters/README.md) are documentation-only).
- Runtime write-ownership enforcement, live schedulers, automated checkpoints, `skills/`, `evaluations/`, vector databases, RAG pipelines, or paid API integrations.

## 4. What Tools Are Required?

- **Node.js `>= 20.0.0`** (uses built-in `node:test`, `node:fs`, `node:path`, `node:util`, `node:child_process`; zero `npm install` dependencies).
- **Git** (for harness version control and optional `--git` project initialization).
- **Platform note:** Directly tested on **Windows 11**. Code uses platform-neutral `node:path` APIs without hardcoded usernames or drive letters, but **Linux and macOS execution have not been tested directly**.

## 5. How Do I Initialize a Project?

Run from `<harness-root>`:

```powershell
# Preview without writing files
node scripts/bootstrap-project.mjs --name "My App" --profile web --git --dry-run

# Create project under <workspace-root>/projects/my-app with an isolated Git repo
node scripts/bootstrap-project.mjs --name "My App" --profile web --git
```

See [docs/new-projects.md](./docs/new-projects.md) for all options (`--slug`, `--dest`, `--owner`, `--description`, `--profile`).

## 6. How Does the Second Brain Work?

Each project stores its memory in plain Markdown and YAML across four conceptual layers:

1. **Authoritative (`L1_AUTHORITATIVE`):** `brain/manifest.yaml`, `brain/requirements/{prd.md, constraints.md}`, `brain/architecture/overview.md`, `brain/decisions/ADR-*.md`.
2. **Operational (`L2_OPERATIONAL`):** `brain/state/current.yaml`, `tasks/`, optional `brain/conflicts/`, `brain/incidents/`, `proposals/`.
3. **Research & Evidence (`L3_RESEARCH_EVIDENCE`):** Optional `brain/research/`, `brain/lessons/`, `evidence/EVID-*.yaml`.
4. **Temporary Context (`L4_TEMPORARY_CONTEXT`):** Reserved outside Git under `<workspace-root>/local-runtime/context-cache/` (**not implemented**).

Details: [docs/second-brain.md](./docs/second-brain.md) and [policies/memory-policy.md](./policies/memory-policy.md).

## 7. How Do I Validate a Project (or the Harness)?

```powershell
# Validate the harness foundation itself (all 7 test suites)
npm test

# Validate any initialized project Second Brain
node scripts/validate-project.mjs --project ../projects/my-app
```

## 8. How Do I Update the Harness?

1. Inspect [CHANGELOG.md](./CHANGELOG.md), [core/compatibility.json](./core/compatibility.json), and [docs/versioning-and-upgrades.md](./docs/versioning-and-upgrades.md).
2. Pull or review harness changes inside `<harness-root>` (never modifying existing `projects/` automatically) and run `npm test`.
3. Run `node scripts/validate-project.mjs --project <path>` against each existing project to verify compatibility or identify recommended manifest upgrades (`1.0` -> `1.1`).

## 9. How Do I Recover from an Error?

- **Bootstrap failure:** The generator writes into a temporary sibling `.harness-stage-*` folder and validates before atomic rename; failed runs automatically delete staging and leave existing files untouched.
- **Validation failure:** `validate-project.mjs` prints exact file paths, duplicate IDs, broken references, or schema mismatches without mutating project files.
- **Harness regression:** Use standard Git inspection/revert (`git status`, `git diff`, `git revert <commit>`) inside `<harness-root>`; see [docs/versioning-and-upgrades.md](./docs/versioning-and-upgrades.md).

## 10. What Comes Next?

1. Select an explicit `LICENSE` before publishing to a public GitHub remote.
2. Build and benchmark the deterministic Context Compiler (`context/context-compiler-spec.md`).
3. Implement provider-specific adapters (`adapters/`) and a scripted promotion gate before enabling multi-agent execution. See [docs/future-roadmap.md](./docs/future-roadmap.md).
