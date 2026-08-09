# CI and enforcement

## Required checks

A practical LLMNav gate has four stages.

```sh
npx llmnav format --check
npx llmnav check --format github
npx llmnav generate --check
npx llmnav eval
```

`format --check` rejects non-deterministic serialization.

`check` rejects invalid meaning, unresolved or retired semantic relations, malformed registry states and cycles, stale registry use, missing configured coverage, and attachment failures.

`generate --check` rejects stale indexes and catalogs.

`eval` catches ranking regressions that remain syntactically valid.

## Included GitHub Actions workflow

The repository includes `.github/workflows/ci.yml`. It tests supported Node.js releases and the primary desktop operating systems, runs the built-in test suite, validates the repository's own cards, and inspects the npm tarball.

Consumer repositories can use a smaller job:

```yaml
name: LLMNav

on:
  pull_request:
  push:
    branches: [main]

jobs:
  llmnav:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npx llmnav format --check
      - run: npx llmnav check --format github
      - run: npx llmnav generate --check
      - run: npx llmnav eval
```

## Coverage rules

LLMNav does not force every source file to contain a card. Repositories define boundaries that must be covered.

```json
{
  "coverageRules": [
    {
      "name": "HTTP entry points",
      "match": ["src/routes/**/*.ts", "src/api/**/*.ts"],
      "scope": "file",
      "requiredFields": ["effect", "stability"]
    },
    {
      "name": "database migrations",
      "match": ["migrations/**/*.sql"],
      "scope": "file",
      "requiredFields": ["invariant", "risk"]
    }
  ]
}
```

Coverage rules support `*`, `?`, and `**` path matching.

Do not add a broad `src/**/*.ts` rule. It converts the protocol into mandatory comment noise.

## Diagnostic policy

Errors block generation. Warnings do not block `check` by default.

A repository may treat warnings as errors in its wrapper after it has stabilized its vocabulary and comment budget.

Stable diagnostic codes make CI policy independent from message wording.

| Code | Meaning |
| --- | --- |
| `LNV001` | required card or field missing |
| `LNV002` | duplicate, invalid, retired, or conflicting ID |
| `LNV003` | volatile data stored in a source card |
| `LNV004` | generated structural relation maintained by hand |
| `LNV005` | invalid key or controlled value |
| `LNV006` | weak or oversized role |
| `LNV007` | search phrase quality, count, or saturation failure |
| `LNV008` | unresolved semantic relation |
| `LNV009` | reserved for future contract fingerprint drift |
| `LNV010` | non-canonical or stale generated representation |
| `LNV011` | parser or declaration attachment failure |
| `LNV012` | deleted or renamed ID lacks lifecycle handling |
| `LNV013` | card or repository comment budget exceeded |
| `LNV014` | search regression gate failure |

## Pull-request review

Review semantic card changes as contract changes, not as harmless comments.

A useful PR summary contains:

* added, changed, redirected, and retired IDs
* changed roles and invariants
* newly declared effects and risks
* relation changes
* generated module catalogs affected
* evaluation queries added or regressed

Avoid bundling a global catalog reorder with functional code changes.

## Generated files

Commit generated catalogs. They are consumed by agents, diffable during review, and verified deterministically.

Do not manually edit `.llmnav/cache`. A manual edit will be overwritten and should fail manifest or generation verification.
