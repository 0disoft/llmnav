# CI and enforcement

## Consumer repository gates

A practical LLMNav gate has four stages.

```sh
npx llmnav format --check
npx llmnav check --format github
npx llmnav generate --check
npx llmnav eval
```

`format --check` rejects non-canonical source-card serialization.

`check` rejects invalid meaning, unresolved or retired semantic relations, malformed registry state, missing configured coverage, path escape, and declaration attachment failures.

`generate --check` performs an incremental read-only reconstruction and rejects stale primary indexes, inverted indexes, file state, manifests, and catalogs.

`eval` catches ranking regressions that remain syntactically valid.

## Machine-readable impact gate

CI or an agent orchestrator can inspect one generation result without parsing terminal text.

```sh
npx llmnav generate --json > llmnav-generation.json
```

Useful fields are:

```text
changedFiles
changedCards[].id
changedCards[].change
changedCards[].dimensions
affectedCatalogs[].kind
affectedCatalogs[].id
incremental.files.parsedFiles
incremental.cards.indexedCards
transaction.recovered
transaction.recoveryAction
```

Array order is deterministic. A policy can require review when `semantic` changes occur in `auth`, `money`, or `privacy` cards while allowing body-only changes to proceed normally.

## Included GitHub Actions workflow

This repository's `.github/workflows/ci.yml` executes:

| Operating system | Node.js |
| --- | --- |
| Ubuntu | 22, 24 |
| Windows | 22, 24 |

Every matrix entry runs linting, all tests, source-card validation, and generated-cache verification. Node.js 22 entries also install the actual npm tarball into a clean project and run initialization, generation, query, validation, verification, and doctor commands.

The Windows matrix is required because directory rename, file locking, process interruption, and executable shims differ materially from Linux.

A smaller consumer workflow can use:

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

Repositories that depend on Windows development should add a `windows-latest` job rather than assuming cache replacement behaves identically.

## Transaction failure regression

The repository test suite injects failures at several transaction phases:

```text
after writing a staged artifact, before a journal exists
after moving the previous cache to backup
after installing a new cache, before commit
```

The assertions compare the restored `index.json` with the previous bytes and run a query after recovery. Transient Windows error codes `EACCES`, `EBUSY`, `EEXIST`, `ENOTEMPTY`, and `EPERM` are injected into rename operations to verify bounded retries.

These tests are not a substitute for the Windows CI runner. They make exact phases reproducible on every platform, while the matrix executes the same filesystem workflow on Windows.

## Performance regression gates

`tests/performance.test.js` uses a 5,000-card synthetic index and compares the v0.2 prepared search path with the v0.1-compatible legacy path.

The test requires:

* every query to return the expected first card
* complete result checksum equality between search paths
* v0.2 elapsed time below the legacy elapsed time in the isolated query loop
* generated search index below the configured size limit
* RSS and heap use below configured limits

`tests/incremental.test.js` uses a multi-file source fixture and requires:

* no-op generation to parse zero files when stat hints match
* a one-file edit to parse exactly one file
* one-card semantic change to retokenize exactly one card
* full and incremental output to be byte-identical

The standalone `npm run benchmark:v0.2` command records timings but is not a hard CI gate because shared runner variance is too high. Its raw JSON and generated Markdown report preserve the exact environment and fixture.

## npm package gate

```sh
npm run smoke:pack
```

The smoke test creates the actual npm tarball, installs it in a clean temporary project, confirms zero runtime dependencies, and executes the installed `bin/llmnav.js` rather than importing source from the working tree.

This catches missing files in the package allowlist, broken executable paths, stale type or schema payloads, and package-only initialization failures.

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

Do not add a broad `src/**/*.ts` rule. It converts a selective navigation protocol into mandatory comment noise.

## Diagnostic policy

Errors block generation. Warnings do not block `check` by default.

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
| `LNV009` | exported API or effective configuration fingerprint drift |
| `LNV010` | non-canonical or stale generated representation |
| `LNV011` | parser or declaration attachment failure |
| `LNV012` | deleted or renamed ID lacks lifecycle handling |
| `LNV013` | card or repository comment budget exceeded |
| `LNV014` | search regression gate failure |

## Pull-request review

Review semantic card changes as contract changes, not harmless comments. A useful PR report is the JSON output from generation plus evaluation results.

Body-only changes should not force semantic text edits. Conversely, a changed invariant or externally visible role should not be hidden inside a body-only diff.

## Generated files

Commit `.llmnav/cache`. It is consumed by agents, diffable during review, and verified deterministically.

Do not commit `.llmnav/state`, `.llmnav/.transactions`, or `.llmnav/generation-transaction.json`. They contain volatile acceleration or interrupted-operation state.

Do not manually edit generated cache files. Manual edits fail manifest or generation verification and are replaced on the next successful transaction.
