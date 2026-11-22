# Harness Roadmap and Implementation Status

The source checkout includes the staging audit worker, approved proposal promotion, checkpoint recovery, worktrees, and the provider adapters below. The staging audit pilot has been exercised with simulated executions and provider responses. VPS delivery and authenticated provider runs are deployment checks.

## Event-Triggered Staging Audits

An [n8n Error Trigger workflow](../adapters/n8n/staging-audit-error-workflow.json) can deliver the saved failure's workflow ID, execution ID, revision and node trace to a local inbox. The [staging worker](./advanced-usage.md#autonomous-mode-staging-pilot) picks up deliveries while Autonomous Mode is on. It compiles project context with matching trusted skills, tracks runs and timeouts, and resumes from saved specialist results.

One task is assigned per workflow and execution. Verified reports link to evidence and a checkpoint. Missing execution data blocks the audit with a next action. Re-delivery can supply the missing record. Use the existing `geloforge verify --task TASK-NNNN -- <test-command>` command for a separate repair task.

## Learnings from Completed Audits

`geloforge autonomous learn` groups matching failed-node observations across distinct, verified executions. It can draft or propose a skill update for a recurring pattern. Skill activation uses the existing review and signing workflow.

## Context Cache, Canonical Promotion, and Recovery

- `geloforge context --query "..." --cache` uses a per-project disk cache. The three-project benchmark exercises isolation and invalidation on edits, additions, and removals.
- `geloforge proposal preview|sign|promote` binds a requirements update or new ADR to verified evidence, exact document bytes, and a signed owner approval.
- `geloforge checkpoint create --local` and `checkpoint resume` keep machine-local recovery instructions under `local-runtime/checkpoints/`. Audit steps use the same runtime directory.
- `geloforge worktree add|list|remove` manages isolated checkouts under the selected workspace's `worktrees/`.
- `geloforge mcp lock [--check]` pins configured stdio MCP servers' canonical JSON-RPC tool definitions to `.geloforge/mcp-lock.json` and detects tool-surface drift.
- `geloforge loop run --config <relpath> [--task TASK-NNNN]` and `geloforge loop status` run a bounded `implement -> verify -> review -> fix` loop gated by deterministic command verification (`captureEvidence`) and completion checkpoints.

## Provider Adapters and Evaluation

[Codex CLI, Gemini CLI and Antigravity CLI](../adapters/README.md) receive scoped audit packets from the same project memory. Interactive clients can use the same project through GeloForge MCP. Reusable project skills live under `.agents/skills/`.

The parallel [staging evaluation](../evaluations/staging-audits.json) runs two specialists for inquiry routing and quotation handoff, then a separate reviewer. The worker enforces at most two concurrent specialists and two report repair retries per audit. The signed approval also caps launches across audits. Run `npm run benchmark:audits` to compare the single and parallel paths against the expected observations. Run `npm run benchmark:cache` to check cache invalidation across projects.
