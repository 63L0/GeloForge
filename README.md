# GeloForge

**Stop re-explaining your codebase — give every AI coding agent a shared, proof-verified memory.**

Switch freely between **Cursor, Claude Code, VS Code, Codex CLI, Gemini CLI, and Antigravity** without losing architectural context, risking overlapping edits, or trusting hallucinated `"tests pass!"` claims. GeloForge is a local-first, **zero-dependency** CLI and MCP server that keeps project memory, scoped tasks, real test receipts, pinned MCP tools, and portable skills right inside your Git repo.

[![CI on main](https://github.com/63L0/GeloForge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/63L0/GeloForge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/geloforge?label=npm)](https://www.npmjs.com/package/geloforge)
[![Node 20+](https://img.shields.io/badge/node-20%2B-brightgreen)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)](./package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**Zero databases. Zero cloud lock-in. Zero external runtime packages.** Just plain Markdown, YAML, and JSON schemas checked into your repository.

![Two scripted MCP sessions demonstrating overlapping file leases, verified test evidence, and a signed skill approval.](https://raw.githubusercontent.com/63L0/GeloForge/main/docs/media/geloforge-v06-demo.gif)

*[Read the full multi-session case study & reproduction steps →](./docs/dogfooding-v06.md)*

---

## Why GeloForge?

Every time you open a fresh AI chat or jump from one coding tool to another, hard-won decisions vanish. GeloForge gives your whole stack one deterministic **Second Brain**:

| Without GeloForge | With GeloForge |
| --- | --- |
| Re-explaining specs, architecture, and bugs in every chat | **Contextual BM25 & 3-Zone Packets:** Deterministic context (`brain/` + 15-lang symbol map + skills) in seconds |
| Agents claiming *"fixed!"* without running tests | **Evidence-Gated Tasks:** Real exit-code receipts (`verify` / `evidence capture`) block fake completion |
| Two AI tools silently overwriting each other's files | **Cooperative Leases & Worktrees:** Scope claims flag collisions early; Git worktrees isolate parallel work |
| Surprise MCP tool changes or unreviewed agent habits | **Pinned MCP Tools & Signed Skills:** `mcp lock --check` detects schema drift; skills stay quarantined until approved |
| Guesswork setup and unnoticed config drift | **Skill Advisor, Doctor & Hooks:** Analyze goals for skills, check health in one command, and run opt-in guardrails |

---

## Quick start

**Prerequisites:** Node.js 20+ and Git installed (`npx geloforge` works immediately — no global install required).

### Option A — New to CLI? Paste this to your AI coding agent

Open **Cursor, Claude Code, Codex, Gemini CLI, or Antigravity** inside your project folder and paste:

```text
Set up GeloForge in this repository safely. First run `npx geloforge adopt --dry-run` and explain what files will be added without modifying my existing code. After I confirm, run `npx geloforge adopt`, `npx geloforge mcp init`, `npx geloforge hooks init --dry-run`, and `npx geloforge doctor`. Then run `npx geloforge skills suggest` to recommend matching skills and ask what my first goal is. Do NOT edit my app code or auto-promote skills.
```

> Want ready-to-paste prompts for tasks, tests, checkpoints, and skill drafting? See **[Beginner AI Prompts](./docs/beginner-prompts.md)**.

### Option B — Run the CLI yourself (30 seconds)

```bash
# 1. Preview safely without touching existing code
npx geloforge adopt --dry-run

# 2. Onboard your repo + run one-command health diagnostics
npx geloforge adopt
npx geloforge status
npx geloforge doctor

# 3. Connect AI editors (Cursor, VS Code, Claude Code, Gemini CLI, or --client antigravity)
npx geloforge mcp init

# 4. Preview optional ambient guardrails (Git pre-commit, Claude Stop, Gemini AfterAgent)
npx geloforge hooks init --dry-run
```

Starting from scratch instead? Scaffold an isolated project with one of 5 domain profiles (`web`, `desktop`, `mobile`, `automation`, `ai-system`):

```bash
npx geloforge init --name "My Web App" --profile web --git
```

> Guides: [5-minute quickstart](./docs/quickstart-5min.md) · [Creating a new project](./docs/new-projects.md)

---

## See it in action

Use one repeatable proof-backed workflow from goal discovery through verified completion:

```bash
# 1. Discover matching skills or stage a quarantined draft for your goal
npx geloforge skills suggest --goal "Harden checkout webhook validation"

# 2. Create a scoped task and compile a budget-aware context packet + symbol map
npx geloforge task new --title "Harden checkout webhook validation" --activate
npx geloforge context --task TASK-0001 --map --skills

# 3. Capture intermediate test receipts (without closing the task yet)
npx geloforge evidence capture --task TASK-0001 -- node --test

# 4. Verify & complete — fails closed as `draft` if tests fail; saves checkpoint on pass
npx geloforge verify --task TASK-0001 -- node --test
```

If any check fails or times out, GeloForge records `draft` evidence (never `verified`) and refuses to mark the task verified until real checks pass.

---

## What you can do

### Smart Memory & Token-Efficient Context
- **Contextual BM25 & 3-Zone Context Compiler:** `npx geloforge context` ranks Markdown headings and docs with zero-dependency BM25, anchors critical policies/conflicts at edge positions to fight context rot, and supports `quick`/`working`/`deep` budgets, `--from-diff`, `--exclude-unverified`, and opt-in `--cache`.
- **15+ Language Codebase Symbol Map:** Add `--map` to extract `.gitignore`-aware function/class outlines and 1-hop import boosts (JS/TS, Python, Go, Rust, Java, C#, Kotlin, C/C++, Shell, SQL, Markdown, JSON, YAML, TOML) while hard-blocking `.env*`, keys, binaries, and build folders.
- **Session Checkpoints & Verified Cross-Agent Handoffs:** Save `CHKPT-NNNN` resume notes (`checkpoint create|resume`) and inspect `HANDOFF-NNNN` packets (`handoff --inspect`) that separate audited `EVID-*` receipts from `unverified_claims` and flag Git HEAD drift.

### Verification, Security & Governance
- **Command-Backed Evidence & Secret Redaction:** `verify` and `evidence capture` spawn checks directly (`shell: false`), redact detected secrets, and let `task done --require-evidence` block unverified completion.
- **MCP Tool-Surface Pinning (`mcp lock`):** Snapshot configured stdio MCP server tool schemas to `.geloforge/mcp-lock.json` via canonical SHA-256 digests and run `npx geloforge mcp lock --check` to catch silent tool poisoning or schema drift.
- **Signed Governance & Zero-Network Reliability:** Gate ADR/constraint edits (`proposal preview|sign|promote`) and skill promotions on pinned Ed25519 keys, transactional rollback journals, cross-process `.state.lock` protection, zero external network calls, and offline regression evals (`npm run eval`).

### Skills, MCP & Multi-Agent Workflows
- **Project/Goal Skills Advisor (`skills suggest`):** Inspect project markers, active tasks, and `--goal` strings to recommend matching [agentskills.io](https://agentskills.io)-compatible `SKILL.md` workflows, stage quarantined drafts (`--scaffold-draft`), statically security-lint (`skills lint`), and promote/rollback safely (`skills promote|rollback`) with progressive Tier 0/1/2 token loading.
- **Zero-Dependency MCP Server (`geloforge mcp`):** 6 project-confined MCP tools (`geloforge_status`, `geloforge_recommend`, `geloforge_context`, `geloforge_task`, `geloforge_checkpoint`, `geloforge_skills`) with `--read-only` support, `input_examples`, and self-correcting error hints.
- **Bounded Coding Loops & Opt-In Staging Audits:** Run capped `implement → verify → review → fix` cycles (`loop run`) gated by fail-closed `policy_checks`, or automate staging error audits (`autonomous watch|learn`) with n8n failure delivery and multi-provider adapters (`codex`, `gemini`, `antigravity`).
- **Cooperative File Leases & Git Worktrees:** Claim scopes (`task claim --scope src/`) so parallel editors warn on overlapping work automatically, and manage isolated checkouts with `worktree add|remove`.

### Diagnostics & Ambient Guardrails
- **One-Command Diagnostics (`geloforge doctor`):** Audit Node version, Second Brain schemas (`12` strict JSON schemas), Git state, peer leases, skill lint, MCP lock drift, and hook status with actionable fix commands.
- **Opt-In Ambient Hooks (`geloforge hooks init`):** Add lightweight Git `pre-commit` validation/lock checks plus Claude Code (`hooks.Stop`) and Gemini CLI (`hooks.AfterAgent`) reminders while preserving existing settings — zero background daemons.
- **Human-in-the-Loop Co-Pilot (`geloforge recommend`):** Surface ranked next actions, pending skill drafts, open conflicts (`CONF-NNNN`), and active peer leases without auto-executing destructive edits.

---

## How it fits your project

Everything GeloForge creates lives in readable project folders — never modifying your application source code:

| Folder | Purpose |
| --- | --- |
| `brain/` | Source of truth: PRD, constraints, architecture decisions (`ADR-*`), and `state/current.yaml` |
| `tasks/` | Scoped `TASK-NNNN` contracts with objectives, file scope, and acceptance criteria |
| `evidence/` | Tamper-evident `EVID-NNNN` logs of real commands, exit codes, and redacted outputs |
| `handoffs/` | Recovery checkpoints (`CHKPT-NNNN`) and structured cross-agent `HANDOFF-NNNN` records |
| `.agents/skills/` | Reviewed reusable workflows unlocked on demand (`proposals/skills/` isolates unapproved drafts) |

---

## Documentation

- [Beginner AI prompts](./docs/beginner-prompts.md) — ready-to-paste prompts so any AI agent can run GeloForge for you
- [5-minute quickstart](./docs/quickstart-5min.md) — fastest hands-on CLI walkthrough
- [CLI and MCP guide](./docs/advanced-usage.md) — full command flags, `mcp lock`, `loop run`, worktrees, and staging audits
- [Portable Agent Skills](./docs/portable-skills.md) — progressive disclosure, static security lint, and Ed25519 promotion
- [Creating a new project](./docs/new-projects.md) — greenfield starter templates and 5 domain profiles
- [Known limitations](./docs/known-limitations.md) & [Security policy](./SECURITY.md) — trust boundaries and offline safety model
- [Changelog](./CHANGELOG.md) & [GitHub releases](https://github.com/63L0/GeloForge/releases)

## Contributing

Issues, bug reports, and pull requests are welcome! Share your OS, Node.js version, and command output via [GitHub Issues](https://github.com/63L0/GeloForge/issues). For local tests and PR checks, read [CONTRIBUTING.md](./CONTRIBUTING.md).
