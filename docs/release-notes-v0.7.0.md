# GeloForge v0.7.0

GeloForge can turn a saved n8n staging failure into a scoped audit with evidence and a next action. The worker can reuse completed audits and resume interrupted ones. Autonomous Mode starts off for each project.

- **Staging audits.** Deliver a saved execution from n8n, load project context and trusted skills, and run an approved Codex CLI, Gemini CLI, or Antigravity CLI review.
- **Bounded review.** Run one specialist or two specialists with an independent reviewer. The worker enforces launch and retry limits and saves progress in the project.
- **Evidence and approvals.** Draft skills from recurring verified failures. Promote requirements or ADRs using verified evidence and signed owner approval.
- **Local tools.** Resume local checkpoints, create separate Git worktrees, cache query context, and configure read-only MCP for Antigravity.

```bash
npx --yes geloforge@0.7.0 --version
npx --yes geloforge@0.7.0 autonomous status
```

The tests exercise simulated n8n deliveries and provider responses. A live staging deployment requires an authenticated provider CLI and access to saved execution records. See the [staging setup guide](./advanced-usage.md#autonomous-mode-staging-pilot) and [importable n8n workflow](../adapters/n8n/staging-audit-error-workflow.json).
