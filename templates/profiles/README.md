# Project Profiles (Base Template + Small Profile Overrides)

Rather than duplicating [project-starter](../project-starter/README.md) for every application domain, `scripts/bootstrap-project.mjs` applies an optional, small **profile overlay** on top of the shared Second Brain template (`--profile <name>`).

Every profile keeps the exact same Second Brain schemas, authority model, and `AGENTS.md` / `GEMINI.md` entrypoints, adding only:

1. `brain/profile.md` — concise domain conventions, platform considerations, and testing checklist.
2. `.gitignore` additions from `gitignore.append`.
3. `profile` and `profile_version` fields in `brain/manifest.yaml` checked by [compatibility.mjs](../../core/compatibility.mjs).

## Available Profiles

| Profile (`--profile`) | Version | Focus |
| :--- | :--- | :--- |
| `web` | `1.0.0` | Browser/web apps, bundle/API hygiene, accessibility, E2E/unit testing |
| `desktop` | `1.0.0` | Native/cross-platform desktop apps, installer/packaging & OS permission hygiene |
| `mobile` | `1.0.0` | iOS/Android mobile apps, device signing, offline state & store compliance |
| `automation` | `1.0.0` | CLI tools, scheduled jobs, idempotency, retries & dry-run safety |
| `ai-system` | `1.0.0` | LLM/agent/ML pipelines, evaluation harnesses, prompt/cost/safety boundaries |
