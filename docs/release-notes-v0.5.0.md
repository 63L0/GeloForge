# GeloForge v0.5.0 — Co-Pilot, Checkpoints & Multi-IDE Coordination

**Keep your AI coding sessions on track—without giving agents control over your project approvals.**

GeloForge is a local, provider-neutral Node.js command-line toolkit. This source release improves day-to-day AI-assisted development with actionable next steps, shorter context handoffs, and cooperative coordination between coding tools.

## What's new

- **Human-in-the-Loop Co-Pilot:** `geloforge status` and `geloforge recommend` show prioritized next actions, conflicts, and a pending human-approval inbox. Recommendations are advisory, never self-executing.
- **Finish tasks with evidence:** `geloforge task update|done` maintains operational state; `--require-evidence` can block completion unless a linked command check is verified. Completed work is not assumed to be verified.
- **Less context clutter:** `geloforge context --from-diff` focuses on current Git changes and prunes unrelated completed-task records by default. `--include-completed` restores historical items explicitly.
- **Session checkpoints:** `geloforge checkpoint create|list|show` stores schema-validated resume notes and next actions.
- **Cooperative multi-IDE work:** `geloforge task claim|release|leases` lets sessions advertise task ownership and file scopes; GeloForge reports overlapping claimed scopes before another agent starts.
- **Local MCP integration:** `geloforge mcp --project <your-project> --read-only` exposes scoped status, context, and recommendations to compatible MCP clients via stdio. An explicitly writable server can also perform bounded project-state mutations; privileged skill signing/promotion/rollback is never exposed over MCP.

## Quick start

**Requirements:** Node.js 20 or newer and Git.

```bash
git clone https://github.com/63L0/GeloForge.git
cd GeloForge
npm link
geloforge --version
```

Then, from an existing project directory:

```bash
geloforge adopt --dry-run
geloforge adopt
geloforge status
geloforge recommend
```

For an example workflow, create a scoped task and a checkpoint:

```bash
geloforge task new --title "Fix login validation" --activate
geloforge context --task TASK-0001 --from-diff --map
geloforge checkpoint create --summary "Login validation in progress"
```

Read the [5-minute quickstart](https://github.com/63L0/GeloForge/blob/main/docs/quickstart-5min.md) and [full CLI reference](https://github.com/63L0/GeloForge/blob/main/docs/advanced-usage.md).

## Reliability and safety boundaries

- Concurrent GeloForge state writes are serialized with a local project lock. A recovery journal helps restore interrupted multi-file updates on the **next locked operation**; this is not power-loss- or kernel-crash-durable ACID storage.
- Task leases do **not** lock source files at the OS level. A developer or AI IDE with direct filesystem access can edit outside GeloForge. Use separate Git worktrees for safer parallel edits.
- Tool names, roles, and session IDs in lease records are **self-declared labels**, not authenticated identities.
- MCP requires an intended project root. Use `--read-only` for integrations that need inspection only; review client-granted permissions before enabling writes.
- GeloForge is **not** an autonomous multi-agent runner, IDE plugin, LLM provider, or security sandbox. It does not automatically connect to Codex, Gemini, Claude, or Antigravity; compatible clients can consume its files and MCP tools after setup.
- Skill linting doesn't guarantee prompt-injection safety. Independent human approval requires separate key custody and/or protected GitHub review rules.

## Compatibility and verification

- MIT license, Node.js >=20, zero third-party runtime dependencies, no required paid API.
- Maintains project schema versions 1.0 and 1.1.
- CI tests the full unit/integration suite, deterministic benchmarks, and a **fresh-checkout CLI smoke test** across Ubuntu, macOS, and Windows with Node.js 20 and 22.
- `"private": true` remains in `package.json`. This is a **GitHub source release only**, not an npm registry package.

Detailed changes: [CHANGELOG.md](https://github.com/63L0/GeloForge/blob/main/CHANGELOG.md). Security disclosures: [SECURITY.md](https://github.com/63L0/GeloForge/blob/main/SECURITY.md) and [Known Limitations](https://github.com/63L0/GeloForge/blob/main/docs/known-limitations.md).
