# Contributing to the AI Development Harness

## Core Rules

1. **Zero External Dependencies:** Core tooling, validators, and tests must run strictly on Node.js `>= 20.0.0` built-in modules and Git without `npm install`.
2. **Simplicity & Portability First:** Avoid hardcoded user directories, drive letters (`C:\...`), or redundant abstractions.
3. **Honest Scope:** Clearly mark future capabilities as **NOT IMPLEMENTED**; do not add speculative empty directories or unsupported provider configs.
4. **No Secrets:** Never commit `.env*`, tokens, private keys, or machine-specific credentials.

## Local Verification Checklist

Before committing changes inside `<harness-root>`:

```powershell
# Run the full test suite (structural, bootstrap, Second Brain, compatibility, security, portability, reuse)
npm test

# Verify Git working tree and ignore rules
git status
```

All tests must pass deterministically in temporary directories without modifying any user projects or making network calls.
