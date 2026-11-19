# Project Profile: Desktop (`{{PROFILE_NAME}}` v`{{PROFILE_VERSION}}`)

- **Project:** {{PROJECT_NAME}} (`{{PROJECT_ID}}`)
- **Second Brain Index:** `brain/INDEX.md`
- **Constraints:** `brain/requirements/constraints.md`

## Domain Conventions

- Isolate OS-specific filesystem, IPC, and window-lifecycle adapters from core business logic in `src/`.
- Store user preferences and runtime state in standard per-OS app-data paths rather than modifying installation directories.
- Treat local filesystem writes, auto-updaters, and native process execution as explicit security boundaries.

## Testing Guidance

- Test core logic independently of GUI event loops where possible.
- Verify path handling with spaces, Unicode filenames, and clean startup/shutdown before packaging installers.

## Documentation Checklist

- [ ] Supported OS versions and CPU architectures listed in `brain/requirements/constraints.md`.
- [ ] Packaging, code-signing, and permission requirements recorded in `brain/decisions/`.
