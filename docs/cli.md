# CLI reference

## Global behavior

Repository commands accept `--root <path>`. Without it, the CLI searches ancestors for `.llmnav`; when none exists, it falls back to the nearest `package.json` or `.git` boundary. The repository-independent `tools` command does not accept a root.

Commands with structured results accept `--json`.

| Status | Meaning |
| ---: | --- |
| 0 | success |
| 1 | validation, generation, evaluation, integrity, or lookup failure |
| 2 | invalid command usage |
| 86 | test-only injected process interruption during a cache transaction |

Unknown options, missing option values, and invalid integer values fail instead of being ignored.

## `llmnav init`

```sh
llmnav init [--agents <adapters>] [--package-scripts] [--force]
```

Creates project configuration, schema, registry, lexicon, evaluation file, agent protocol, deterministic cache, volatile state ignore rules, and transaction ignore rules.

`--agents` accepts `agents`, `claude`, `copilot`, `cursor`, a comma-separated combination, `all`, or `none`. The default is `agents`.

`--package-scripts` adds `llmnav:audit`, `llmnav:check`, `llmnav:format`, `llmnav:generate`, and `llmnav:eval` to an existing package.json. The audit script gates only high-priority candidates.

`--force` refreshes configuration templates, schema, managed agent blocks, and `.llmnav/.gitignore`. It never resets semantic ID history, catalog order, aliases, evaluation cases, or source cards.

## `llmnav audit`

```sh
llmnav audit [--summary] [--output path] [--fail-on none|high|medium|low] [--json]
```

Reads the selected source set and ranks files that lack file or module cards. Signals include root and nested-package entrypoints, public re-exports, generated command/route/schema/migration/event boundaries, Rust/Tauri runtime boundaries, import fan-in, exported declarations, and source size. Declaration files are omitted; dependency caches, test support code, broad utilities, and pure re-export barrels are excluded or penalized. Candidates whose penalties reduce their score to zero are omitted.

The command never modifies source, configuration, registries, or generated caches. Its output is advisory and exits with status 0 by default. `--fail-on high` fails only for high candidates; `medium` fails for high or medium; `low` fails for any candidate. Invalid thresholds exit with status 2.

JSON output uses schemaVersion 1, repository-relative paths, deterministic ordering, explainable `reasons` and `signals`, and a path-specific `suggestedCoverageRule` for high and medium candidates. Reviewed `audit.dispositions` appear separately as `suppressed` or `stale`; only active candidates participate in `--fail-on`. Stale reasons are `file-not-scanned`, `already-carded`, or `not-a-candidate`. `--summary` omits candidate and disposition details but retains their counters. `--output <path>` writes the selected report inside the repository and emits only a compact confirmation envelope to stdout; escaping paths and symbolic-link traversal are rejected. Suggestions require human or agent review: LLMNav cannot infer a durable role, ownership boundary, invariant, or semantic ID from structure alone.

## `llmnav explain`

```sh
llmnav explain <file> [--json]
```

Explains one repository-relative or repository-contained absolute file path without modifying the repository. The result distinguishes active candidates, reviewed suppressions, direct cards, package-level module coverage, files with no ranked audit signal, files excluded from the scanned source set, and stale dispositions. Candidate results retain the audit's representative path, priority, score, reasons, signals, and suggested coverage rule; this matters for Go packages, where the requested file and representative candidate can differ.

The recommendation is deliberately bounded. It may ask for card review, disposition review, stale-disposition cleanup, or no action, but it never invents a semantic ID or writes a source comment. A file outside the repository or an invalid positional argument exits with status 2. A valid path that is not in the scanned source set returns its explanation and exits with status 1.

## `llmnav check`

```sh
llmnav check [paths...] [--format text|json|github|sarif|editor]
```

Validates syntax, canonical key order, required fields, IDs, role quality, search phrase limits, controlled effects and risks, relation targets, registry consistency, configured coverage, block size, comment ratio, and symbol attachment.

