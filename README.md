# GeloForge

**Keep your AI coding work understandable, portable, and verifiable.**

[![CI](https://github.com/63L0/GeloForge/actions/workflows/ci.yml/badge.svg)](https://github.com/63L0/GeloForge/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/63L0/GeloForge?label=release)](https://github.com/63L0/GeloForge/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

![15-second GeloForge terminal replay showing MCP setup, an overlapping lease blocked, verified evidence, and a signed skill approval](./docs/media/geloforge-v06-demo.gif)

[Read and replay the GeloForge worktree case study](./docs/dogfooding-v06.md).

When an AI coding session ends, important decisions, unfinished work, and test results are easy to lose. **GeloForge keeps that knowledge in your repository**, not trapped inside one assistant's chat.

It's a small, open-source **command-line toolkit** for project memory, task tracking, verified command results, reusable agent skills, and handoffs between coding assistants. Built with Node.js, with **no paid API, hosted service, or third-party runtime dependencies**.

**[Get started](#quick-start)** · **[See a workflow](#see-it-in-action)** · **[Read the docs](#documentation)** · **[Contribute](#contributing)**

> **What GeloForge is not:** An AI model, autonomous coding agent, or automatic connection to your IDE. It prepares and validates files that you and your preferred AI coding tools can use.

## Why GeloForge?

| Without a shared record | With GeloForge |
| --- | --- |
| A new chat has to relearn the project. | Build a focused context packet from project files. |
| "Tests passed" is just something an agent said. | Capture the actual command, exit status, and evidence. |
| Switching coding assistants loses the thread. | Hand over the task, verified results, and next actions. |
| Useful fixes stay buried in old conversations. | Draft portable `SKILL.md` workflows, review them, and reuse them. |

You stay in control of changes and approvals. GeloForge helps organize the work; it does **not** silently run or authorize AI-generated instructions.

## Quick start

**Requires:** Node.js **20+** and Git. Works on Windows, macOS, and Linux.

Once v0.6 is available on npm, run these commands inside your existing project:

```bash
npx geloforge adopt --dry-run
npx geloforge adopt
npx geloforge status
```

For the current GitHub release, clone GeloForge and link the CLI:

```bash
git clone https://github.com/63L0/GeloForge.git
cd GeloForge
npm link
geloforge --version
```

Then go to **your existing project**:

```bash
cd /path/to/your-project
geloforge adopt --dry-run   # Preview changes first
geloforge adopt             # Add project memory without overwriting your code
geloforge status
```

That's it. Your project now has its own file-based starting point. GeloForge's CLI works from the project root or a nested directory.

You can also run `node scripts/geloforge.mjs --help` from the GeloForge checkout, or invoke the script by its full path from any directory.

[Follow the 5-minute walkthrough →](./docs/quickstart-5min.md)

## See it in action

Here's a typical workflow after adopting a project:

```bash
# 1. Give the next coding session a clear task.
geloforge task new --title "Fix login validation" --activate

# 2. Build a focused packet with relevant files and reusable skills.
geloforge context --task TASK-0001 --map --skills

# 3. Run your check, save a checkpoint, and complete the task if it passes.
geloforge verify -- node --test
```

Replace `node --test` with your project's test command. To record a check while keeping a task open, run `geloforge evidence capture --task TASK-0001 -- node --test`.

When you're done, use `geloforge handoff` to record what changed, what was verified, and what the next developer or assistant should do. [See the handoff examples →](./docs/advanced-usage.md)

## What you can do

| Capability | What it means for you |
| --- | --- |
| **Project memory** | Keep decisions, requirements, and current state in Markdown/YAML inside your repository. |
| **Safe onboarding** | Add GeloForge to an existing codebase with `adopt` or scaffold a new one with `init`. |
| **Tasks + evidence** | Create scoped tasks and capture real command results instead of relying on AI claims. |
| **Context + code map** | Send a smaller, more relevant project summary to your chosen AI assistant. |
| **Cross-agent handoff** | Pass structured, checkable work between sessions or tools. |
| **Portable Agent Skills** | Use open-format `SKILL.md` packages, with validation and progressive loading. |
| **Reviewed skill improvements** | Draft improvements from evidence, require explicit authorization, track versions, and roll back. |
| **Co-Pilot & checkpoints** | Get ranked next steps, human approval reminders, and resumable session notes. |
| **Cooperative multi-IDE work** | Claim tasks and scopes, see peer collision warnings, and avoid accidental overlapping work. |
| **Local MCP interface** | Run `geloforge mcp init` to set up Cursor, VS Code, Claude Code, or Gemini CLI with project-scoped tools. |

**Compatible workflow:** Codex, Claude Code, Gemini CLI, Antigravity, or any assistant that can read text you provide. GeloForge does not automatically operate or connect to those tools.

## How it fits your project

GeloForge stores its records **alongside your code**, so you can inspect, version, and share them through Git:

```text
your-project/
├── brain/                # Decisions, constraints, and project state
├── tasks/                # What needs to be done
├── evidence/             # Recorded checks (created when needed)
├── handoffs/             # Session/agent transfers (created when needed)
└── .agents/skills/       # Optional reusable SKILL.md packages
```

You can use one AI assistant or switch between several. **No new backend, database, or model subscription is required.**

## Documentation

| Start here | For |
| --- | --- |
| [5-minute quickstart](./docs/quickstart-5min.md) | Your first working project |
| [Detailed CLI & technical guide](./docs/advanced-usage.md) | Every major workflow and command |
| [Portable Skills guide](./docs/portable-skills.md) | `SKILL.md`, validation, approvals, and rollback |
| [Creating a new project](./docs/new-projects.md) | Profiles and project scaffolding |
| [Known limitations](./docs/known-limitations.md) | What is and is not guaranteed |
| [Security policy](./SECURITY.md) | Risks, trust boundaries, and reporting |
| [Changelog](./CHANGELOG.md) | What's changed in each release |

**Security note:** A local AI agent with unrestricted filesystem access can still bypass local file-level controls. Signing a skill does not prove an *independent human* approved it unless keys and enforcement are outside that agent's control. Skills linting is not a sandbox.

## Contributing

GeloForge is **MIT-licensed** and built to be useful beyond one person's workflow.

Have an idea, find a confusing command, or hit a bug? [Open an issue](https://github.com/63L0/GeloForge/issues) or read [CONTRIBUTING.md](./CONTRIBUTING.md) to submit a pull request.

If this helps your AI-assisted development workflow, consider **[starring the repository](https://github.com/63L0/GeloForge)** so you can find it again.

**Latest published release:** [GitHub Releases](https://github.com/63L0/GeloForge/releases/latest) · [MIT License](./LICENSE)
