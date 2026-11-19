# Project Profile: AI System (`{{PROFILE_NAME}}` v`{{PROFILE_VERSION}}`)

- **Project:** {{PROJECT_NAME}} (`{{PROJECT_ID}}`)
- **Second Brain Index:** [brain/INDEX.md](./INDEX.md)
- **Constraints:** [brain/requirements/constraints.md](./requirements/constraints.md)

## Domain Conventions

- Keep prompts, schemas, evaluation datasets, and provider adapter interfaces separated under `src/`.
- Gate external paid model calls, tool permissions, and irreversible mutations behind explicit budgets and approvals (`APPR-NNNN`).
- Never treat unverified model outputs (`A6`) as authoritative truth (`A1`–`A3`).

## Testing Guidance

- Use deterministic fixtures and recorded evaluations in `tests/` without calling metered APIs in standard CI/local checks.
- Report token efficiency metrics only from measured execution logs.

## Documentation Checklist

- [ ] Model/provider boundaries, spend caps, and fallback limits recorded in `brain/requirements/constraints.md`.
- [ ] Evaluation baseline and safety boundaries documented before enabling autonomous workflows.
