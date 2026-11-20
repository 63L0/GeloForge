# Third-Party Notices & Pattern Attribution

GeloForge is original software released under the [MIT License](./LICENSE) (`Copyright (c) 2026 63L0`) with zero third-party npm runtime dependencies.

Several design patterns in GeloForge were informed by studying public open-source agent ecosystems. Where upstream design ideas were adapted into original Node.js code, the corresponding project, commit/version, and license notices are preserved below.

---

## 1. NousResearch Hermes Agent (v0.4 Portable Skills Inspiration)

- **Upstream Repository:** https://github.com/NousResearch/hermes-agent
- **Inspected Reference Commit:** `15a495d672bee0ae6361ea523eb0854067e8d024`
- **License:** MIT License (`Copyright (c) 2025 Nous Research`)
- **Patterns Adapted in Original Node.js (`core/skills.mjs`, `core/skills-lint.mjs`, `core/skills-lifecycle.mjs`):**
  - Separating support subdirectories (`references/`, `templates/`, `assets/`, `scripts/`) so nested documentation is never misread as standalone skills.
  - Three-tier progressive disclosure (compact index -> relevant `SKILL.md` -> on-demand reference paths).
  - Anti-rot skill linting heuristics (body size thresholds, trigger guidance, reference sprawl, extraneous scaffolding files, POSIX-only script portability warnings).
  - Static security scanner categories for prompt-injection overrides, encoded shell execution, remote pipe installers, credential exfiltration, and hidden Unicode overrides (extended in GeloForge with fail-closed symlink/junction refusal, `.env*`/secret blacklists, and `A0`/quarantine isolation).
  - Skill provenance tracking, experience-to-draft capture, isolated update diffs, and reversible revision snapshots (implemented in GeloForge with explicit verified-vs-suggested separation, Ed25519/PR-branch/TTY promotion gates, and SHA-256-verified rollback).
- **Attribution Note:** All code in GeloForge's skills modules was implemented from scratch in zero-dependency Node.js; no Python source files from Hermes Agent were copied verbatim.

---

## 2. Agent Skills Specification (`agentskills.io`)

- **Specification:** https://agentskills.io
- **Usage in GeloForge:** GeloForge's portable `SKILL.md` package layout, required `name`/`description` frontmatter rules, optional `license`/`compatibility`/`metadata`/`allowed-tools` fields, and `references/` / `templates/` / `assets/` / `scripts/` conventions follow the open Agent Skills format so skills remain portable across Codex, Gemini CLI, Claude Code, and Hermes-compatible workflows.

---

## 3. v0.3 Architecture & Repo-Map Research References

See [docs/research/upstream-patterns-v0.3.md](./docs/research/upstream-patterns-v0.3.md) for v0.3 design inspirations from GitHub Spec Kit (`MIT`), BMad Method (`MIT`), OpenHands (`MIT`), and Aider (`Apache-2.0` repo-map concept re-implemented cleanly in original Node.js without copying Apache-2.0 source code).
