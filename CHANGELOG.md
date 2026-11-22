# Changelog

All notable changes to GeloForge are recorded in this file.

## [0.10.1] — 2026-11-22

- Expand `README.md` into a complete, self-contained beginner-friendly and power-user reference for both GitHub and npmjs.com, adding a copy-paste Beginner AI Prompts table, full 11-pillar feature guide with working examples, all 5 Starter Skill Templates table, full 5-client & 6-tool MCP reference tables, complete 19-command CLI quick reference table, and Second Brain architecture overview (`L1`–`L4` memory layers, `A0`–`A6` authority tiers, 12 JSON Schemas, and 5 agent roles).

## [0.10.0] — 2026-11-22

- Add 1-command long-session compaction (`geloforge compact` / `geloforge checkpoint compact` + MCP `geloforge_checkpoint` `compact` and `resume` actions) in `core/checkpoint.mjs`, saving `CHKPT-NNNN`, compiling a slim diff-focused resume packet, and generating a fresh-chat resume prompt.
- Add `session_hygiene` checks in `geloforge doctor` (`core/doctor.mjs`) and `session_compaction` ranking in `geloforge recommend` (`core/project-status.mjs`) to detect long/uncompacted sessions automatically.
- Add curated 5-template **Starter Skill Catalog** (`STARTER_SKILL_CATALOG`) in `core/skills-advisor.mjs` with `geloforge skills suggest --template <id> [--scaffold-draft]` and MCP `geloforge_skills` `template` support to stage lint-clean quarantined starter workflows (`web-ui-verification`, `backend-api-contracts`, `automation-workflow-guardrails`, `desktop-mobile-release-check`, `security-and-regression-gate`).
- Add shareable PR & project verification report generator (`geloforge report`, `core/project-report.mjs`) outputting GitHub-Flavored Markdown tables and JSON across tasks, audited `EVID-*` receipts, checkpoints, and doctor checks.
- Expand offline regression evals (`npm run eval`) to 10 cases (`10/10`) and add end-to-end tests in `tests/compact-and-report.test.mjs`.

## [0.9.1] — 2026-11-22

- Overhaul `README.md` into a comprehensive public showcase highlighting all major GeloForge features (Contextual BM25 & 3-zone context compiler, 15+ language codebase map, evidence-gated verification, MCP init & SHA-256 tool pinning, `skills suggest` & quarantined scaffolder, bounded coding loops, staging audits, cooperative file leases, Git worktrees, `doctor`, and `hooks init`), using the raw GitHub demo GIF URL so it renders cleanly on both GitHub and npmjs.com.
- Update `package.json` `description` and `keywords` for clearer npm registry discovery.
- Update `docs/advanced-usage.md` to sync version metadata, public npm installation via `npx geloforge`, Antigravity MCP setup, and v0.8/v0.9 feature documentation (`mcp lock`, `loop`, `skills suggest`, `doctor`, `hooks init`, and `npm run eval`).

## [0.9.0] — 2026-11-22

- Add deterministic Project/Goal Skills Advisor and quarantined skill scaffolder (`geloforge skills suggest [--goal|--task|--scaffold-draft]`, `core/skills-advisor.mjs`, MCP `geloforge_skills` `suggest` and `scaffold`, plus `geloforge recommend` integration).
- Add one-command project diagnostics (`geloforge doctor`, `core/doctor.mjs`) checking Node.js version, Second Brain validation, harness compatibility, Git status, leases, skills lint, MCP lock drift, and ambient hooks with actionable fixes.
- Add opt-in ambient hook installer (`geloforge hooks init`, `core/hooks-init.mjs`) for Git `pre-commit`, Claude Code (`hooks.Stop`), and Gemini CLI (`hooks.AfterAgent`) preserving existing user config and MCP servers cleanly.
- Expand offline regression eval suite (`npm run eval`) to 8 cases covering Markdown heading BM25 ranking (`eval-006`), Windows `.state.lock` transient error retries (`eval-007`), and `skills suggest` quarantine/promotion fail-closed gates (`eval-008`).
- Add beginner-friendly "Prompt-to-Install" AI onboarding guide in `README.md` and `docs/beginner-prompts.md`.

## [0.8.1] — 2026-11-22

- Index Markdown headings (`#`–`####`, excluding YAML frontmatter and fenced code blocks) into Contextual BM25 `headerText` (`core/context-compiler.mjs`) so authoritative Markdown docs such as `brain/architecture/overview.md` rank accurately against shorter research drafts.

## [0.8.0] — 2026-11-22

- Add MCP tool-surface pinning (`geloforge mcp lock [--check]`) to `.geloforge/mcp-lock.json` over stdio JSON-RPC 2.0 (zero network calls) with canonical SHA-256 drift detection.
- Add bounded coding loop orchestrator (`geloforge loop run|status`) implementing `implement -> verify -> review -> fix`, upfront hierarchical codebase localization (`includeMap: true`, `fromDiff: true` on fix rounds), fail-closed reviewer `policy_checks`, and verified-evidence completion gates.
- Upgrade context compilation (`core/context-compiler.mjs`, `core/text-utils.mjs`) with an edge-anchored 3-zone layout (contiguous `A0`/`A1-A2` prefix, middle reference/trace, bottom recency anchor for conflicts and operational tasks) and zero-dependency Contextual BM25 retrieval ranking.
- Add concrete `input_examples` and self-correcting error hints to multi-action MCP tools (`core/mcp-server.mjs`).
- Add an offline regression evaluation suite and runner (`npm run eval`, `evaluations/regression-evals.json`).
- Fix Windows headless audit provider stdin EOF handling and Gemini CLI temp-dir workspace trust (`core/audit-provider.mjs`), and bypass query disk caching only while active task leases exist (`core/context-cache.mjs`).
- Harden Windows `.geloforge/.state.lock` contention handling by retrying transient `EPERM`/`EACCES`/`EBUSY` errors during lock inspection, reclamation, and release (`core/project-lock.mjs`).
- Overhaul `README.md` for beginner-friendly onboarding and showcase new MCP locking and bounded loop workflows.

