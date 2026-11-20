# GeloForge v0.5.0 — Release Preparation & Publication Checklist

> **State:** Release candidate preparation. **Do not create or move the `v0.5.0` tag or publish a GitHub Release without a separate explicit maintainer approval.** Preserve existing `v0.3.0` and `v0.4.0` published tags. No npm publication (`package.json` is `private: true`).

## 1. Source and version checks

- [ ] Confirm merged PR #10 on `main` (merge commit `83be25b84a6c44fa21d721931059a6bb528e949f`) and no unintended changes.
- [ ] Confirm this release-preparation PR is reviewed and merged only after successful checks.
- [ ] Confirm the exact release-candidate `main` SHA after merge.
- [ ] Confirm `VERSION`, `package.json.version`, and `core/compatibility.json.harness_version` all read `0.5.0`.
- [ ] Confirm schema versions `1.0`/`1.1`, template/profile version compatibility, MIT license, Node.js >=20, and `private: true` stay unchanged.
- [ ] Confirm documentation and relative links are valid, and release notes match actual implemented capabilities.
- [ ] Confirm old one-time v0.4 publication workflow is retired, **without** changing old tags/releases.

## 2. Fresh checkout / first-run smoke

The repository CI now runs on clean GitHub-hosted checkouts:

1. `npm test`
2. `npm run benchmark`
3. `npm link --ignore-scripts --no-audit --no-fund`
4. `geloforge --version`
5. `node scripts/smoke-fresh-install.mjs`

The isolated smoke script must prove that, on a fresh checkout with no paid API:

- [ ] CLI is executable and its `--version` agrees across source metadata.
- [ ] A **new** automation-profile Git project can be created, validated and inspected.
- [ ] A task can be created and activated; recommendations and mapped context can be compiled.
- [ ] Real Node command evidence can be captured; `task done --require-evidence` accepts verified evidence only.
- [ ] A `CHKPT-NNNN` can be created/listed and the project still validates.
- [ ] An **existing** project can be previewed and adopted without changing its original `app.js` or `README.md`.
- [ ] All temporary smoke projects are deleted on exit.
- [ ] All **six** required CI matrix jobs pass: Ubuntu, macOS, Windows × Node.js 20/22.

**Scope limit:** This is a local first-run CLI smoke test on isolated projects, **not** an end-to-end test against Codex/Gemini/Claude/Antigravity or any cloud MCP client, nor a fresh external-user laptop install.

## 3. Security and regression gates

- [ ] Inspect `core/project-lock.mjs` concurrency and process interruption recovery and `core/mcp-server.mjs` trusted roots/read-only boundaries.
- [ ] Confirm existing 77-test baseline and updated suite pass on the final RC head.
- [ ] Confirm existing known limitations are stated honestly: local cooperative leases, self-declared agent identities, lazy journal recovery, lack of fsync power-loss guarantees, and prompt-injection limits.
- [ ] Check for credentials/secrets, stray generated files, direct main pushes, or unapproved workflow enablement.
- [ ] Confirm GitHub branch rules and review gates from repository settings separately, if possible; CODEOWNERS itself does not prove enforcement.

## 4. Release actions — only after approval

1. Change `CHANGELOG.md` from **Unreleased (release candidate)** to the approved actual publication date in a reviewed PR.
2. Merge release-finalization PR, verify `main` SHA and **main push** CI (not just PR checks). Record CI run ID and all six job results.
3. Confirm annotated `v0.5.0` tag and GitHub Release do **not** already exist; if either does, inspect rather than overwrite.
4. Create annotated `v0.5.0` tag at the exact verified `main` commit; never move existing published tags.
5. Publish GitHub Release **GeloForge v0.5.0** using [release notes](./release-notes-v0.5.0.md). Publish **source only**, not npm.
6. Verify published tag's peeled commit, full Release page, source archives, GitHub Actions evidence and `v0.5.0` latest status.
7. Update [README.md](../README.md) link from `v0.4.0` to `v0.5.0` only once the release is actually published, through a follow-up reviewed PR.

## 5. Evidence log (fill only with verified results)

| Item | Result / Evidence |
| --- | --- |
| PR #10 feature merge | `83be25b84a6c44fa21d721931059a6bb528e949f` |
| v0.5.0 preparation PR | Pending PR and CI |
| Final release-candidate main SHA | Not yet selected |
| Fresh-checkout 6-job CI | Not yet verified |
| Post-merge push CI | Not yet verified |
| Release tag | Not created |
| GitHub Release | Not published |

When a check cannot be independently confirmed, mark it **unverified** rather than guessing.
