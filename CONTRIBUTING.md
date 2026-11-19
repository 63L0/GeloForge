# Contributing to GeloForge

Thank you for helping make **GeloForge** a trustworthy, provider-neutral development toolkit.

## Core Engineering Rules

1. **Zero External Dependencies:** Core tooling, CLI commands, validators, and tests run strictly on Node.js `>= 20.0.0` built-in modules and Git without third-party `npm install` packages or network calls.
2. **Simplicity & Portability First:** Avoid hardcoded user directories, drive letters (`C:\...`), or redundant abstractions. Write cross-platform `node:path` logic that passes on Linux, macOS, and Windows.
3. **Honest Boundaries & Evidence Truth:** Never fabricate test passes, verified statuses, or security claims. Distinguish command execution exit `0` from full correctness, and mark unimplemented roadmap items as **NOT IMPLEMENTED**.
4. **No Secrets:** Never commit `.env*`, tokens, private keys, or credentials. Construct security test fixtures dynamically rather than committing literal token strings.
5. **Preserve Backward Compatibility:** Keep `schema_version` `"1.0"` and `"1.1"` compatibility intact across changes ([docs/versioning-and-upgrades.md](./docs/versioning-and-upgrades.md)).

## Local Verification Checklist

Before committing changes inside the repository:

```bash
# Run the complete zero-dependency test suite
npm test

# Run deterministic benchmarks (context compiler, codebase map, handoff)
npm run benchmark

# Verify Git working tree and ignore rules
git status
```

All tests must pass deterministically in temporary directories without modifying unrelated user projects or making network requests.
