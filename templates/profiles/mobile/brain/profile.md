# Project Profile: Mobile (`{{PROFILE_NAME}}` v`{{PROFILE_VERSION}}`)

- **Project:** {{PROJECT_NAME}} (`{{PROJECT_ID}}`)
- **Second Brain Index:** `brain/INDEX.md`
- **Constraints:** `brain/requirements/constraints.md`

## Domain Conventions

- Never commit keystores, provisioning profiles, signing certificates, or `google-services.json` secrets.
- Separate offline persistence, network sync, and UI state cleanly under `src/`.

## Testing Guidance

- Keep domain logic and offline-cache behavior covered by fast host-side unit tests before emulator/device runs.
- Document minimum OS SDK targets and required device permissions in `brain/requirements/constraints.md`.

## Documentation Checklist

- [ ] Minimum Android/iOS API levels and hardware permissions recorded in `brain/requirements/constraints.md`.
- [ ] Signing & release artifact procedures documented without storing credentials.
