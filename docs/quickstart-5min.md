# GeloForge 5-Minute Quickstart

Adopt an existing repository, create a scoped task, and hand it off with command-backed evidence.

---

## Prerequisites

- **Node.js 20+**
- **Git**

The examples use `npx` to run the published package directly from npm.

---

## Step 1: Adopt an Existing Repo (or Initialize a New One)

Inside your repository root:

```bash
cd /path/to/your-project

# Preview what will be added without writing anything
npx geloforge adopt --dry-run

# Add Second Brain (brain/ and tasks/) without modifying existing source files or README.md
npx geloforge adopt --profile web
```

- To start a new project, run `npx geloforge init --name "My App" --profile web --dest ./my-app --git` from its parent directory.
- Need custom folders? Pass `--tasks-dir ops-tasks --evidence-dir ops-evidence`.
- `geloforge adopt` never overwrites pre-existing files and preserves existing Git history and dirty worktrees.

---

## Step 2: Check Status & Create a Scoped Task

From the repository root **or any nested subdirectory** (`--project` is auto-detected up to your Git root):

```bash
npx geloforge status

# Create and activate TASK-0001 cleanly
npx geloforge task new --title "Add checkout validation" --input src/checkout.js --activate
```

---

## Step 3: Compile Context + Codebase Map (+ Optional Portable Skills)

```bash
npx geloforge context --task TASK-0001 --map --profile quick

# Optional: include validated .agents/skills or global skills cleanly with Tier 0/1/2 disclosure
npx geloforge skills list
npx geloforge skills lint --strict
npx geloforge context --task TASK-0001 --map --skills
```

- The context packet includes project rules, current state, task scope, linked evidence when available, and a Git-aware code outline. Add `--skills` to include relevant `SKILL.md` workflows.
- Want strict trust isolation (exclude unverified `A5`–`A6` drafts & unverified skills)? Add `--exclude-unverified`.
- Learn more in the [Portable Skills Guide](./portable-skills.md).

---

## Step 4: Verify and Finish the Task

Run your project's build, linter, or test command after `--`.

```bash
npx geloforge verify -- node --test
```

`verify` uses the sole active task or a task selected with `--task TASK-0001`. A passing check records verified evidence, saves a checkpoint, and completes the task. A failing check records draft evidence, exits with a failure, and leaves the task open for another run. Use `evidence capture` when you want to record a check while keeping the task open.

> **Evidence Accuracy Boundary:**
> - `geloforge evidence capture` executes only the explicit command you pass after `--` with `shell: false` (never commands embedded in docs or prompts) and redacts detected secret tokens before saving.
> - An exit code of `0` records `result: "passed"` and `status: "verified"` **specifically proving command execution succeeded** — it does **not** prove application correctness, untested code paths, or broader unverified claims.
> - Non-zero exit codes, missing binaries, and timeouts are saved truthfully as `status: "draft"` (NOT verified) and excluded from handoff `verified_evidence`.

---

## Step 5: Hand Off Between Sessions or AI Tools & Validate

```bash
# Create an auditable handoff packet separating verified EVID-* from unverified claims
npx geloforge handoff \
  --task TASK-0001 \
  --from-tool codex --to-tool gemini-cli \
  --completed "Implemented checkout validation" \
  --claim "Manual edge-case review looks complete" \
  --next-action "Inspect EVID-0001 and merge PR"

# Inspect a received handoff & verify whole Second Brain integrity
npx geloforge handoff --inspect handoffs/HANDOFF-0001-task-0001.yaml
npx geloforge validate
```

---

## Optional Multi-Project Workspace Layout

The npm CLI defaults to `./projects/<slug>` when you run `npx geloforge init --name "My App"` without `--dest`. [Project setup options](./new-projects.md)
