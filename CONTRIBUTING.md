# Contributing to GeloForge

**You don't need to be a framework expert to help.** If you spot confusing documentation, a broken example, a portability issue, or a real workflow GeloForge could improve, contributions are welcome.

## Good places to start

- **Improve onboarding:** Try the [5-minute quickstart](./docs/quickstart-5min.md) in a fresh repo and report anything confusing.
- **Report a bug:** [Open an issue](https://github.com/63L0/GeloForge/issues/new/choose) with your OS, Node version, exact command, expected behavior, and observed output. Remove secrets first.
- **Suggest a small improvement:** Open a [feature request](https://github.com/63L0/GeloForge/issues/new/choose), describing who needs it and why.
- **Add tests or documentation:** Focused improvements to existing commands, examples, or cross-platform behavior are especially useful.

## Your first pull request

1. Fork GeloForge and create a topic branch from up-to-date `main`.
2. Keep the change focused. Include a test if you change runtime behavior.
3. Run the checks from the repo root:

   ```bash
   npm test
   npm run benchmark
   npm run smoke:package
   git status
   ```

4. Open a PR that explains **what changed**, **why it matters**, and **what you verified**. Link the related issue if one exists.
5. Be ready to adjust the PR after CI and maintainer feedback.

[See the open pull requests](https://github.com/63L0/GeloForge/pulls) · [Project security policy](./SECURITY.md)

See the [npm release guide](./docs/npm-release.md) for packaging and publishing.

## Engineering principles

GeloForge deliberately favors a small, auditable core:

- **No external runtime packages or mandatory cloud APIs.** Use Node.js 20+ built-ins and Git.
- **Cross-platform first.** Avoid hardcoded user paths, POSIX-only assumptions, and unsafe filesystem shortcuts.
- **Evidence over claims.** A process exit code of zero shows a command completed successfully, not that the entire application is correct.
- **Fail closed on unsafe inputs.** Protect paths, untrusted skill content, private keys, and security-sensitive data.
- **Preserve compatibility.** Keep supported project schema versions `1.0` and `1.1` working. Read [versioning and upgrades](./docs/versioning-and-upgrades.md).
- **Do not overclaim agent integrations.** GeloForge generates files and CLIs; it does not automatically operate external models or IDEs.

Tests should operate on isolated fixtures and never modify unrelated user projects or contact real external services. For trust-boundary changes, document the actual guarantees and remaining limits.

## Responsible security reporting

Please follow [SECURITY.md](./SECURITY.md) rather than publishing exploitable secrets or sensitive reproduction details in a public issue.

Thanks for making GeloForge easier to understand and safer to use.
