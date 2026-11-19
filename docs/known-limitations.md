# Known Limitations

This document maintains an honest boundary between **technically enforced capabilities**, **documented-only safeguards**, **not-implemented features**, and **untested environments**.

## 1. Technically Enforced & Verified Today
- **Workspace & Repository Separation:** Verified no root `.git`, independent harness Git repo, `.gitattributes` LF normalization, and `.gitignore` exclusions tested via `git check-ignore`.
- **Bootstrap Path, Symlink & Transactional Safety:** [path-safety.mjs](../core/path-safety.mjs) and [bootstrap-project.mjs](../scripts/bootstrap-project.mjs) enforce traversal blocking, NTFS junction/symlink ancestor refusal, overwrite refusal, single-pass placeholder rendering, and atomic staging rollback.
- **Second Brain Structural & Reference Validation:** [project-validator.mjs](../core/project-validator.mjs) enforces YAML/frontmatter parsing, 12 strict JSON schemas (`"additionalProperties": false`), version compatibility ([compatibility.mjs](../core/compatibility.mjs)), duplicate-ID rejection, cross-record link verification, and relative Markdown link checks.
- **Zero-Network / Zero-Dependency Guarantees:** Static and runtime tests verify zero third-party packages and zero network module usage in `core/` and `scripts/`.

## 2. Documented Only (NOT Technically Enforced)
- **Write Ownership & Authority Hierarchy (`A0`–`A6`):** [memory-policy.md](../policies/memory-policy.md) defines role write limits, but no OS ACLs, Git pre-commit hooks, or runtime sandboxes restrict who edits project files today.
- **Approval Boundaries & Spend Caps:** [approval-boundaries.md](../policies/approval-boundaries.md) and [token-efficiency.md](../policies/token-efficiency.md) (`max 2 specialists`, `max 2 retries`, `zero automatic spend`) are policy targets only—not enforced by a runtime interceptor.
- **Provider Adapters & Agent Roles:** [adapters/](../adapters/README.md) and [roles/](../roles/README.md) are documentation-only contracts.

## 3. Not Implemented
- Deterministic Context Compiler runtime ([context-compiler-spec.md](../context/context-compiler-spec.md)).
- Restricted Integration Controller and automated knowledge promotion.
- Operational Codex CLI, Gemini CLI, or multi-agent subagent execution.
- Automated `CHKPT-NNNN` checkpoints, worktree orchestration, `skills/`, `evaluations/`, vector databases, RAG services, or paid API integrations.
- Public open-source `LICENSE` file (`package.json` remains `"private": true`; the repository owner must select and commit a `LICENSE` before making any GitHub repository public).

## 4. Technical Scope & Platform Limits
- **Zero-Dependency Parser Subset:** [yaml-subset.mjs](../core/yaml-subset.mjs) and [json-schema-lite.mjs](../core/json-schema-lite.mjs) intentionally cover the YAML 1.2 and Draft 2020-12 subsets needed by harness contracts (no YAML anchors/aliases `&/*` or JSON Schema `$ref`/`oneOf`/`allOf`).
- **Platform Testing Boundary:** All tests were executed directly on **Windows 11** (`Node.js >= 20`). Code uses platform-neutral `node:path` APIs and avoids hardcoded drive letters or usernames, but **Linux and macOS execution have NOT been tested directly**.
- **Token Savings Claims:** No token reduction percentages are claimed until the future Context Compiler and provider usage logging are implemented and measured.
