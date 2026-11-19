# Agent Role Specifications

> **Status:** Documented only — Operational Agent Configurations and Subagent Runners are **NOT IMPLEMENTED** in Phase 1.

## Provider Configuration Independence Notice

These documents define provider-agnostic role boundaries, responsibilities, and handoff contracts for future phases.

**Do NOT assume Google Antigravity's agent configuration format is identical to Codex or Gemini CLI.** Future operational integration must translate these role specifications into each target runtime's native, verified configuration format (for example, Codex CLI profiles vs. Gemini CLI agent/instruction formats vs. Google Antigravity subagent definitions) without modifying or duplicating the shared Second Brain.

## Role Inventory

| Role ID (`assigned_role`) | Specification | Primary Responsibility |
| :--- | :--- | :--- |
| `orchestrator` | [orchestrator.md](./orchestrator.md) | Decomposes owner goals into bounded tasks, coordinates handoffs, and enforces approval gates |
| `researcher` | [researcher.md](./researcher.md) | Investigates documentation, codebases, and options; proposes `RES-NNNN` findings |
| `software-architect` | [software-architect.md](./software-architect.md) | Designs system architecture and drafts `ADR-NNNN` proposals for owner approval |
| `developer` | [developer.md](./developer.md) | Implements scoped `TASK-NNNN` deliverables and unit tests within approved architecture |
| `qa-security-reviewer` | [qa-security-reviewer.md](./qa-security-reviewer.md) | Executes independent verification, security checks, and `EVID-NNNN` evidence manifests |

## Shared Governance Policies

- [memory-policy.md](../policies/memory-policy.md) — Authority levels `A0`–`A6` and write ownership.
- [approval-boundaries.md](../policies/approval-boundaries.md) — Mandatory owner approval triggers (`APPR-NNNN`).
- [token-efficiency.md](../policies/token-efficiency.md) — Concurrency, retry, and budget targets.
