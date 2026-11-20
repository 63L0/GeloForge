# AGENTS.md — Project Agent Entrypoint

> **Configuration Notice:** Creating this file does **not** automatically configure Codex, Google Antigravity, or any autonomous subagent runtime. It is a concise, provider-independent entrypoint to shared project memory.

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
- **Prevent context rot:** Start focused tasks with `geloforge context --task TASK-NNNN --from-diff --map --profile quick`, mark finished tasks `done`, and save state with `geloforge checkpoint create` before switching sessions.
- **Coordinate across IDEs:** Claim a cooperative lease (`geloforge task claim --task TASK-NNNN --tool <ide> --role <role> --scopes "..."`) before concurrent editing, and release it when finished.
