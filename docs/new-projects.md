# Initializing New Projects

Projects are created from [templates/project-starter/](../templates/project-starter/README.md) with an optional overlay from [templates/profiles/](../templates/profiles/README.md) using [bootstrap-project.mjs](../scripts/bootstrap-project.mjs).

## 1. Command Syntax

Run from `<harness-root>`:

```powershell
node scripts/bootstrap-project.mjs --name "<Project Name>" [options]
```

| Flag | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `--name` | **Yes** | — | Display name (3–80 chars; Unicode and spaces supported; no `/`, `\`, `:`, `..`, or control chars) |
| `--slug` | No | Derived via NFKD normalization | Lowercase ASCII slug (`^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$`) |
| `--dest` | No | `<workspace-root>/projects/<slug>` | Target directory (must not already exist) |
| `--owner` | No | `"Project Owner"` | Owner recorded in `brain/manifest.yaml` and `brain/state/current.yaml` |
| `--description` | No | Starter summary | Short project description |
| `--profile` | No | None (base starter) | Optional overlay: `web`, `desktop`, `mobile`, `automation`, or `ai-system` |
| `--created-at` | No | Current UTC timestamp | Optional ISO-8601 timestamp for reproducible deterministic output |
| `--git` | No | `false` | Runs `git init -b main` locally inside the new project (never adds remotes or pushes) |
| `--dry-run` | No | `false` | Validates all inputs/paths and previews planned files without writing anything |

When running the npm-installed CLI, `geloforge init` with no `--dest` creates `./projects/<slug>` relative to your current directory.

## 2. Transactional Safety & Protections

1. **Path & Symlink Hardening ([path-safety.mjs](../core/path-safety.mjs)):** Blocks traversal (`..`), UNC/network paths, Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), trailing dots/spaces, filesystem roots, protected harness directories, and destinations traversing symbolic links or NTFS junctions.
2. **Overwrite Refusal:** Immediately refuses any existing file, symlink, or directory without modifying existing data.
3. **Single-Pass Placeholder Substitution:** Substitutes allowlisted `{{...}}` keys once so user values containing `{{...}}` cannot trigger secondary expansion.
4. **Atomic Staging & Validation:** Writes to a temporary sibling `.harness-stage-*` folder, optionally runs `git init -b main`, executes [validateProject](../core/project-validator.mjs), and atomically renames only upon success—rolling back cleanly on any failure.

## 3. Recommended Workflow

```powershell
# 1. Preview first
node scripts/bootstrap-project.mjs --name "My Web App" --profile web --owner "Your Name" --git --dry-run

# 2. Generate project
node scripts/bootstrap-project.mjs --name "My Web App" --profile web --owner "Your Name" --git

# 3. Verify generated Second Brain
node scripts/validate-project.mjs --project ../projects/my-web-app
```
