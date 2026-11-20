# GeloForge

**Project memory and verification for AI-assisted development.**

GeloForge is a local CLI that stores decisions, scoped tasks, command results, and handoffs alongside your code.

[![CI on main](https://github.com/63L0/GeloForge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/63L0/GeloForge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/geloforge?label=npm)](https://www.npmjs.com/package/geloforge)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

![Two scripted MCP sessions demonstrating overlapping file leases, verified test evidence, and a signed skill approval.](./docs/media/geloforge-v06-demo.gif)

[Case study and reproduction steps](./docs/dogfooding-v06.md)

## Quick start

With Node.js 20+ and Git installed, run this from the root of an existing repository.

```bash
npx geloforge adopt --dry-run
npx geloforge adopt
npx geloforge status
```

The preview lists the files GeloForge would add. Adoption keeps existing project files intact. CI tests Node 20 and 22 on Linux, macOS, and Windows.

Run `npx geloforge mcp init` to configure Cursor, VS Code, Claude Code, and Gemini CLI for the project. Open the project in your client and review any MCP trust prompt.

[5-minute quickstart](./docs/quickstart-5min.md)

## Why GeloForge?

When work moves between people or coding agents, the repository carries the decisions, task scope, and last verified check. The next session can load those records as focused context. GeloForge uses local files and has zero third-party runtime dependencies.

## See it in action

```bash
npx geloforge task new --title "Check input validation" --activate
npx geloforge context --task TASK-0001 --map
npx geloforge verify --task TASK-0001 -- node --test
```

Use the task ID printed by `task new` and your project’s own test command. A passing `verify` records the command result, saves a checkpoint, and completes the task. Use `npx geloforge evidence capture --task TASK-0001 -- node --test` to record a check and keep a task open.

## What you can do

- **Coordinate changes.** Claim a file scope to catch overlapping leases between GeloForge clients before editing.
- **Resume or hand off work.** Save checkpoints and share open tasks, verified evidence, and next actions with the next session.
- **Reuse reviewed workflows.** Draft portable `SKILL.md` files from evidence, then use signed approvals to promote or roll back versions.

## How it fits your project

| Path | Contents |
| --- | --- |
| `brain/` | Decisions, constraints, architecture, and operational state |
| `tasks/` | Scoped task contracts |
| `evidence/` | Recorded command checks and their outcomes |
| `handoffs/` | Handoff and checkpoint records |
| `.agents/skills/` | Reviewed, reusable agent workflows |

## Documentation

- [CLI and MCP guide](./docs/advanced-usage.md)
- [Portable Agent Skills](./docs/portable-skills.md)
- [Creating a new project](./docs/new-projects.md)
- [Known limitations](./docs/known-limitations.md) and [security policy](./SECURITY.md)
- [Changelog](./CHANGELOG.md) and [GitHub releases](https://github.com/63L0/GeloForge/releases)

## Contributing

Report reproducible issues with your OS, Node version, and the command you ran. [Open an issue](https://github.com/63L0/GeloForge/issues)

For local setup and pull request checks, see the [contribution guide](./CONTRIBUTING.md).
