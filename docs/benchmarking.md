# Benchmarking navigation impact

## Two benchmark layers

LLMNav measures two different things.

The repository retrieval layer asks whether a task query reaches the correct semantic card quickly and without excessive memory.

The end-to-end agent layer asks whether the coding agent opens less irrelevant source, uses fewer uncached tokens, and still completes the task correctly.

Do not substitute one layer for the other.

## Built-in v0.2 regression suite

Run:

```sh
npm test
```

The large synthetic search test creates 5,000 indexed cards and 50 deterministic queries. It compares the v0.2 prepared inverted-index path with the v0.1-compatible legacy path.

It requires:

* expected first result for every query
* identical ranked-result checksum
* lower elapsed time for the isolated v0.2 query loop
* bounded generated search-index bytes
* bounded RSS and heap use

The incremental source fixture requires a no-op run to parse zero files, a one-file edit to parse one file, and a one-card semantic edit to retokenize one card. It then forces a full rebuild and compares deterministic output bytes.

These tests are regression gates. They do not claim a universal speedup on every repository or machine.

## Reproducible v0.2 measurement

Run:

```sh
npm run benchmark:v0.2
```

The command creates a temporary synthetic repository with 1,000 source files and 5,000 cards by default. It records:

* cold initial generation
* one-file incremental regeneration
* the same change through forced full regeneration
* no-op incremental regeneration
* byte equality between incremental and full cache trees
* fresh-process v0.1-compatible query timing
* fresh-process v0.2 inverted-index query timing
* median and p95 query latency
* RSS, heap, index bytes, and search-index bytes
* exact result checksum equality

The benchmark writes raw JSON under `benchmarks/results/` and regenerates `docs/performance-v0.2.md`.

Environment variables can reduce or expand the fixture during development:

```sh
LLMNAV_BENCH_FILES=500 LLMNAV_BENCH_QUERY_RUNS=5 npm run benchmark:v0.2
```

Published repository results use the defaults. The report states that each query starts a fresh Node.js process and that the operating-system filesystem cache is not flushed. That distinction prevents a warm page cache from being mislabeled as cold disk I/O.

## Graph-aware session lifecycle

`npm run benchmark:navigation` generates a temporary 100-file repository with 1,000 cards and three outgoing semantic relations per card. A fresh worker process measures initial session loading, the first query, 50 repeated queries, 50 bounded graph-context requests, and refresh with unchanged source. Three direct `queryProject` calls provide a filesystem-loading comparison. The report includes medians, p95, memory, operation counters, fixture sizes, and result digests.

The operating-system filesystem cache is not flushed. Module import and process launch costs are excluded from `initialSessionMs` but included in the total `workerWallMs`, which also includes reference checks. Fixture generation is outside both measurements. Query scores and reasons must match the direct graph-aware index path; context must include the requested root and graph evidence within its edge and token limits. CI uses a 100-card fixture to validate these contracts without imposing a machine-specific timing threshold.


### Local baseline before session metadata preparation

Measured on 2026-09-07 with runtime source based on `5b0d837`: Windows x64, Node v24.18.0, AMD Ryzen 5 7430U with Radeon Graphics. This is one local run with an unflushed filesystem cache, not a production latency guarantee.

| Phase | Median or single sample (ms) | p95 (ms) |
| --- | ---: | ---: |
| Initial session load | 141.335 | — |
| First query | 11.113 | — |
| Repeated session query (50) | 3.859 | 7.833 |
| Repeated session context (50) | 2.870 | 5.484 |
| Refresh unchanged source | 70.303 | — |
| Direct query with disk loading (3) | 90.443 | 120.859 |

All 50 query rankings, scores and reasons matched the direct index path. All 50 contexts met the graph and token bounds. Query work still included 50,000 ID scans and 50,000 phrase-document scans; caching adjacency does not eliminate those passes.

Result digests for comparison with subsequent optimization:

```text
query   d7545f3781f705eb2fdb5c7deb14004c7d74f1b9fc81fb21314e00f3f276e272
context 051db2dc2b802eca7a5b3a04a08c38b447ba95659ebc2a8eef2e9b6fb0e1207b
```

### Local session metadata result

On the same fixture and environment, one local run after session metadata preparation measured query median/p95 at 2.883/5.796 ms, with identical query and context digests above. Across 50 queries, ID normalizations, lookup-table builds, and graph validations were all zero; ID and phrase scans remain 50,000 each. The optimization does not narrow substring candidates or change ranking.

