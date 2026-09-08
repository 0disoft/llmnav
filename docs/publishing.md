# Publishing `llmnav` to npm

Maintainers publish this repository through the existing tag-triggered GitHub Actions workflow. Initial repository and npm account setup belongs to the separate bootstrap section below; it is not part of every release.

## Routine release

1. Confirm the intended version agrees across `package.json`, `package-lock.json`, `src/spec.js`, and the changelog. Review the exact diff and keep unrelated changes out of the release.
2. Check the remote tag and npm version before creating anything. Authentication or network errors mean unknown state, not an unpublished version. Never move an existing release tag or overwrite a published version.
3. Validate the exact payload using the commands below. Reuse passing checks only while their relevant inputs remain unchanged.
4. Commit and push the release changes to `main`. Require successful Windows/Linux and package CI for that exact commit, not a previous commit.
5. Create an annotated version tag on the verified commit and push only that tag. The workflow handles npm publication and GitHub Release creation.
6. Verify the tag commit, release workflow, npm version and integrity, provenance, GitHub Release, and an installation of the published package. Publication success and branch CI are separate checks.

```sh
npm run check
npm run release:check
npm run smoke:pack
npm pack --dry-run
```

If dependencies are missing or the lockfile changed, install them through the approved dependency workflow before these checks. The package intentionally includes the CLI, source API, type declarations, schema, templates, documentation, the typed provider-neutral host example, README, changelog, roadmap, and license. Tests, benchmarks, and development scripts remain in GitHub rather than the installed package.

After choosing the version, replace the placeholder in both tag commands:

```sh
git tag -a vX.Y.Z -m "llmnav vX.Y.Z"
git push origin refs/tags/vX.Y.Z
```

The workflow rejects a tag that does not match `package.json` or the protected `origin/main` lineage. If the version already exists in npm, it succeeds only when the registry integrity matches the tagged payload. A mismatch fails closed and requires a new version, not a forced tag. GitHub Release creation runs only after publication or matching-integrity verification succeeds.

If publication is interrupted, inspect the existing tag, registry artifact, and workflow result before retrying. Preserve the version and tag when they already identify the intended artifact; do not assume a failed workflow means nothing was published.

## One-time bootstrap for a new repository or publisher

### Claim names and set owner metadata

Before a first publication, create the GitHub repository and check npm name availability. An `E404` means no public package is visible at that moment, not that the name is reserved. Do not repeat owner replacement for routine releases of this configured repository.

Update only the owner-specific URLs in `package.json` and `.github/ISSUE_TEMPLATE/config.yml`.
Do not run a repository-wide replacement: the release checker and doctor intentionally keep the literal `OWNER` sentinel in source code.

```sh
npm pkg set repository.url="git+https://github.com/YOUR_GITHUB_OWNER/llmnav.git"
npm pkg set bugs.url="https://github.com/YOUR_GITHUB_OWNER/llmnav/issues"
npm pkg set homepage="https://github.com/YOUR_GITHUB_OWNER/llmnav#readme"
```

Then replace `OWNER` only in `.github/ISSUE_TEMPLATE/config.yml` and run:

```sh
npm run release:check
```

### Configure npm authentication

The supplied release workflow uses GitHub's OIDC token through npm Trusted Publishers. The public GitHub source repository enables provenance in both `package.json` and the workflow, and the release check fails if either surface disables it. The same tag workflow creates an idempotent GitHub Release only after the npm registry check or publication succeeds.

The workflow references a GitHub environment named `npm`. Configure that environment and its protection rules as part of bootstrap. Do not remove an existing approval gate merely to unblock a release.

A classic or granular access token can be used for a manual first publication. Do not commit `.npmrc` credentials or an npm token. npm may still require browser-backed two-factor authentication.

### Manual first publication, only when required

Manual publication:

```sh
npm login
npm publish --provenance --access public
```

## Verify a published version from a clean directory

Use an explicit published version instead of the moving default tag. The temporary project must be outside the source repository. Do not commit installed files or credentials.

From a source checkout, `npm run smoke:pack -- --published=X.Y.Z` runs the existing CLI/API/host assertions against that exact npm version in a temporary project with lifecycle scripts disabled. Without the option, it tests a locally packed tarball instead.

```sh
mkdir llmnav-smoke
cd llmnav-smoke
npm init -y
npm install --save-dev --ignore-scripts llmnav@X.Y.Z
npx llmnav --version
npx llmnav init --agents all --package-scripts
npx llmnav doctor
```

## Versioning policy

The npm package follows semantic versioning. The comment protocol is versioned separately in the header.

A CLI or API breaking change increments the npm major version. A breaking source syntax change creates a new header such as `llmnav/2`; existing `llmnav/1` parsing should remain available through an explicit migration window.
