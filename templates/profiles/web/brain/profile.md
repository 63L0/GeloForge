# Project Profile: Web (`{{PROFILE_NAME}}` v`{{PROFILE_VERSION}}`)

- **Project:** {{PROJECT_NAME}} (`{{PROJECT_ID}}`)
- **Second Brain Index:** [brain/INDEX.md](./INDEX.md)
- **Constraints:** [brain/requirements/constraints.md](./requirements/constraints.md)

## Domain Conventions

- Separate client-bundle state, server/API contracts, and build outputs cleanly under `src/`.
- Never expose private API keys or server secrets in client-side bundles or `VITE_*` / `NEXT_PUBLIC_*` variables.
- Document browser support, CSP/CORS boundaries, and responsive breakpoints in `brain/requirements/constraints.md`.

## Testing Guidance

- Keep fast unit/component tests deterministic without requiring live external network services.
- Verify accessibility (keyboard navigation, semantic landmarks, contrast) and production build output before releasing.

## Documentation Checklist

- [ ] Target runtime & browser compatibility matrix recorded in `brain/requirements/constraints.md`.
- [ ] API contracts and environment variable template documented without real secrets.
