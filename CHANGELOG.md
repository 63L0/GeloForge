# Changelog

All notable changes to GeloForge are recorded in this file.

## [0.4.0] — Unreleased

This release adds safer project onboarding, portable Agent Skills interoperability, and an evidence-backed skill improvement lifecycle. The release is being prepared; the final tag and GitHub Release have **not** been published.

### Added
- **Existing-project onboarding and project-local CLI discovery (PR #3):** `geloforge adopt` works with existing repositories; the CLI discovers project roots from the current working directory.
- **Tasks and reproducible evidence (PR #3):** `geloforge task new|list|show` and `geloforge evidence capture` record explicit command results and verified outcomes without executing through a shell.
- **Portable Agent Skills foundation (PR #4):** Discover local/global `SKILL.md` skills with standard frontmatter, strict validation, static linting, quarantine for proposals, and `geloforge skills list|show|validate|lint`.
- **Progressive skill disclosure (PR #4):** Optional `geloforge context --skills`, explicit skill selection, deterministic relevance ranking, bounded context loading, and lazy supporting-resource pointers.
- **Evidence-backed adaptive skill lifecycle (PR #5):** Quarantined drafts from verified evidence/handoffs, proposed skill updates, signed approval records, review-branch preparation, trust-aware promotion, SHA-256 package/history records, and authorized rollback.
- **Maintainer security ownership guidance (PR #6):** `.github/CODEOWNERS` and `docs/maintainer-security.md` describe review routing and protected-branch setup for solo maintainers and teams.

### Security
- Added signed approval validation, one-time approval consumption, content/evidence digest binding, invalid timestamp rejection, secret/resource scans, snapshot confinement, and transactional recovery on failed promotion or rollback.
- Added adversarial regression tests for approval replay, key substitution under pinned-key verification, evidence tampering, symlink/junction attacks, poisoned snapshots, and partial failures.
- **Trust boundary:** Signed approvals do not establish an independent human decision if an agent can access the signing key, replace the trusted public-key registry, or directly edit the skill files. Use external public-key pinning with independent private-key custody, or genuinely enforced protected-branch reviews. Local `--interactive` is a weaker convenience control.
- **Static lint is not a sandbox** and does not guarantee protection against semantic prompt injection. Skills' scripts are never automatically executed.

### Compatibility and verification
- Preserves Node.js >=20, MIT licensing, zero third-party runtime dependencies, and legacy schema version 1.0/1.1 compatibility.
- Adaptive skills PR #5 was reported locally at 64/64 tests passing, with all six GitHub Actions matrix checks verified on its final PR head. **Re-run tests, benchmarks, and release-branch CI before tagging**.
- Known limitation: `quick` context budget may exceed its target in constrained scenarios; synthetic context-size benchmarks do not measure LLM accuracy or cost.

## [0.3.0] — 2026-11-19

### Added
- **Deterministic Context Compiler ([context-compiler.mjs](./core/context-compiler.mjs)):** Compiles trust-tiered (`A0` policies, open `CONF-NNNN` contradictions, `A1`–`A2` decisions/constraints, `A3`–`A4` operational/verified state, and quarantined `A5`–`A6`/draft items) `L4` Markdown packets + strict `CPACK-0001` JSON manifests with `--task`/`--query`, `--profile` (`quick`/`working`/`deep`), `--exclude-unverified`, and fixed-point `budget_breakdown`.
- **Selective Codebase Mapper ([codebase-map.mjs](./core/codebase-map.mjs)):** Deterministic, `.gitignore`-aware repository symbol mapper integrated via `geloforge context --map [--map-budget <int>]`, supporting JS/TS, Python, Go, Rust, Java, C#, Kotlin, C/C++, Shell, SQL, Markdown, JSON, YAML, TOML, graceful unsupported-language fallback, 1-hop import graph boost, bounded pre-ranked scanning on large repositories, and hard exclusions for `.env*`, keys, lockfiles, build outputs (`dist/`, `node_modules/`, `bin/Debug/`, `bin/Release/`, `obj/`), and binaries.
- **Cross-Agent File-Based Handoff Engine ([handoff.mjs](./core/handoff.mjs)):** `geloforge handoff` creates and inspects (`--inspect`) schema-valid `HANDOFF-NNNN` YAML + Markdown transfers across roles and AI tools while separating audited `verified_evidence` (`status: "verified"` with `>= 1` passed and `0` failed/blocked checks) from `unverified_claims` and surfacing `contradiction_warnings`, Git state/drift, and read-only `brain/` references.
- **Unified CLI ([scripts/geloforge.mjs](./scripts/geloforge.mjs)) & Status Engine ([core/project-status.mjs](./core/project-status.mjs)):** Added single entrypoint with `init`, `validate`, `context`, `handoff`, and `status` commands (with `--json` and atomic `--out`).
- **Shared Project-Scoped Git Helpers ([git-utils.mjs](./core/git-utils.mjs)) & Hardened Path Safety ([path-safety.mjs](./core/path-safety.mjs)):** Shared secret-content scanner, atomic temp+rename writer, symlink-safe walker, macOS `/tmp`/`/var` ancestor compatibility, secret `--out` blocking, and project-scoped Git status preventing parent-repository dirty-file leakage.
- **Deterministic Benchmark & Cross-Platform CI ([scripts/benchmark-context.mjs](./scripts/benchmark-context.mjs), [.github/workflows/ci.yml](./.github/workflows/ci.yml)):** Synthetic benchmarks covering context recall/size, 250-file & 1,200-file codebase mapping, and handoff completeness, plus GitHub Actions CI matrix verified across Linux, macOS, and Windows (Node 20 & 22).
- **Additive Schema Extensions:** Extended [context-pack-manifest.schema.json](./schemas/context-pack-manifest.schema.json) (`budget_breakdown`, `codebase_map`) and [agent-handoff.schema.json](./schemas/agent-handoff.schema.json) (`from_tool`, `to_tool`, `git_state`, `verified_evidence`, `unverified_claims`, `contradiction_warnings`, etc.) while keeping `schema_version` `"1.0"` and `"1.1"` compatibility.

### Changed
- Tightened [project-validator.mjs](./core/project-validator.mjs) to scan `handoffs/`, detect mutually exclusive task states, warn on unrecognized files in record folders, reject symlinked roots/files in Second Brain trees, and audit `HANDOFF` `verified_evidence` entries against real `EVID-*` records.
- Documented measured `quick` minimum context floors (`~2,614`+ minimal / `~4,250`+ benchmark est. tokens) and explicit prompt-injection delimiter limitations in [context-compiler-spec.md](./context/context-compiler-spec.md) and [SECURITY.md](./SECURITY.md).

### Fixed
- Portable Node test discovery on Windows (`node --test`), reliable JSON stdout flushing via `process.exitCode`, and Git worktree-prefix root resolution verified across Linux, macOS, and Windows (Node 20 & 22) in GitHub Actions CI.

## [0.2.0] — 2026-11-19

### Added
- Provider-neutral `core/` modules: [path-safety.mjs](./core/path-safety.mjs), [compatibility.mjs](./core/compatibility.mjs), [compatibility.json](./core/compatibility.json), [project-validator.mjs](./core/project-validator.mjs), plus relocated [yaml-subset.mjs](./core/yaml-subset.mjs) and [json-schema-lite.mjs](./core/json-schema-lite.mjs).
- Documentation-only provider adapter boundaries under [adapters/](./adapters/README.md) (`antigravity`, `codex`, `gemini`).
- Five lightweight optional project profiles under [templates/profiles/](./templates/profiles/README.md) (`web`, `desktop`, `mobile`, `automation`, `ai-system`).
- Optional incident record contract: [incident-record.schema.json](./schemas/incident-record.schema.json), [incident-record-template.yaml](./contracts/incident-record-template.yaml), and marked example.
- Standalone project validator CLI ([scripts/validate-project.mjs](./scripts/validate-project.mjs)) checking schemas, compatibility, duplicate IDs, cross-record references, markdown links, and portability.
- Modular zero-dependency `node:test` suite under `tests/` covering structural, bootstrap, Second Brain, compatibility, security, portability, and reuse tests.
- GitHub readiness and governance files: [LICENSE](./LICENSE) (MIT), `.gitattributes`, [SECURITY.md](./SECURITY.md), [CONTRIBUTING.md](./CONTRIBUTING.md), [CHANGELOG.md](./CHANGELOG.md), and [docs/versioning-and-upgrades.md](./docs/versioning-and-upgrades.md).
- Standalone public-clone test compatibility and GeloForge `package.json` / `README.md` release metadata.

### Changed
- Upgraded project manifest/state default `schema_version` to `"1.1"` while preserving `"1.0"` compatibility.
- Simplified `templates/project-starter/` from 14 empty `.gitkeep` folders down to 4 core folders (`brain/decisions/`, `tasks/`, `src/`, `tests/`), keeping secondary folders on-demand.
- Hardened [scripts/bootstrap-project.mjs](./scripts/bootstrap-project.mjs) with transactional staging + atomic rename, single-pass placeholder rendering (no double-interpolation), symlink/NTFS junction ancestor checks, Unicode slug normalization, and profile overlays.
- Removed hardcoded workspace drive paths and usernames across templates, scripts, and docs.

### Removed
- Removed empty placeholder directories `skills/` and `evaluations/` (documented as future roadmap extensions instead) and legacy `validators/` folder superseded by `core/`, `scripts/validate-project.mjs`, and `tests/`.

## [0.1.0-foundation] — 2026-11-19

### Added
- Initial workspace scaffold, global policies, role specifications, 11 JSON schemas, 9 contract templates/examples, `project-starter` template, `bootstrap-project.mjs`, and initial foundation validator.
