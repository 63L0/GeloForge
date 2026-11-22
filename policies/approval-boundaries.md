# Security and Approval Boundaries Policy

> **Enforcement scope:** GeloForge enforces the CLI checks listed below. OS permissions and provider sandbox settings govern other processes and their access.

## Technically Enforced Controls vs. Documented-Only Safeguards

| Control | Status | Mechanism / Scope |
| :--- | :--- | :--- |
| Traversal, UNC, Windows reserved names, trailing dot/space refusal | **Technically enforced** | [core/path-safety.mjs](../core/path-safety.mjs) |
| Symbolic link / NTFS junction ancestor refusal | **Technically enforced** | [core/path-safety.mjs](../core/path-safety.mjs) (`lstatSync` + `realpathSync`) |
| Overwrite refusal & transactional staging rollback | **Technically enforced** | [scripts/bootstrap-project.mjs](../scripts/bootstrap-project.mjs) |
| Single-pass placeholder substitution (no double-interpolation) | **Technically enforced** | [scripts/bootstrap-project.mjs](../scripts/bootstrap-project.mjs) |
| Secret & `.env` `.gitignore` rules + zero-network tooling | **Technically enforced** | [.gitignore](../.gitignore), verified by `tests/security.test.mjs` |
| `APPR-NNNN` owner approval gates | **Technically enforced for signed operations** | Canonical promotion and staging worker launches verify an owner key. See [setup](../docs/advanced-usage.md). |
| Specialist and retry limits | **Technically enforced for staging audits** | Up to two concurrent specialists and two report repair retries per task. Owner approval caps provider launches. |

## Authority Level `A0` — Global Harness Security Rules

1. **No Committed Secrets:** Never write or commit `.env*`, API keys, tokens, or private keys (`*.pem`, `*.key`, `*.p12`, `*.pfx`) into any Git repository.
2. **No Automatic Remote Creation or Push:** Never create remotes or push code without explicit owner instruction.
3. **No Global Git or OS Security Modifications:** Never modify `git config --global`, Windows security policies, or system ACLs.
4. **No Unapproved Tool or Dependency Installs:** Never install packages or extensions without explicit owner approval.
5. **No Automatic Paid APIs or Spending:** Never activate metered paid APIs or cloud billing autonomously.
6. **No Destructive Overwrites:** Never overwrite existing projects, canonical `L1` records, or unrelated files without authorization.
7. **No Bypassing Controls:** Never defeat permission checks, authentication prompts, or safety boundaries.
8. **Honest Reporting:** Never fabricate test evidence, promote example records (`is_example: true`), or claim unimplemented safeguards are enforced.

## Approval Boundary Matrix (`APPR-NNNN`)

Actions crossing trust, cost, requirement, architecture, or destructive boundaries require an explicit owner decision recorded with [approval-record.schema.json](../schemas/approval-record.schema.json):

| `boundary_category` | Triggering Actions | Required Approver |
| :--- | :--- | :--- |
| `requirements_change` | Creating/modifying canonical `brain/requirements/prd.md` or `constraints.md` | Project Owner |
| `architecture_change` | Accepting, deprecating, or superseding an `ADR-NNNN` in `brain/decisions/` | Project Owner |
| `security_boundary` | Modifying `A0` policies, auth flows, secret handling, or core validators | Project Owner |
| `spend_or_paid_api` | Enabling paid APIs, cloud resources, or metered external services | Project Owner |
| `external_mutation` | Creating Git remotes, pushing code, opening external PRs/issues | Project Owner |
| `destructive_action` | Deleting project data, force-pushing, resetting uncommitted work | Project Owner |
| `policy_exception` | Temporarily waiving a harness policy (requires `expires_at` and `conditions`) | Project Owner |

Related: [memory-policy.md](./memory-policy.md), [token-efficiency.md](./token-efficiency.md), [SECURITY.md](../SECURITY.md).
