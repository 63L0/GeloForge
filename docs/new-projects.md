# Initializing New Projects

New projects are created from [templates/project-starter/](../templates/project-starter/README.md) using the zero-dependency Node.js bootstrap script [bootstrap-project.mjs](../scripts/bootstrap-project.mjs).

## 1. Prerequisites and Constraints

- Uses only built-in Node.js (`v24.21.0` verified) and Git (`2.54.0` verified when `--git` is passed).
- Makes **zero network calls** and installs **zero dependencies**.
- Does **not** generate application code (only the Second Brain, task queues, `.gitignore`, `README.md`, `AGENTS.md`, `GEMINI.md`, and empty `src/` + `tests/` directories).
- Never overwrites an existing target file or directory.

## 2. Command Syntax

Run from `C:\AI-Workspace\harness`:

```powershell
node scripts/bootstrap-project.mjs --name "<Project Name>" [options]
```

### Options

| Flag | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `--name` | **Yes** | — | Human-readable project name (3–80 chars; no path separators, `:`, or `..`) |
| `--slug` | No | Derived from `--name` | Lowercase URL/folder slug (`^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$`) |
| `--dest` | No | `C:\AI-Workspace\projects\<slug>` | Target directory (must not exist yet and must not target reserved workspace folders) |
| `--owner` | No | `"Project Owner"` | Owner name recorded in `brain/manifest.yaml` and `brain/state/current.yaml` |
| `--description` | No | Default summary | Concise project description written into `README.md` and `brain/manifest.yaml` |
| `--git` | No | `false` | Runs `git init -b main` inside the new project directory only when explicitly requested |
| `--dry-run` | No | `false` | Validates inputs/destination and previews planned files without writing anything |
| `--help`, `-h` | No | — | Prints CLI usage help |

## 3. Safety Checks Built Into the Bootstrapper

1. **Name & Slug Validation:** Rejects slugs outside `^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$`, Windows reserved filenames (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), path traversal (`..`), colons, and control characters.
2. **Destination Guard:** Rejects destinations equal to or inside `harness/`, `local-runtime/`, `worktrees/`, or a drive root (`C:\`), as well as invalid Windows path characters (`< > " | ? *`).
3. **Overwrite Protection:** Refuses to run if `--dest` already exists on disk (even as an empty directory) and writes every file with exclusive creation (`wx`), ensuring rerunning cannot silently clobber existing project memory.
4. **Approved Placeholder Allowlist:** Only `{{PROJECT_NAME}}`, `{{PROJECT_SLUG}}`, `{{PROJECT_ID}}`, `{{PROJECT_DESCRIPTION}}`, `{{PROJECT_OWNER}}`, `{{CREATED_AT}}`, `{{CREATED_DATE}}`, and `{{HARNESS_VERSION}}` are substituted; YAML values are escaped automatically.

## 4. Recommended Workflow

```powershell
# Step 1: Preview first
node scripts/bootstrap-project.mjs --name "My Project" --owner "Your Name" --dry-run

# Step 2: Generate with isolated project Git repository
node scripts/bootstrap-project.mjs --name "My Project" --owner "Your Name" --git
```

After initialization:
1. Review and author real requirements in `<project>\brain\requirements\prd.md` and `constraints.md` (they start as unapproved drafts).
2. Review `<project>\brain\manifest.yaml` and `<project>\brain\state\current.yaml`.
3. Create an initial local commit inside the new project repository when ready (no remote or push is performed automatically).
