# Project Profile: Automation (`{{PROFILE_NAME}}` v`{{PROFILE_VERSION}}`)

- **Project:** {{PROJECT_NAME}} (`{{PROJECT_ID}}`)
- **Second Brain Index:** `brain/INDEX.md`
- **Constraints:** `brain/requirements/constraints.md`

## Domain Conventions

- Design destructive or mutating workflows to be idempotent and support a non-mutating `--dry-run` preview mode.
- Bound retries explicitly and never fail silently on partial side effects.

## Testing Guidance

- Verify dry-run, overwrite refusal, invalid input rejection, and partial-failure rollback in temporary directories.

## Documentation Checklist

- [ ] Idempotency guarantees, retry bounds, and failure recovery steps documented in `brain/architecture/overview.md`.
- [ ] Required credentials and approval boundaries recorded without embedding secrets.