Passing paths restricts source parsing, but project-level relation and registry checks are most reliable on a full scan.

`--format github` emits workflow commands suitable for GitHub Actions annotations.

`--format sarif` emits a deterministic SARIF 2.1.0 log with one rule per LLMNav diagnostic code and repository-relative artifact locations. The command exit status still depends on LLMNav errors, not on the selected serialization.

`--format editor` emits schemaVersion 1 documents with repository-relative paths, zero-based ranges, numeric and textual severity, code, source, and message. Editors bind paths to workspace URIs themselves.

## `llmnav format`

```sh
llmnav format [paths...] [--check]
```

Canonicalizes key order, list serialization, spacing, and terminators. The formatter refuses to rewrite malformed cards, unknown fields, overlapping blocks, or duplicate scalar fields.

`--check` reports files that would change and exits with status 1 without writing.

## `llmnav generate`

```sh
llmnav generate [--check] [--full] [--json]
llmnav index [--check] [--full] [--json]
```

`index` remains an alias for `generate`.

Generation performs these operations:

1. Recover an interrupted cache transaction when a journal exists.
2. Reuse unchanged parsed files from `file-state.json`.
3. Parse changed files and validate the complete project.
4. Reuse unchanged card search documents from `search-index.json`.
5. Build every deterministic artifact in memory.
6. Write and verify a complete staging cache.
7. Replace the live cache through a recoverable directory transaction.
8. Persist volatile stat hints after the deterministic cache commits.

`--check`, also accepted as `--verify`, performs no writes and fails when generated artifacts differ. It still validates whether a pending transaction must be recovered before reading the cache.

`--full` bypasses `file-state.json`, `search-index.json`, and `graph-state.json` accelerators and rebuilds every derived artifact from canonical source. CI, release, and trust-boundary verification should use `--full --check`; incremental mode remains the default for local iteration.

Generation stops before cache mutation when semantic validation contains errors.

### JSON output

```json
{
  "ok": true,
  "changedFiles": [],
  "changedCards": [],
  "affectedCatalogs": [],
  "incremental": {
    "enabled": true,
    "files": {
      "totalFiles": 120,
      "parsedFiles": 1,
      "reusedFiles": 119,
      "reusedFilesByStat": 119,
      "reusedFilesByHash": 0,
      "deletedFiles": 0,
      "bytesRead": 824,
      "cardsParsed": 2,
      "cardsReused": 418
    },
    "cards": {
      "totalCards": 420,
      "reusedCards": 419,
      "indexedCards": 1,
      "removedCards": 0,
      "changedIds": ["billing.credit.reserve"],
      "removedIds": []
    },
    "graph": {
      "totalPartitions": 420,
      "reusedPartitions": 419,
      "rebuiltPartitions": 1,
      "removedPartitions": 0
    }
  },
  "transaction": {
    "committed": true,
    "skipped": false,
    "recovered": false,
    "recoveryAction": "none"
  },
  "diagnostics": []
}
```

`changedCards` is sorted by semantic ID. Each record identifies `added`, `modified`, or `removed` and lists changed `semantic`, `structure`, and `body` hash dimensions.

`affectedCatalogs` contains only repository, module, agent-context, or prompt-prefix catalogs whose generated bytes changed. Generic cache files remain visible through `changedFiles`.

A no-op generation returns zero parsed files, zero indexed cards, and `transaction.skipped=true` when volatile stat hints are available and current.

## `llmnav query`

```sh
llmnav query "<task language>" [--top <n>] [--json]
```

Ranks cards using exact ID matching, multilingual aliases, pre-tokenized deterministic posting lists, inverse document frequency, exact phrase bonuses, and one-hop semantic relation expansion.

Only query text is tokenized per invocation. Card fields are read from `search-index.json`. A missing or incompatible search index is rebuilt in memory from the v0.1-compatible `index.json`.

The ranker uses no network calls, embeddings, model API, MCP server, or hosted service. `--top` is bounded from 1 to 100.

