# Foundation Validators

This directory contains zero-dependency Node.js validation tools for verifying the Phase 1 workspace foundation locally without external packages or network calls.

## Components

- [validate-foundation.mjs](./validate-foundation.mjs) — Comprehensive Phase 1 foundation test runner.
- [../core/yaml-subset.mjs](../core/yaml-subset.mjs) — Strict zero-dependency YAML 1.2 subset parser and Markdown YAML frontmatter extractor.
- [../core/json-schema-lite.mjs](../core/json-schema-lite.mjs) — Zero-dependency JSON Schema Draft 2020-12 subset validator.

## Run Locally

From `C:\AI-Workspace\harness`:

```powershell
node validators/validate-foundation.mjs
```

## What Is Verified vs. Not Implemented

- **Verified by this suite:** Workspace/harness/starter directory structure, required docs & role sections, 11 JSON schemas, YAML parsing of templates/starters/examples, strict schema validation of all 9 contract examples, negative parser/schema self-tests, relative Markdown link resolution, bootstrap script safety (`--dry-run`, placeholder replacement, overwrite refusal, unsafe names/destinations, `--git`), and Git repository hygiene / secret scan.
- **NOT verified (Not Implemented in Phase 1):** Context Compiler runtime, Restricted Integration Controller promotion gates, Codex/Gemini CLI provider configs, OS-level write ownership enforcement, live multi-agent orchestration, and automated recovery checkpoints.
