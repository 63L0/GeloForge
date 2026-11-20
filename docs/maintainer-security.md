# Maintainer Security: Protected Main & Human Review

This guide describes **repository-hosted** controls that complement GeloForge's local skill authorization checks. The presence of `.github/CODEOWNERS` by itself does **not** enforce review. Configuring GitHub rules requires a repository admin and cannot be done by running the GeloForge CLI.

## Solo-maintainer baseline (safe to configure now)

In the GitHub repository, open **Settings → Rules → Rulesets → New branch ruleset** (or **Settings → Branches → Add branch protection rule**, if rulesets are unavailable).

- Name the ruleset `Protect main`; set it **Active** and target exactly the default `main` branch.
- Require a pull request before merging, but **do not require approving reviews yet** while there is only one authorized maintainer. GitHub does not permit a pull request author to approve their own PR. This is a process/CI gate, **not independent human sign-off**.
- Require the six GitHub Actions matrix status checks to pass before merging:
  - `ubuntu-latest (Node 20)`
  - `ubuntu-latest (Node 22)`
  - `macos-latest (Node 20)`
  - `macos-latest (Node 22)`
  - `windows-latest (Node 20)`
  - `windows-latest (Node 22)`
- Block force pushes and deletion of `main`.
- Avoid bypass exceptions for agents and automation accounts. Check how administrator/bypass rules apply to the account used for merging before enabling enforcement.
- Save, then verify the active ruleset applies to `main`, and verify the expected checks are correctly named (the CI job matrix may evolve).

**Important:** A sole maintainer with an unrestricted admin account can still alter repository settings. GitHub checks and a `CODEOWNERS` file do not make a privileged account or a local AI agent independently trustworthy.

## Team / independent-approval configuration (after adding a trusted human reviewer)

- Add a separate trusted collaborator with the necessary repository permission.
- Enable **Require approvals**, with at least one approval from someone other than the PR author.
- Enable **Require review from Code Owners**, and stale-review dismissal as appropriate.
- Protect the `CODEOWNERS` file and security-critical directories in rules and owner routes.
- Enforce the rules on administrators where appropriate; do not give the AI agent bypass permissions or the maintainer's GitHub credentials.
- Confirm a test PR that changes `.agents/skills/**` is blocked until the trusted human actually approves.

## Local skill approval: separate key custody

GeloForge's Ed25519 signature validation verifies **whoever controls a trusted signing key**, not the real-world identity or independence of its holder. An agent with the same unrestricted shell and filesystem permissions as the maintainer can edit local trusted skill files and an in-repository key registry.

For genuinely independent approval:

1. Keep the human approver's **private key out of the agent's accessible filesystem/process/session**; ideally use a different account or device.
2. Pin a trusted **public key outside the writable repo** using `--public-key` for verification. Keep the trust configuration inaccessible to the agent.
3. Treat `--mode pr-branch` as a **proposal preparation** step, not completed human approval. The real enforcement is the protected GitHub PR workflow.
4. Review the exact candidate package digest, diff, evidence, and source commit before approval.
5. Preserve and inspect the audit history; verify snapshots and approvals at promotion/rollback.

## Ongoing change and release safeguards

1. Keep `.github/CODEOWNERS` and the `Protect main` ruleset aligned with the repository's actual reviewers and CI job names.
2. Before merging a PR, inspect the latest head SHA, all six required CI checks, and whether the branch protections are actively enforced.
3. When adding independent maintainers, enable required human review and code-owner review without permitting automation bypasses.
4. Keep previously published tags (including `v0.3.0` and `v0.4.0`) immutable. Prepare later releases on a separate reviewed branch.
5. For skill promotion, prefer externally controlled signing keys or genuinely enforced server-side reviews over local confirmations alone.

These are recommended controls, not proof that the current repository is protected. Always verify GitHub's actual settings and merge behavior.
