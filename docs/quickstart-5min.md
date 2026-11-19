# GeloForge 5-Minute Quickstart

Start organizing project memory, scoped tasks, verified command evidence, compiled context packets, and clean cross-agent handoffs in an existing or new repository.

> **New to GeloForge?** You do **not** have to rewrite your project or adopt a complex multi-project workspace layout. Run these commands directly inside any existing repository.

---

## Prerequisites

- **Node.js `>= 20.0.0`** (zero external `npm install` packages required)
- **Git**

Make `geloforge` callable from anywhere on your machine (optional, once per clone):

```bash
git clone https://github.com/63L0/GeloForge.git
cd GeloForge
npm link
```

*(Without `npm link`, run `node /path/to/GeloForge/scripts/geloforge.mjs <command>` instead.)*

---

## Step 1: Adopt an Existing Repo (or Initialize a New One)

Inside your repository root:

```bash
cd /path/to/your-project

# Preview what will be added without writing anything
geloforge adopt --dry-run

# Add Second Brain (brain/ and tasks/) without modifying existing source files or README.md
geloforge adopt --profile web
```

- Already want a fresh project from scratch? Use `geloforge init --name "My App" --profile web --dest ../my-app --git`.
- Need custom folders? Pass `--tasks-dir ops-tasks --evidence-dir ops-evidence`.
- `geloforge adopt` never overwrites pre-existing files and preserves existing Git history and dirty worktrees.

---

## Step 2: Check Status & Create a Scoped Task

From the repository root **or any nested subdirectory** (`--project` is auto-detected up to your Git root):

```bash
geloforge status

# Create and activate TASK-0001 cleanly
geloforge task new --title "Add checkout validation" --input src/checkout.js --activate
```

---

## Step 3: Run a Real Check & Capture Evidence (`shell: false`)

Run your real build, linter, or test command after `--`:

```bash
geloforge evidence capture --task TASK-0001 --name "Checkout unit tests" -- node --test
```

> **Evidence Accuracy Boundary:**
> - `geloforge evidence capture` executes only the explicit command you pass after `--` with `shell: false` (never commands embedded in docs or prompts) and redacts detected secret tokens before saving.
> - An exit code of `0` records `result: "passed"` and `status: "verified"` **specifically proving command execution succeeded** — it does **not** prove application correctness, untested code paths, or broader unverified claims.
> - Non-zero exit codes, missing binaries, and timeouts are saved truthfully as `status: "draft"` (NOT verified) and excluded from handoff `verified_evidence`.

---

## Step 4: Compile Context + Codebase Map (+ Optional Portable Skills)

```bash
geloforge context --task TASK-0001 --map --profile quick

# Optional: include validated .agents/skills or global skills cleanly with Tier 0/1/2 disclosure
geloforge skills list
geloforge skills lint --strict
geloforge context --task TASK-0001 --map --skills
```

- Copies a trust-tiered prompt packet combining global `A0` safety rules, open conflicts, project state, `TASK-0001`, verified `EVID-0001`, a `.gitignore`-aware outline of relevant files, and (when `--skills` is passed) relevant non-authoritative `SKILL.md` workflows.
- Want strict trust isolation (exclude unverified `A5`–`A6` drafts & unverified skills)? Add `--exclude-unverified`.
- Learn more in the [Portable Skills Guide](./portable-skills.md).

---

## Step 5: Hand Off Between Sessions or AI Tools & Validate

```bash
# Create an auditable handoff packet separating verified EVID-* from unverified claims
geloforge handoff \
  --task TASK-0001 \
  --from-tool codex --to-tool gemini-cli \
  --completed "Implemented checkout validation" \
  --claim "Manual edge-case review looks complete" \
  --next-action "Inspect EVID-0001 and merge PR"

# Inspect a received handoff & verify whole Second Brain integrity
geloforge handoff --inspect handoffs/HANDOFF-0001-task-0001.yaml
geloforge validate
```

---

## Optional Multi-Project Workspace Layout

Prefer isolating multiple scaffolded apps next to a harness checkout? `geloforge init --name "My App"` without `--dest` defaults to `<workspace-root>/projects/<slug>` automatically. See [README.md](../README.md) and [docs/new-projects.md](./new-projects.md) for all flags.
