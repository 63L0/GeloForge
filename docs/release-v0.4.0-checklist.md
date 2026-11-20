# GeloForge v0.4.0 Release Checklist (Draft)

> **Release state:** Preparation only. Do not create/move tags or publish a GitHub Release until the release-preparation PR passes review and a maintainer explicitly approves publication.

## 1. Source and security gates

- [ ] Confirm PR #3 (onboarding), PR #4 (portable skills), PR #5 (adaptive skills), and PR #6 (CODEOWNERS/security guide) are merged into `main`.
- [ ] Confirm the release-preparation PR is rebased or merged cleanly on the **latest** `main`, with no uncommitted changes.
- [ ] Confirm GitHub's `Protect main` ruleset is **Active** and targets only the default `main` branch. Verify settings in GitHub UI; `CODEOWNERS` alone does not enforce approvals.
- [ ] Verify the **six exact CI check contexts** are required: Ubuntu, Windows, and macOS on Node 20 and Node 22; choose GitHub Actions as their trusted source.
- [ ] Confirm deletion and force-push protection on `main`. If solo-maintained, avoid requiring a self-approval that GitHub will never accept; document that this is not independent human review.
- [ ] Audit `.github/CODEOWNERS`, `SECURITY.md`, and `docs/maintainer-security.md`. For true independent skill approvals, verify private key custody is separate from agents and public keys are pinned outside agent-writable paths (or require protected external PR reviews).
- [ ] Check there are no committed secrets, private keys, generated snapshots, or unintended binaries.

## 2. Release quality gates

- [ ] Run `npm test` on the release candidate after any final changes.
- [ ] Run `npm run benchmark`; note that synthetic benchmarks do not establish live LLM accuracy.
- [ ] Inspect **all six GitHub Actions jobs** on the final release-preparation PR head, and again on `main` after merge if available.
- [ ] Confirm `package.json` and README both state `0.4.0`.
- [ ] Confirm documentation and Markdown links resolve and all three v0.4 feature milestones are represented accurately in CHANGELOG.
- [ ] Confirm zero third-party runtime dependencies, Node.js >=20, MIT license, and `private: true` (no npm publishing).
- [ ] Validate legacy projects/schema versions 1.0/1.1 and critical skill-approval/rollback tests.
- [ ] Review limitations: shared-host agent write access can bypass local approval, static prompt-injection scanning is incomplete, `quick` context may overrun its estimated budget, and `--mode pr-branch` alone is not human approval.

## 3. Final publication — requires explicit maintainer approval

1. Merge the release-preparation PR through protected `main` after all checks pass.
2. Resolve the **final release date** in the changelog (replace `Unreleased` in a reviewed commit, if desired).
3. Identify the exact tested `main` commit to release.
4. Create the **new** annotated tag `v0.4.0` only at that commit; never move the already-published `v0.3.0` tag.
5. Publish a GitHub Release titled **GeloForge v0.4.0**, with notes matching the finalized changelog and explicit skill-authorization limitations.
6. Verify the GitHub Release page, tag target, source archive, version metadata, and the `main` CI result.
7. Communicate that this is a GitHub source release; `package.json` has `private: true`, so npm publication is not part of the release.

## 4. Evidence to record

Record the final release-candidate commit SHA, six job URLs/results, test/benchmark outputs, approvals, final tag object/commit, published Release URL, and any deviations. No claim of independent GitHub Ruleset verification should be made without a reliable ruleset readback or UI confirmation.
