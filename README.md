# GeloForge

**Give your AI coding agents a shared memory — and make them prove their work.**

Switch freely between **Cursor, VS Code, Claude Code, Codex CLI, Gemini CLI, and Antigravity** without re-explaining your codebase or trusting unverified `"tests pass"` claims. GeloForge is a local-first, **zero-dependency** CLI + MCP server that stores decisions, scoped tasks, real command evidence, and clean handoffs right inside your repo.

[![CI on main](https://github.com/63L0/GeloForge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/63L0/GeloForge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/geloforge?label=npm)](https://www.npmjs.com/package/geloforge)
[![Node 20+](https://img.shields.io/badge/node-20%2B-brightgreen)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)](./package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

![Two scripted MCP sessions demonstrating overlapping file leases, verified test evidence, and a signed skill approval.](./docs/media/geloforge-v06-demo.gif)

*[Read the full multi-session case study & reproduction steps →](./docs/dogfooding-v06.md)*

---

## Why GeloForge?

When you start a fresh AI chat or switch tools, yesterday’s context disappears. **GeloForge fixes that with plain Markdown/YAML files in your repo** — zero databases, zero cloud lock-in, and zero third-party runtime packages.

| Without GeloForge | With GeloForge |
| --- | --- |
| Re-explaining architecture & constraints in every new chat | **Compiled Context:** One deterministic packet (`brain/` + codebase map + skills) in seconds |
| Agents claiming *"fixed!"* without running tests | **Verified Evidence:** Real exit-code command checks (`verify` / `evidence capture`) gate task completion |
| Two AI tools overwriting each other's files | **Cooperative Leases:** Scope locks flag overlapping edits before files collide |
| Surprise MCP tool changes or unreviewed agent habits | **Pinned Tools & Signed Skills:** `mcp lock --check` catches tool drift; skills require owner approval |

---

## Quick start

**Prerequisites:** Node.js 20+ and Git installed. Run these three commands from the root of any existing project:

```bash
# 1. Preview what files will be added (touches nothing)
npx geloforge adopt --dry-run

# 2. Add GeloForge Second Brain alongside your code (safe on existing repos)
npx geloforge adopt

# 3. Check project health and next recommended step
npx geloforge status
```

**Connect your AI editor in one command:**

```bash
npx geloforge mcp init
```

This configures **Cursor, VS Code, Claude Code, and Gemini CLI** (add `--client antigravity` for Antigravity) to talk to GeloForge's local MCP server. Open your project, approve the folder's MCP prompt, and your agents can read tasks, context, and evidence automatically.

> Starting a brand-new project instead? See [Creating a new project](./docs/new-projects.md) or try the [5-minute quickstart](./docs/quickstart-5min.md).

---

## See it in action

Here is the everyday 3-step loop — create a scoped task, hand your AI focused context, and require a passing test before marking it done:

```bash
# 1. Define what you're working on and activate it
npx geloforge task new --title "Check input validation" --activate

# 2. Build a compact, budget-aware context packet (with symbol map)
npx geloforge context --task TASK-0001 --map

# 3. Run your test suite — saves verified evidence + checkpoint, then completes the task
npx geloforge verify --task TASK-0001 -- node --test
```

Want to record an intermediate check *without* closing the task yet? Run:

```bash
npx geloforge evidence capture --task TASK-0001 -- node --test
```

If a check fails or times out, GeloForge marks the evidence as `draft` (never `verified`) and keeps the task open until the real test passes.

---

## What you can do

- **Coordinate across AI tools** — Claim a file scope (`task claim --scope src/`) so parallel Cursor, Codex, or Claude sessions warn each other before editing the same files.
- **Pause and resume without losing context** — Save lightweight checkpoints (`checkpoint create`) or structured handoffs (`handoff`) carrying exact evidence IDs and next actions.
- **Pin MCP tool definitions** — Lock configured stdio MCP servers to `.geloforge/mcp-lock.json` and run `npx geloforge mcp lock --check` to catch added, removed, or silently altered tool schemas.
- **Run bounded coding loops** — Use `npx geloforge loop run --config <file>` for a capped `implement → verify → review → fix` cycle where failing tests always block completion.
- **Turn winning fixes into reusable skills** — Draft portable `.agents/skills/*/SKILL.md` playbooks from verified evidence and promote updates only after strict linting and cryptographic Ed25519 approval.
- **Isolate parallel work cleanly** — Manage clean-checked Git worktrees under `worktrees/` with `npx geloforge worktree add`.

---

## How it fits your project

Everything GeloForge adds lives in clear, human-readable folders — never touching your existing source code:

| Folder | What lives here (in plain English) |
| --- | --- |
| `brain/` | Your project's source of truth: architecture, constraints, decisions, and `current.yaml` state |
| `tasks/` | Scoped `TASK-NNNN` contracts with clear objectives, file scope, and acceptance criteria |
| `evidence/` | Tamper-evident `EVID-NNNN` logs of actual commands, exit codes, and outputs |
| `handoffs/` | Recovery checkpoints (`CHKPT-NNNN`) and cross-agent `HANDOFF-NNNN` notes |
| `.agents/skills/` | Reviewed, reusable agent workflows unlocked on demand to save tokens |

---

## Documentation

- [5-minute quickstart](./docs/quickstart-5min.md) — fastest hands-on walkthrough for beginners
- [CLI and MCP guide](./docs/advanced-usage.md) — full command reference, MCP init/lock, worktrees, and coding loops
- [Portable Agent Skills](./docs/portable-skills.md) — progressive disclosure, linting, and Ed25519 skill promotion
- [Creating a new project](./docs/new-projects.md) — templates and domain profiles (`web`, `automation`, `desktop`, etc.)
- [Known limitations](./docs/known-limitations.md) & [Security policy](./SECURITY.md) — threat model, zero-network guarantees, and secret redaction
- [Changelog](./CHANGELOG.md) & [GitHub releases](https://github.com/63L0/GeloForge/releases)

## Contributing

Issues, bug reports, and pull requests are welcome! When reporting an issue, please share your OS, Node.js version, and the exact command you ran via [GitHub Issues](https://github.com/63L0/GeloForge/issues).

For local test setup and pull request checks, read the [contribution guide](./CONTRIBUTING.md).