Initial loading was 159.667 ms, first query 21.485 ms, refresh 114.610 ms, context median/p95 3.617/8.979 ms, and direct-query median 102.542 ms. Preparation shifts work to loading/refresh and result detachment adds copying. These single-run timings include local load variation; they establish neither a startup improvement nor a production speed guarantee.

## Measurement integrity

A benchmark result is accepted only after these checks pass:

```text
legacy expected result count equals query count
inverted expected result count equals query count
legacy and inverted result checksums match
incremental and full generated cache trees are byte-identical
reported fixture cardinality matches generated files and cards
```

Wall-clock speed is reported exactly as measured. It is not used to invent a speedup estimate for other hardware.

## Repository search evaluation

Add real task descriptions to `.llmnav/eval/queries.jsonl`.

```jsonl
{"query":"duplicate webhook applies payment twice","expected":["billing.payment.apply-provider-event"]}
{"query":"same collapse seed produces a different arena","expected":["game.arena.collapse-sequence"]}
```

Run:

```sh
npx llmnav eval --json
```

Track at least Recall@1, Recall@5, and mean reciprocal rank. Record every acceptable target ID when a task has multiple valid entry points.

## Cross-repository conformance matrix

Run the checked-in read-only matrix from a workspace that contains the configured sibling repositories:

```sh
node benchmarks/run-conformance.js
```

Use `--matrix <path>` to select another checked-in matrix and `--output <path>` to retain a JSON report. The report schema is `benchmarks/conformance-report.schema.json`.

Each repository keeps its own validation counts, retrieval thresholds, Recall@1, Recall@5, MRR, audit summary, repeatability result, and generated-cache freshness result. The harness deliberately does not average retrieval scores across repositories. A large or easy dataset must not hide a failing repository.

Verdicts have asymmetric meaning:

* `pass` requires valid cards, sufficient reviewed queries, repository thresholds, repeatable retrieval, and a source-current generated cache.
* `fail` requires a reproducible validation, retrieval, repeatability, cache-freshness, or measurement failure.
* `held` records missing adoption or insufficient reviewed cases without pretending that unmeasured language coverage passed or failed.

The default matrix currently measures LLMNav and Workduck. Go and Python remain held until their candidate repositories receive reviewed cards and task-language query datasets. Matrix output is navigation evidence, not an end-to-end claim about model tokens or coding-task success.

## End-to-end agent metrics

A successful deployment should reduce exploration cost without reducing task correctness.

| Metric | Meaning |
| --- | --- |
| first correct source time | elapsed time until the agent opens the right declaration |
| files opened | breadth of repository exploration |
| search tool calls | grep, glob, tree, language-server, and LLMNav calls |
| source lines read | code inserted into model context |
| uncached input tokens | new model input processed for the task |
| token cache ratio | cached input divided by total input |
| task success | tests and acceptance criteria pass |
| wrong-edit rate | edits made in an irrelevant boundary |

A request-level cache hit is not enough. Track cached tokens and uncached tokens separately.

## Experimental groups

Compare three configurations.

| Group | Configuration |
| --- | --- |
| `baseline` | current agent instructions and search tools |
| `comments-only` | source cards without generated query or catalog tools |
| `full` | cards, generated catalogs, inverted query, bounded context, and stable prompt placement |

The comments-only group exposes designs that merely add prompt tokens without improving navigation.

## Task set and repetition

Use 30 to 50 historical tasks when possible. Mix bug fixes, feature additions, API changes, refactors, performance work, test failures, migrations, and cross-module workflows.

Agent execution is variable. Repeat tasks with the same model, reasoning configuration, tools, repository state, and timeout policy. Report medians and failure ranges rather than one favorable run.

## Initial deployment gates

These are targets to validate per repository, not measured package guarantees.

| Metric | Initial target |
| --- | ---: |
| Recall@1 | at least 0.75 |
| Recall@5 | at least 0.90 |
| median first correct symbol calls | at most 2 navigation calls |
| median files opened | at most 4 |
| uncached input tokens | at least 40% below baseline |
| first correct symbol time | at least 35% below baseline |
| task success | no decrease from baseline |
| stale semantic metadata failures | zero |

## Failure analysis

Classify every miss before changing ranking weights.

```text
missing card
weak or generic role
missing task-language alias
overloaded search phrase
wrong module boundary
missing semantic relation
declaration attachment failure
generated cache stale
lexical ranker limitation
task legitimately requires broader structural analysis
```

Only measured lexical failures justify adding a more complex retrieval layer.
