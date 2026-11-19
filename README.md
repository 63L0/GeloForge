# GeloForge

**Build with AI without losing track of your project.**

**Version:** `0.2.0` | **License:** [MIT](./LICENSE)

GeloForge is an open-source starter kit for developers who use AI coding assistants.

When you're building software with AI, project details can end up scattered across chats. You might find yourself explaining the same requirements again, hunting for decisions you made last week, or setting up the same folders for every new project.

GeloForge gives you a more organized starting point. It creates a project structure with a **Second Brain**: a set of files where you can keep your requirements, plans, decisions, and progress. Those files stay with your project, so you and your AI coding tools can refer back to them.

It also includes reusable project templates and checks to catch common mistakes in project records.

> **What works today:** Project creation, Second Brain files, optional project profiles, and validation tools. You can use these with a single AI coding assistant. **Automatic AI agent coordination and automatic context selection are planned, not built yet.**

---

## 1. Why Use GeloForge?

- **Spend less time setting up.** Start a web, desktop, mobile, automation, or AI-system project from a consistent template.
- **Keep the important stuff together.** Store requirements, architecture decisions, tasks, and progress in your project instead of relying on old chat conversations.
- **Use your preferred AI coding tool.** Give Codex, Gemini, or another assistant the same project files as reference. GeloForge doesn't run those tools for you yet.
- **Catch issues early.** Validate project records, links, and references before they cause confusion.
- **Keep projects independent.** Each new project has its own files and can have its own Git repository.

