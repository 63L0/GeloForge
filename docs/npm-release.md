# Publishing GeloForge to npm

## Verify the package locally

```bash
npm pack --dry-run --json
npm run smoke:package
```

The smoke test packs the CLI and runs it through `npm exec` with an isolated, offline cache. It exercises project adoption, scaffolding, context and evidence, and MCP stdio from the installed tarball. CI runs the same check on Windows, macOS, and Linux with Node 20 and 22.

## First npm release

In the release PR, update `package.json`, `VERSION`, and `core/compatibility.json` to the release version and remove `"private": true` from `package.json`. Create the matching version tag from the `main` commit after its push CI passes.

The first publish creates the package and its settings on npm. From a clean checkout of the verified release tag, sign in with the maintainer's npm account and complete npm's two-factor authentication when publishing. For v0.6.0 the commands are:

```bash
npm login --registry=https://registry.npmjs.org
npm run smoke:package -- --pack-destination ../geloforge-package
npm publish ../geloforge-package/geloforge-0.6.0.tgz --access public --ignore-scripts --registry=https://registry.npmjs.org
```

## Later releases with trusted publishing

In the package's npm settings, add a GitHub Actions [trusted publisher](https://docs.npmjs.com/trusted-publishers/) with these values:

| Setting | Value |
| --- | --- |
| Organization or user | `63L0` |
| Repository | `GeloForge` |
| Workflow filename | `publish-npm.yml` |
| Allowed action | `npm publish` |

For each prepared and tagged release, run **Publish GeloForge to npm** from `main` with the release version. GitHub Actions verifies the tag and successful CI for the selected commit, builds and tests the tarball, and publishes that artifact using npm's short-lived OIDC credentials.

Check the registry and CLI from a separate directory after publication:

```bash
npm view geloforge version
npx --yes geloforge@latest --version
```
