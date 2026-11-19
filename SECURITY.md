# Security Policy and Boundary Disclosure

## Enforced Technical Controls vs. Documented-Only Safeguards

This repository clearly separates controls that are **technically enforced by code today** from controls that are **documented policy targets** for future phases:

### Technically Enforced Controls (Phase 1.2)
- **Bootstrap Path & Traversal Defense ([core/path-safety.mjs](./core/path-safety.mjs)):** Rejects relative `..` traversal segments, UNC/network paths, illegal characters, Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), trailing dots/spaces, filesystem roots, and destinations inside protected harness directories.
- **Symlink / NTFS Junction Checks:** Walks existing ancestor directories (`lstatSync` + `realpathSync`) to block creating projects through symbolic links or directory junctions, and refuses symlinks inside template/profile trees.
- **Overwrite Refusal & Transactional Staging ([scripts/bootstrap-project.mjs](./scripts/bootstrap-project.mjs)):** Refuses existing destinations, writes into a unique temporary staging directory using exclusive file flags (`wx`), validates before commit, and cleans up on failure.
- **Single-Pass Template Rendering:** Substitutes allowlisted `{{...}}` keys in one pass so user-supplied values containing `{{...}}` cannot trigger secondary placeholder expansion; YAML scalar values are escaped.
- **Zero-Network / Zero-Dependency Tooling:** `core/` and `scripts/` import only Node.js built-ins and make zero network requests (`tests/security.test.mjs` verifies absence of network APIs).
- **Secret Hygiene & Exclusions:** `.gitignore` excludes `.env*`, keys/certs (`*.pem`, `*.key`, `*.p12`, `*.pfx`), `secrets/`, and `local-runtime/`; tests verify `git check-ignore` and scan tracked files for common key/token patterns.
- **Context Compiler Input & Path Isolation ([core/context-compiler.mjs](./core/context-compiler.mjs)):** Blocks path traversal, symlinks/junctions, oversized (>512 KB) files, forbidden secret paths/patterns, unapproved `accepted` ADRs, and canonical `is_example: true` fixtures; quarantines `A5`–`A6` and draft items (or omits them with `--exclude-unverified`), and escapes spoofed `<<<END_GELOFORGE_DOC>>>` markers.

### Prompt-Injection Threat Model & Documented-Only Safeguards
- **Prompt-Injection Limitation (Important):** Wrapping files in `<<<GELOFORGE_DOC>>>` delimiters and escaping closing markers does **not** prevent adversarial text inside untrusted Markdown, external research, or mapped source code comments from semantically influencing an AI coding assistant. Delimiter isolation improves legibility and stops parser/boundary spoofing; it must **not** be treated as a sandbox against LLM prompt injection.
- **Documented-Only Safeguards:** Role-based write ownership (`memory-policy.md`), approval gates (`APPR-NNNN`), max-2 agent concurrency, max-2 retry caps, and zero-spend limits (`token-efficiency.md`) are **not enforced by OS ACLs, Git hooks, or runtime interceptors** in the CLI today; untrusted agent claims must still be checked against real project artifacts and human approvals.

## Reporting Security Issues

This repository is released under the [MIT License](./LICENSE). Configure private vulnerability reporting in the GitHub repository security settings. Never commit `.env` files, API tokens, or private keys in issues, pull requests, or commits.
