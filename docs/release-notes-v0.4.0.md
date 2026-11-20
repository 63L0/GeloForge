# GeloForge v0.4.0 — Portable Skills & Evidence-Backed Improvements

GeloForge is a **zero-dependency, provider-neutral developer harness** that helps AI coding assistants preserve project context, track tasks and verified evidence, hand off work, and reuse portable skills. This release builds on v0.3.0 without requiring a hosted AI model or cloud service.

## Highlights

- **Adopt existing projects:** `geloforge adopt` adds GeloForge to an existing repository without replacing your application source.
- **Track and verify development work:** `geloforge task new|list|show` and `geloforge evidence capture` record actual explicit command outcomes.
- **Portable Agent Skills:** Discover `SKILL.md` packages from project-local `.agents/skills/` and user-global `~/.geloforge/skills/` roots; `geloforge skills list|show|validate|lint` checks structural and common safety issues.
- **Progressive disclosure:** `geloforge context --skills` selects relevant skills deterministically, incorporates bounded context, and exposes supporting-resource paths without eagerly loading every reference.
- **Evidence-backed adaptive skills:** Create quarantined skill drafts from verified evidence/handoffs, propose updates, evaluate changes, and promote only through an explicitly selected authorization path.
- **Versioning and rollback:** SHA-256 package provenance, Ed25519-signed approvals, review-branch preparation, documented weaker local interactive confirmation, revision history, and authorized rollback.
- **Security review:** Added adversarial tests and fixes covering replayed approvals, forged history/snapshot paths, malformed approvals, secret/resource smuggling, and partial-failure recovery.

## Quick start

**Requirements:** Node.js 20 or later; Git recommended.

```bash
git clone https://github.com/63L0/GeloForge.git
cd GeloForge
node scripts/geloforge.mjs --help
npm test
```

For existing repositories, see [Five-Minute Quickstart](https://github.com/63L0/GeloForge/blob/main/docs/quickstart-5min.md) and the [Portable Skills Guide](https://github.com/63L0/GeloForge/blob/main/docs/portable-skills.md).

## Security boundaries (important)

GeloForge is **not** a secure sandbox for an AI agent with unrestricted terminal/file access. In particular, Ed25519 signature validation alone does **not** guarantee an independent human decision if that same agent can access signing keys, change the key registry, or write directly to trusted skill files. For stronger guarantees, keep signing keys outside the agent environment and pin an external verification public key, or enforce protected GitHub branches and independent PR review.

Skills are treated as potentially untrusted instructions; static lint cannot guarantee immunity to semantic prompt injection. Supporting scripts are **never run automatically** by the skills loader.

## Compatibility and limitations

- MIT licensed, Node.js >=20; zero third-party runtime dependencies.
- Maintains legacy project schema compatibility for v1.0/v1.1.
- Context-budget token counts are estimates. Some `quick` context cases exceed the nominal target, as documented.
- `package.json` remains `"private": true`; **this is a GitHub source release, not an npm package publication**.

## Testing

The final feature PR #5 passed 64 tests (agent local report) and 6/6 matrix checks across Ubuntu, Windows and macOS on Node.js 20 and 22. The v0.4.0 release workflow only publishes after a **successful push CI run on the current `main` commit**, with version consistency and tag-integrity checks. Benchmarks are synthetic, not measurements of live LLM quality.

For detailed changes and caveats, see [CHANGELOG.md](https://github.com/63L0/GeloForge/blob/main/CHANGELOG.md), [SECURITY.md](https://github.com/63L0/GeloForge/blob/main/SECURITY.md), and [Maintainer Security Guide](https://github.com/63L0/GeloForge/blob/main/docs/maintainer-security.md).