## [0.7.0] — 2026-11-22

- Add opt-in staging audits that load task context and skills, deduplicate deliveries, resume after interruption, and record evidence-backed findings and checkpoints.
- Ship an n8n staging delivery workflow and bounded audit adapters for Codex CLI, Gemini CLI, and Antigravity CLI.
- Learn from recurring verified failures and draft skill updates for owner review.
- Gate requirements and ADR promotion on verified evidence and signed owner approval.
- Add local checkpoint recovery, isolated Git worktrees, and an opt-in disk cache for query context.
- Configure project-scoped MCP for Antigravity with `mcp init --client antigravity`.

[Release notes](./docs/release-notes-v0.7.0.md)

## [0.6.0] — 2026-11-20

- Package the CLI for npm and test installation from the release tarball on Linux, macOS, and Windows.
- Add `geloforge mcp init` for Cursor, VS Code, Claude Code, and Gemini CLI project setup and workflow instructions.
- Add `geloforge verify` to run a check, record evidence, save a checkpoint, and complete a verified task.
- Scope placeholder validation to GeloForge project records and guides so existing application templates can survive adoption.
- Handle lockfiles removed by a concurrent process during project path validation.
- Add a terminal replay and reproducible dogfooding run on GeloForge's own Git worktree.

## [0.5.0] — 2026-11-20

GeloForge v0.5 focuses on practical, human-supervised AI coding sessions and cooperative work across IDEs. This is a GitHub source release; npm publication remains disabled by `private: true`. Release publication is gated on successful CI for the exact current `main` commit.

### Added
- **Human-in-the-Loop Co-Pilot & approval inbox (PR #10):** `geloforge recommend` and richer `status` output suggest next actions and surface pending skills, approvals, architecture proposals, conflicts, and peer lease warnings. Recommendations do not execute automatically.
- **Task lifecycle:** `geloforge task update|done` keeps operational state in sync, removes completed tasks from active context by default, and distinguishes `completed` from genuinely `verified`. `--require-evidence` and explicit `--evidence` allow verified completion gates.
- **Context diet & session recovery:** `geloforge context --from-diff` prioritizes scoped Git changes; `--include-completed` restores omitted historical tasks when needed. `geloforge checkpoint create|list|show` stores resume instructions without attempting to restore a model's private chat state.
- **Multi-IDE cooperative coordination:** `geloforge task claim|release|leases` records task ownership and claimed file scopes with bounded lease durations, and highlights overlapping work.
- **Zero-dependency MCP stdio interface:** Six project-scoped MCP tools expose status, recommendations, context, scoped task/checkpoint operations, and safe skill inspection/proposals. `geloforge mcp --read-only` blocks all mutations. Signing, promotion, rollback, and key generation remain disallowed over MCP.

### Reliability and security
- Added cross-process local project locking and bounded stale-lock reclamation that does not steal a live-PID lock merely due to elapsed TTL.
- Added rollback on handled write errors and a replayable pre-image transaction journal for interrupted CLI mutations, recovered on the next project-lock acquisition.
- Added fail-closed trusted MCP project roots, protocol input/frame size limits, and cooperative session-owner checks.
- Added adversarial two-process lease races, competing stale-lock reclaim tests, fault injection, interrupted-process recovery tests, and MCP isolation/framing tests.

### Compatibility and limitations
- Node.js 20 or newer; MIT licensed; no third-party runtime dependencies or paid API requirements. `package.json` remains `"private": true` (GitHub source release only, no npm registry publication).
- Existing project schema versions `1.0` and `1.1` remain supported; no schema-major migration is required.
- File-scope leases are **cooperative**, not OS-level edit locks; they cannot stop an IDE or terminal from directly editing overlapping files. The session/tool labels are self-declared, not cryptographically authenticated.
- Recovery journals run when the next project-lock operation begins, not immediately after a crash; sudden power loss/kernel panic durability is not guaranteed without fsync-based storage semantics.
- MCP tools must be explicitly configured in a supported client. The repository does not run autonomous multi-agent orchestration or IDE coordination daemons.

### Verification before release
- PR #10 was reviewed and merged after six successful GitHub Actions PR jobs on its final feature head. The agent reported 77 passing local tests and eight benchmark scenarios on that head.
- The v0.5.0 release-preparation PR adds independent **fresh-checkout CLI installation and smoke testing** to the same six-job CI matrix. Final results and the exact final `main` commit must be checked before tagging or publishing.
- The completed one-time v0.4.0 publication workflow is retired, preventing redundant v0.4 publishing attempts after the version update.

## [0.4.0] — 2026-11-20

This release adds safer project onboarding, portable Agent Skills interoperability, and an evidence-backed skill improvement lifecycle. GitHub source release; npm registry publication is intentionally disabled by `"private": true` in `package.json`.

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
