# Known Limitations (Phase 1 Baseline)

This document records the exact boundary between what exists and was verified in Phase 1 versus what is documentation-only or not implemented.

## Status Summary by Category

### Implemented and Verified
- Workspace layout (`C:\AI-Workspace\{harness,projects,worktrees,local-runtime}`) with no root Git repository and an independent Git repository for `harness\`.
- Eleven machine-validatable JSON Schemas ([schemas/](../schemas/README.md)), nine contract templates, and nine clearly marked non-authoritative examples ([contracts/examples/](../contracts/examples/README.md)).
- Reusable Second Brain template ([templates/project-starter/](../templates/project-starter/README.md)).
- Zero-dependency project generator ([bootstrap-project.mjs](../scripts/bootstrap-project.mjs)) with dry-run, input validation, overwrite refusal, and optional local Git initialization.
- Zero-dependency local validation script ([validate-foundation.mjs](../validators/validate-foundation.mjs)).

### Documented Only (No Runtime Enforcement)
- **Write Ownership & Authority Rules** ([memory-policy.md](../policies/memory-policy.md)): No OS-level or Git-hook filesystem write enforcement exists in Phase 1. Any user or tool with filesystem access could technically edit any file.
- **Approval Boundaries** ([approval-boundaries.md](../policies/approval-boundaries.md)): Approval workflows (`APPR-NNNN`) rely on operator discipline; no automated interceptors enforce them yet.
- **Token Efficiency Targets** ([token-efficiency.md](../policies/token-efficiency.md)): Max 2 specialist agents, max 2 retries, and spend limits are policy targets only, not runtime limits.
- **Agent Roles** ([roles/](../roles/README.md)): Role documents specify future behavior only; no operational subagent runner exists.

### Not Implemented
- Deterministic Context Compiler ([context-compiler-spec.md](../context/context-compiler-spec.md)).
- Restricted Integration Controller and automatic knowledge promotion.
- Codex CLI and Gemini CLI configurations/adapters.
- Multi-agent orchestration, schedulers, worktree managers, checkpoints, `skills/`, and `evaluations/`.
- Vector databases, RAG pipelines, background services, cloud resources, paid APIs, and remote Git integration.

### Technical Scope Limits of Phase 1 Validator
- **Custom Zero-Dependency YAML Subset Parser** ([yaml-subset.mjs](../validators/lib/yaml-subset.mjs)): Because installing external npm packages (`js-yaml`, `ajv`) is prohibited in Phase 1, the validator uses a strict YAML 1.2 subset parser supporting block mappings, nested mappings, block sequences, scalars, empty `[]`/`{}`, simple inline scalar arrays, and block scalars (`|` / `>`). Complex YAML features (anchors/aliases `&/*`, multi-line flow objects, custom tags) are intentionally rejected.
- **JSON Schema Subset** ([json-schema-lite.mjs](../validators/lib/json-schema-lite.mjs)): Supports the Draft 2020-12 keywords used across the 11 harness schemas (`type`, `required`, `properties`, `additionalProperties`, `enum`, `const`, `pattern`, `minLength`, `maxLength`, `minimum`, `maximum`, `items`, `minItems`, `uniqueItems`), not advanced keywords like `$ref`, `oneOf`, or `allOf`.

### Blocked (Untestable in Phase 1)
- End-to-end multi-agent handoff execution, runtime token-budget compliance, automated checkpoint resume, and Restricted Integration Controller promotion cannot be tested because those runtime components do not exist yet.
