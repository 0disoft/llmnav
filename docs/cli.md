# CLI reference

## Global behavior

All commands accept `--root <path>`. Without it, the CLI searches all ancestors for `.llmnav`; when none exists, it falls back to the nearest `package.json` or `.git`. This keeps monorepo package boundaries from hiding the repository-level LLMNav configuration.

Commands that produce structured results accept `--json`.

Exit status 0 means success. Status 1 means validation, generation, evaluation, or lookup failure. Status 2 means invalid command usage.

## `llmnav init`

```sh
llmnav init [--agents <adapters>] [--package-scripts] [--force]
```

Creates project configuration, schema, registry, lexicon, evaluation file, agent protocol, and generated cache.

`--agents` accepts `agents`, `claude`, `copilot`, `cursor`, a comma-separated combination, `all`, or `none`. The default is `agents`. Unknown adapter names fail instead of being ignored.

`--package-scripts` adds `llmnav:check`, `llmnav:format`, `llmnav:generate`, and `llmnav:eval` to an existing package.json.

`--force` refreshes the configuration template, schema, managed agent blocks, and control ignore file. It never resets `ids.jsonl`, `order.lock`, `lexicon.json`, evaluation queries, or source cards.

## `llmnav check`

```sh
llmnav check [paths...] [--format text|json|github]
```

Validates syntax, canonical key order, required fields, IDs, role quality, search phrase limits, controlled effects and risks, relation targets, registry consistency, configured coverage, block size, comment ratio, and symbol attachment.

Passing paths restricts the source scan, but project-level relation and registry checks are most reliable on a full scan.

`--format github` emits workflow commands suitable for GitHub Actions annotations.

## `llmnav format`

```sh
llmnav format [paths...] [--check]
```

Canonicalizes card key order, list serialization, spacing, and terminators. The formatter refuses to rewrite malformed cards, unknown fields, overlapping blocks, or duplicate scalar fields, so a typo cannot silently erase metadata.

`--check` reports files that would change and exits with status 1 without writing.

## `llmnav generate`

```sh
llmnav generate [--check]
llmnav index [--check]
```

`index` is an alias for `generate`.

Generation updates the ID registry with new active IDs, appends new IDs to `order.lock`, and rebuilds `.llmnav/cache` deterministically.

`--check`, also accepted as `--verify`, performs no writes and fails when generated artifacts differ.

Generation stops when semantic validation contains errors.

## `llmnav query`

```sh
llmnav query "<task language>" [--top <n>] [--json]
```

Ranks cards with deterministic field weights, inverse document frequency, exact ID matching, multilingual aliases, exact phrase bonuses, and one-hop relation expansion.

The current local ranker uses no network calls, embeddings, or model API. `--top` is bounded from 1 to 100.

## `llmnav show`

```sh
llmnav show <semantic-id> [--json]
```

Prints one compact card. Redirected registry IDs resolve to their active target. Replaced records resolve to the first replacement only for navigation convenience; callers that need every replacement should read JSON output or the registry.

## `llmnav context`

```sh
llmnav context <semantic-id> [--depth <n>] [--budget <tokens>] [--json]
```

Resolves redirected IDs, traverses outgoing and incoming semantic relations breadth-first, and emits cards until the approximate token budget is reached.

The default depth is 1 and the default budget is 2,500 approximate tokens. Depth is bounded from 0 to 8 and budget from 128 to 100,000. The root card is retained even when it must be truncated. The estimator is intentionally conservative and provider-independent.

## `llmnav eval`

```sh
llmnav eval [--file <queries.jsonl>] [--top <n>] [--json]
```

Runs query records in the form:

```json
{"query":"task language","expected":["one.id","another.id"]}
```

Reports Recall@1, Recall@5, and mean reciprocal rank. Gates come from `.llmnav/config.json`. The selected query file must remain inside the repository and cannot traverse a symbolic link.

An empty query file succeeds but produces zero metrics. CI should not treat an empty benchmark as evidence of search quality.

## `llmnav doctor`

```sh
llmnav doctor [--json]
```

Checks configuration, Node.js version, required control files, generated manifest hashes, generation drift, and unreplaced release metadata in the LLMNav repository itself.

## `llmnav spec`

```sh
llmnav spec [--json]
```

Prints the active source specification version, canonical key order, stability values, effect vocabulary, risk vocabulary, and semantic relation types.