Before reading the cache, `query` waits for an active generation lock and then recovers an abandoned transaction if necessary. It never rolls back a live writer or observes an uncommitted cache as authoritative.

## `llmnav show`

```sh
llmnav show <semantic-id> [--json]
```

Prints one compact card. Redirected registry IDs resolve to their active target. Qualified and unique external workspace IDs resolve to generated graph definitions when no local card exists. Ambiguous unqualified workspace IDs fail and report the qualified candidates.

## `llmnav context`

```sh
llmnav context <semantic-id> [--depth <n>] [--budget <tokens>] [--max-edges <n>] [--json]
```

Resolves redirected IDs, traverses confidence-ordered outgoing and incoming graph edges breadth-first, and emits cards until the approximate token budget is reached. `--max-edges` defaults to 24 and can be set to zero to disable graph edge traversal. When no compatible graph is available, source-card semantic relations remain the fallback.

Depth defaults to 1 and is bounded from 0 to 8. Budget defaults to 2,500 approximate tokens and is bounded from 128 to 100,000. The root card is retained even when it must be truncated.

## `llmnav eval`

```sh
llmnav eval [--file <queries.jsonl>] [--top <n>] [--json]
```

Runs records in this format:

```json
{"query":"task language","expected":["one.id","another.id"]}
```

Reports Recall@1, Recall@5, and mean reciprocal rank. Gates come from `.llmnav/config.json`. The selected query file must remain inside the repository and cannot traverse a symbolic link.

An empty query file succeeds with zero metrics. It is not evidence of search quality.

## `llmnav doctor`

```sh
llmnav doctor [--json]
```

Checks:

* configuration and Node.js version
* interrupted transaction recovery
* required control and generated files
* primary index and inverted-index consistency
* file-state schema compatibility
* manifest hashes
* generated-file drift against a full source rebuild
* unreplaced release metadata in the LLMNav repository itself

`doctor` may perform transaction recovery, but it does not regenerate stale cache content.

## `llmnav migrate`

```sh
llmnav migrate [--check] [--json]
llmnav migrate --write [--json]
```

The default and `--check` modes inspect the primary index, search accelerator, file state, graph, graph state, prompt-prefix bundle, and manifest against the formats supported by the installed LLMNav version. They also perform a full source reconstruction in check mode. No generated artifacts are committed. Exit status 1 means migration is required or source validation blocks a safe migration.

`--write` first builds the same plan from canonical source. If source validation succeeds and migration is required, it performs a full regeneration through the normal generation lock, staging verification, directory transaction, rollback, and interrupted-process recovery boundaries. It never rewrites source cards or reassigns semantic IDs. Repeating `--write` after a successful migration makes no changes and exits successfully.

`--check` and `--write` are mutually exclusive. Review JSON `formats`, `changedFiles`, and `diagnostics` before applying an upgrade in automation.

## `llmnav spec`

```sh
llmnav spec [--json]
```

Prints the active source specification version, canonical key order, stability values, effect vocabulary, risk vocabulary, and semantic relation types. The package version is separate from the `llmnav/1` source grammar version.

## `llmnav tools`

```sh
llmnav tools [--json]
```

Prints the fixed provider-neutral tool definitions for `query`, `show`, `context`, and `check`. JSON output wraps the ordered definitions in a schemaVersion 1 object. Tool inputs reject unknown fields and never accept a repository root; a trusted host binds repository scope when it calls the library dispatcher.

## `llmnav bundle`

```sh
llmnav bundle [--json]
```

Loads `.llmnav/cache/prompt-prefix.json`, rejects incompatible or manifest-mismatched content, and prints its package, repository, and module cache partitions. Text output is a compact ID, scope, estimated-token, and hash summary. JSON output returns the complete deterministic bundle including partition content.

## `llmnav editor`

```sh
llmnav editor vscode
```

Prints a schemaVersion 1 editor integration envelope containing a VS Code `tasks.json` configuration. The command is repository-independent and does not write `.vscode` files. Merge the returned task into an existing configuration when necessary.
