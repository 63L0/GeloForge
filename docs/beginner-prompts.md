# Beginner AI Prompts for GeloForge

If you are new to terminal workflows or don't want to memorize CLI commands, **copy and paste these prompts directly to your AI coding agent** (Cursor, Claude Code, Codex CLI, Gemini CLI, or Antigravity) inside your repository.

> GeloForge never auto-edits your application source code or auto-promotes unreviewed skills — each prompt keeps explicit dry-run, test-evidence, and human-review guardrails intact.

---

## 1. Set up GeloForge safely in this repo (First-time setup)

```text
Set up GeloForge in this repository safely.
1. First run `npx geloforge adopt --dry-run` and explain what files will be added without modifying my existing code.
2. Wait for me to confirm, then run `npx geloforge adopt`, `npx geloforge mcp init`, and `npx geloforge hooks init --dry-run` (explain what hooks would be added before applying).
3. Run `npx geloforge doctor` to check overall health, then run `npx geloforge skills suggest` to recommend matching skills and show any skill gaps.
4. Summarize everything in plain English and ask me what my first goal is. Do NOT edit my app code or auto-promote any skills.
```

---

## 2. Start a new feature or bug fix safely

```text
Let's work on this goal using GeloForge: "<DESCRIBE YOUR GOAL OR BUG HERE>"
1. Run `npx geloforge doctor --skip-mcp-check` to make sure project state is healthy.
2. Create and activate a scoped task (`npx geloforge task new --title "..." --activate`).
3. Run `npx geloforge skills suggest --task <TASK-ID> --goal "<DESCRIBE YOUR GOAL>"` to check relevant skills, then compile context (`npx geloforge context --task <TASK-ID> --map --skills`).
4. Tell me your implementation plan before editing files, and claim a task lease if other agents might edit concurrently.
```

---

## 3. Check if my setup is healthy (`doctor`)

```text
Run `npx geloforge doctor` in this project, explain any warnings or failures in plain English, and show me the exact fix commands before running anything destructive.
```

---

## 4. Prove my changes actually pass tests (`verify`)

```text
Before marking this task complete, run our real project tests using `npx geloforge verify --task <TASK-ID> -- <OUR_TEST_COMMAND>` (for example `npm test` or `node --test`). Show me the exact pass/fail output and evidence ID recorded. Do not mark the task done if checks fail.
```

---

## 5. Save my progress before closing this chat (`checkpoint`)

```text
Save our session progress using `npx geloforge checkpoint create --summary "..." --resume "..."` (and update the task or handoff if needed) so our next fresh chat can pick up immediately via `npx geloforge context --task <TASK-ID> --from-diff`.
```

---

## 6. Turn a working fix into a reusable quarantined skill

```text
Analyze our verified work with `npx geloforge skills suggest --scaffold-draft --dry-run` first and show me what skill draft it would stage under `proposals/skills/`. Wait for my confirmation before writing the quarantined draft, and do not promote it until I review and approve it.
```
