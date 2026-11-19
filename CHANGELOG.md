# Changelog

All notable changes to the AI Development Harness foundation are recorded in this file.

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
