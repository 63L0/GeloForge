# GeloForge v0.6.0

This release makes it easier to adopt GeloForge, connect an MCP client, and finish a coding task with command-backed evidence.

- **Package distribution.** The release includes the tested `geloforge-0.6.0.tgz` archive with zero third-party runtime dependencies. Node.js 20 or newer and Git are supported.
- **One-command MCP setup.** `geloforge mcp init` adds project settings and workflow instructions for Cursor, VS Code, Claude Code, and Gemini CLI. It preserves unrelated server entries and supports a preview and read-only mode.
- **One-command verification.** `geloforge verify -- node --test` runs the check, records verified evidence and a checkpoint, and completes the task when the check passes. Failed checks leave a draft result and an open task.
- **Worktree case study.** The README replay draws on two scripted MCP sessions in the GeloForge repository. It shows a refused overlapping lease, verified evidence, and a skill approval signed with a disposable key.

Try the GitHub release archive without cloning from inside your project.

```bash
npm exec --yes --package=https://github.com/63L0/GeloForge/releases/download/v0.6.0/geloforge-0.6.0.tgz -- geloforge adopt --dry-run
```

The [quickstart](./quickstart-5min.md) covers adoption, context, and task verification. Existing project schema versions `1.0` and `1.1` are supported.
