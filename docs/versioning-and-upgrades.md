# Versioning, Compatibility, and Upgrades

## 1. Version Identifiers

The foundation tracks four distinct version axes rather than relying on a single ambiguous number:

| Axis | Location | Current Value | Purpose |
| :--- | :--- | :--- | :--- |
| **Harness Version** | [VERSION](../VERSION), [package.json](../package.json), [compatibility.json](../core/compatibility.json) | `0.2.0` | Tracks harness tooling, validator, and policy releases |
| **Template Version** | [compatibility.json](../core/compatibility.json), project `brain/manifest.yaml` | `1.0.0` | Tracks the structural layout of `templates/project-starter/` |
| **Schema Version** | Every record's `schema_version` (`1.0`, `1.1`) | `1.1` (default) | Tracks machine-validated YAML/JSON contract structure |
| **Profile Version** | `templates/profiles/<name>/profile.json`, project `brain/manifest.yaml` | `1.0.0` | Tracks optional domain overlay (`web`, `desktop`, etc.) |

## 2. Automated Compatibility Checking

[compatibility.mjs](../core/compatibility.mjs) evaluates project manifests (`checkManifestCompatibility`) and individual Second Brain records (`checkRecordSchemaVersion`) against [compatibility.json](../core/compatibility.json):

- **Current (`1.1`):** Verifies `schema_version` is supported, `template_version` major matches `supported_template_major` (`1`), and any declared `profile` matches a known profile with `supported_profile_major` (`1`).
- **Legacy Compatible (`1.0`):** Phase 1 initial manifests using `schema_version: "1.0"` remain readable and pass validation with a non-fatal warning (`compatible_upgrade_available`).
- **Incompatible:** Unknown schema versions (for example `"2.0"`), mismatched template major versions (`"2.0.0"`), or mismatched profile major versions fail validation immediately.

## 3. Safe Upgrade Procedure

1. **Before Updating Harness:** Ensure `<harness-root>` has a clean working tree (`git status`) and tests pass (`npm test`).
2. **After Updating Harness:** Run `npm test` inside `<harness-root>` before creating or validating projects.
3. **Check Existing Projects:** Run `node scripts/validate-project.mjs --project <project-path>` against each existing project repository.
4. **Upgrade a `1.0` Manifest to `1.1` (Additive Only):**
   - Set `schema_version: "1.1"`, add `template_version: "1.0.0"`, `profile: null`, `profile_version: null`, and update `harness_version`.
   - Never silently rewrite accepted `ADR-*` history or `A1` requirements during an automated upgrade.

## 4. Migration Planning Policy

- Additive optional fields bump minor schema/template versions and keep backward compatibility with prior minor versions.
- Breaking changes (removing required fields or changing ID formats) require incrementing major version numbers, keeping explicit upgrade guidance, and adding fixture compatibility tests in `tests/compatibility.test.mjs` before release.
- Avoid building speculative migration engines ahead of real breaking schema changes.

## 5. Rollback and Error Recovery

- **Harness Rollback:** Because `<harness-root>` is an isolated Git repository, revert unwanted changes locally using `git revert <commit>` or check out a known commit (`git log --oneline`) without touching `projects/` or `local-runtime/`.
- **Bootstrap Failure Recovery:** `bootstrap-project.mjs` writes to a temporary sibling `.harness-stage-*` folder, runs `validateProject()`, and atomically renames only upon success. Any error cleans up staging and leaves any pre-existing target directory untouched.
- **Runtime Checkpoints:** Automated `CHKPT-NNNN` checkpoint recovery for live agent tasks is **NOT IMPLEMENTED** in Phase 1.
