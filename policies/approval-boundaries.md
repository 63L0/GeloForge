# Security and Approval Boundaries Policy

> **Status:** Documented only — Automated runtime approval gates and filesystem permission enforcement are **NOT IMPLEMENTED** in Phase 1.
> All Phase 1 compliance relies on operator discipline and explicit validation rules.

## Authority Level `A0` — Global Harness Security Rules

`A0` rules sit at the top of the knowledge authority hierarchy and apply to every workspace, project, role, and future provider integration:

1. **No Committed Secrets:** Never write or commit `.env` files, API keys, OAuth tokens, private keys (`*.pem`, `*.key`, `*.p12`, `*.pfx`), passwords, or credentials into `harness/` or any `projects/*` Git repository.
2. **No Automatic Remote Creation or Push:** Never create remote repositories, add Git remotes autonomously, or push branches without explicit owner instruction (`external_mutation`).
3. **No Global Git or OS Security Modifications:** Never modify global Git configuration (`git config --global`), Windows Registry security policies, Defender/firewall rules, or system ACLs.
4. **No Unapproved Tool or Extension Installs:** Never install third-party packages, global CLIs, editor extensions, or MCP servers automatically without explicit owner request/approval.
5. **No Automatic Paid APIs or Spending:** Never activate metered paid APIs, cloud billing, or external commercial services autonomously.
6. **No Destructive Overwrites:** Never overwrite existing repositories, project directories, authoritative `L1` records, or unrelated user changes without explicit authorization.
7. **No Bypassing Controls:** Never bypass permission checks, authentication prompts, CAPTCHAs, or sandbox boundaries.
8. **Honest Reporting:** Never claim unexecuted tests passed, never promote example records as real evidence, and never label documentation-only controls as runtime-enforced.

## Approval Boundary Matrix

Actions crossing trust, cost, requirement, architecture, or destructive boundaries require an explicit owner decision logged using [approval-record.schema.json](../schemas/approval-record.schema.json) (`APPR-NNNN`):

| `boundary_category` | Triggering Actions | Required Approver | Phase 1 Status |
| :--- | :--- | :--- | :--- |
| `requirements_change` | Creating or modifying `brain/requirements/prd.md` or `constraints.md` beyond initial draft | Project Owner | **Documented only** |
| `architecture_change` | Accepting, deprecating, or superseding an `ADR-NNNN` in `brain/decisions/` | Project Owner | **Documented only** |
| `security_boundary` | Modifying `A0` policies, auth flows, secret handling, or harness schemas/validators | Project Owner | **Documented only** |
| `spend_or_paid_api` | Enabling paid APIs, cloud resources, or metered external services | Project Owner | **Documented only** |
| `external_mutation` | Creating Git remotes, pushing code, opening external PRs/issues, external webhooks | Project Owner | **Documented only** |
| `destructive_action` | Deleting project data, force-pushing, resetting uncommitted work, overwriting files | Project Owner | **Documented only** |
| `policy_exception` | Temporarily waiving a harness policy (must set `expires_at` and `conditions`) | Project Owner | **Documented only** |

## Non-Bypassable Context Rule

Every future compiled Layer 4 context packet must retain relevant `A0` security rules regardless of token budget pressure. See [context-compiler-spec.md](../context/context-compiler-spec.md).

## Related Policies and Schemas

- Approval record schema: [approval-record.schema.json](../schemas/approval-record.schema.json)
- Approval record template: [approval-record-template.yaml](../contracts/approval-record-template.yaml)
- Memory authority and write ownership: [memory-policy.md](./memory-policy.md)
- Token and spend controls: [token-efficiency.md](./token-efficiency.md)
