# Publishing `llmnav` to npm

The repository is release-ready except for owner-specific metadata and npm account configuration.

## 1. Claim the names

Create the GitHub repository named `llmnav`, then check the npm registry immediately before the first release:

```sh
npm view llmnav
```

An `E404` means no public package is visible through the registry you queried at that moment. It is not a reservation. The name remains claimable by someone else until publication succeeds.

## 2. Replace release metadata

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

## 3. Configure npm authentication

The supplied release workflow uses npm provenance and GitHub's OIDC token. In npm package settings, configure the GitHub repository and `.github/workflows/release.yml` as a trusted publisher.

The workflow references a GitHub environment named `npm`. Create that environment for release protection, or remove the `environment` line when no environment gate is desired.

A classic or granular access token can be used for a manual first publication. Do not commit `.npmrc` credentials or an npm token.

## 4. Validate the exact package payload

```sh
npm ci
npm run check
npm run release:check
npm run smoke:pack
npm pack --dry-run
```

Inspect the tarball list. The package intentionally includes the CLI, source API, type declarations, schema, templates, documentation, README files, changelog, roadmap, and license. Tests, benchmark harnesses, development scripts, and examples remain in GitHub but are not installed into consumer projects. `npm run smoke:pack` verifies the exact tarball in a clean temporary project.

## 5. Publish the first release

Manual publication:

```sh
npm login
npm publish --provenance --access public
```

Automated publication:

```sh
git tag v0.3.0
git push origin v0.3.0
```

The release workflow rejects a tag that does not match `package.json`.

## 6. Verify from a clean directory

```sh
mkdir llmnav-smoke
cd llmnav-smoke
npm init -y
npm install --save-dev llmnav
npx llmnav --version
npx llmnav init --agents all --package-scripts
npx llmnav doctor
```

## Versioning policy

The npm package follows semantic versioning. The comment protocol is versioned separately in the header.

A CLI or API breaking change increments the npm major version. A breaking source syntax change creates a new header such as `llmnav/2`; existing `llmnav/1` parsing should remain available through an explicit migration window.
