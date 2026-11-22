# AGENTS.md — Project Agent Entrypoint

> Use this guide in each connected coding assistant. Set up MCP clients separately with `geloforge mcp init --help`.

## Start Here (Do Not Duplicate the Second Brain)

Read shared project memory in priority order before proposing or implementing changes:

1. **Global Harness Policies (`A0`):** Refer to `<harness-root>/policies/approval-boundaries.md`, `memory-policy.md`, and `token-efficiency.md`.
2. **Project Navigation:** [brain/INDEX.md](./brain/INDEX.md) and [brain/manifest.yaml](./brain/manifest.yaml).
3. **Current Operational State:** [brain/state/current.yaml](./brain/state/current.yaml) (check `active_tasks`, `blocked_tasks`, `pending_approvals`, and `open_conflicts`).
4. **Authoritative Requirements (`A1`):** [brain/requirements/prd.md](./brain/requirements/prd.md) and [brain/requirements/constraints.md](./brain/requirements/constraints.md).
5. **Architecture (`A2`):** [brain/architecture/overview.md](./brain/architecture/overview.md) and accepted records in `brain/decisions/`.

## Governance Summary

- Never treat draft/template documents or `is_example: true` records as owner-approved authority.
- Never silently ignore contradicting evidence (`A3`/`A5`); log a `CONF-NNNN` conflict in `brain/conflicts/` or `proposals/`.
- Owner approval (`APPR-NNNN`) is required for requirement changes, architecture decisions, security boundaries, spend/paid APIs, and destructive or external mutations.
- Never commit secrets (`.env*`, keys, tokens) to this repository.

## Human-in-the-Loop Co-Pilot Protocol

- **Recommend, don't assume:** When multiple architectural or product approaches exist, present options + trade-offs and run `geloforge recommend` to check pending human approvals.
- **Load task context and skills:** Before auditing, debugging, or changing the project, call `geloforge_context` with `skills: true` and the task ID or a short query. If MCP is unavailable, use `geloforge context --query "<task description>" --skills --profile quick`, or pass `--task TASK-NNNN` in place of `--query`. Follow relevant skills from the returned context. If none match, continue with the project rules. In the handoff, record which skills you used or that none matched.
- **Prevent context rot:** Mark finished tasks `done` and save state with `geloforge checkpoint create` before switching sessions.
- **Coordinate across IDEs:** Claim a cooperative lease (`geloforge task claim --task TASK-NNNN --tool <ide> --session <id> --role <role> --scope "<path>"`) before concurrent editing, and release it when finished.