**New here?** Jump to [Installation and Setup](#5-installation-and-setup), then [Create a New Project](#6-how-to-create-a-new-project--use-project-profiles).

## 2. What Is Implemented Today?

- **Provider-neutral core ([core/](./core/project-validator.mjs)):** Zero-dependency YAML 1.2 subset parser ([yaml-subset.mjs](./core/yaml-subset.mjs)), JSON Schema subset validator ([json-schema-lite.mjs](./core/json-schema-lite.mjs)), portable path/symlink safety ([path-safety.mjs](./core/path-safety.mjs)), version compatibility engine ([compatibility.mjs](./core/compatibility.mjs)), and full Second Brain validator ([project-validator.mjs](./core/project-validator.mjs)).
- **12 JSON Schemas ([schemas/](./schemas/README.md)) & 10 contract templates + marked examples ([contracts/](./contracts/README.md)):** Manifests (`1.0`/`1.1`), project state (`1.0`/`1.1`), ADRs, tasks, handoffs, research, evidence, approvals, conflicts, incidents, checkpoints, and context packs.
- **Base Second Brain + 5 optional project profiles ([templates/](./templates/profiles/README.md)):** Minimal starter ([project-starter/](./templates/project-starter/README.md)) with concise `AGENTS.md` / `GEMINI.md` entrypoints and domain overlays (`web`, `desktop`, `mobile`, `automation`, `ai-system`).
- **Transactional project generator ([scripts/bootstrap-project.mjs](./scripts/bootstrap-project.mjs)):** Stages into a temporary sibling directory, validates before commit, blocks traversal/overwrites/symlinks/double-interpolation, and supports `--dry-run`, `--profile`, and optional `--git`.
- **Standalone project validator ([scripts/validate-project.mjs](./scripts/validate-project.mjs)) & `node:test` suite (`tests/`).**

## 3. What Is Not Implemented Yet?

- Deterministic Context Compiler executable ([context-compiler-spec.md](./context/context-compiler-spec.md) is design-only).
- Restricted Integration Controller and automatic proposal-to-canonical promotion.
- Operational Codex CLI, Gemini CLI, or multi-agent subagent runners ([adapters/](./adapters/README.md) and [roles/](./roles/README.md) are documentation-only).
- OS/filesystem write-ownership enforcement, automated checkpoints, live task schedulers, `skills/`, `evaluations/`, vector databases, RAG pipelines, or paid API integrations.

## 4. Requirements and Prerequisites

- **Node.js `>= 20.0.0`** (uses built-in `node:test`, `node:fs`, `node:path`, `node:util`, `node:child_process`; **zero `npm install` dependencies required**).
- **Git** (used for cloning GeloForge and optional `--git` repository initialization on new projects).
- **Platform status:** Directly tested on **Windows 11**. Code avoids hardcoded drive letters and usernames via `node:path`, but **Linux and macOS execution have not been tested directly**.

## 5. Installation and Setup

Clone the repository and verify all foundation tests locally (no `npm install` or API keys needed):

```bash
git clone https://github.com/63L0/GeloForge.git
cd GeloForge
npm test
```

If you use the multi-project workspace layout (`<workspace>/harness`, `<workspace>/projects`, `<workspace>/worktrees`, `<workspace>/local-runtime`), clone GeloForge as `<workspace>/harness`; otherwise, specify `--dest` when creating projects anywhere on disk.

## 6. How to Create a New Project & Use Project Profiles

GeloForge pairs a single minimal starter (`templates/project-starter/`) with optional domain overlays (`templates/profiles/`): `web`, `desktop`, `mobile`, `automation`, and `ai-system`. Every profile shares the exact same Second Brain contracts while adding `brain/profile.md` and domain `.gitignore` entries.

```bash
# 1. Preview without writing files
node scripts/bootstrap-project.mjs --name "My Web App" --profile web --dest ../my-web-app --git --dry-run

# 2. Generate a web project with its own isolated Git repository
node scripts/bootstrap-project.mjs --name "My Web App" --profile web --dest ../my-web-app --git

# 3. Generate a desktop project
node scripts/bootstrap-project.mjs --name "My Desktop App" --profile desktop --dest ../my-desktop-app --git
```

See [docs/new-projects.md](./docs/new-projects.md) and [templates/profiles/README.md](./templates/profiles/README.md) for all flags (`--slug`, `--owner`, `--description`, `--created-at`).

## 7. How the Second Brain Works

Every generated project keeps persistent project memory inside its own repository in plain Markdown and YAML across four conceptual layers:

1. **Authoritative (`L1_AUTHORITATIVE`):** `brain/manifest.yaml`, `brain/requirements/{prd.md, constraints.md}`, `brain/architecture/overview.md`, `brain/decisions/ADR-*.md`.
2. **Operational (`L2_OPERATIONAL`):** `brain/state/current.yaml`, `tasks/`, plus on-demand `brain/conflicts/`, `brain/incidents/`, and `proposals/`.
3. **Research & Evidence (`L3_RESEARCH_EVIDENCE`):** On-demand `brain/research/`, `brain/lessons/`, and `evidence/EVID-*.yaml`.
4. **Temporary Context (`L4_TEMPORARY_CONTEXT`):** Reserved outside Git for ephemeral future compiler packets (**not implemented**).

Provider entrypoints (`AGENTS.md` and `GEMINI.md`) stay minimal and point to `brain/INDEX.md` instead of duplicating memory. Details: [docs/second-brain.md](./docs/second-brain.md) and [policies/memory-policy.md](./policies/memory-policy.md).

## 8. How to Run Validation and Tests

```bash
# Run the full GeloForge foundation test suite
npm test

# Validate any generated or existing project's Second Brain
node scripts/validate-project.mjs --project ../my-web-app
```

Validation checks YAML/frontmatter syntax, strict JSON Schemas, version compatibility, duplicate record IDs, cross-record references, `is_example` canonical guards, relative Markdown links, and path portability.

## 9. How to Update GeloForge

1. Inspect [CHANGELOG.md](./CHANGELOG.md), [core/compatibility.json](./core/compatibility.json), and [docs/versioning-and-upgrades.md](./docs/versioning-and-upgrades.md).
2. Pull updates inside your GeloForge clone and run `npm test`.
3. Run `node scripts/validate-project.mjs --project <path>` against existing projects to confirm compatibility or check for additive upgrade notices (`1.0` → `1.1`).

## 10. How to Recover from an Error

- **Bootstrap failure:** The generator stages files into a sibling `.harness-stage-*` directory and validates before atomic rename; failures delete staging automatically without touching existing files.
- **Project validation failure:** `validate-project.mjs` reports exact file paths, duplicate IDs, or broken references without modifying your project.
- **Repository regression:** Use standard Git recovery (`git status`, `git diff`, `git revert <commit>`); see [docs/versioning-and-upgrades.md](./docs/versioning-and-upgrades.md).

## 11. Limitations, Future Roadmap, and License

- **Known Limitations:** [docs/known-limitations.md](./docs/known-limitations.md) (explicitly separates technically enforced protections from documented-only policies).
- **Future Roadmap:** [docs/future-roadmap.md](./docs/future-roadmap.md) (future Context Compiler, Restricted Integration Controller, and Codex/Gemini provider adapters — all **not implemented**).
- **Security & Contributing:** [SECURITY.md](./SECURITY.md) | [CONTRIBUTING.md](./CONTRIBUTING.md)
- **License:** Released under the [MIT License](./LICENSE) (`Copyright (c) 2026 63L0`). Note: `"private": true` in [package.json](./package.json) prevents accidental npm registry publishing while keeping this GitHub repository open-source under MIT.
