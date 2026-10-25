# Real TypeScript and Go navigation pilot

Measured on 2026-10-23 with LLMNav 0.15.1, Windows x64 and Node v24.18.0. The [raw report](../benchmarks/results/real-navigation-0.15.1.json) records corpus, plan, harness and selected engine-source hashes, compiler versions, individual candidates and timings. The [task plan](../benchmarks/real-navigation-cases.json) contains the eight reviewed answers.

## Scope and reproduction

```sh
node benchmarks/real-navigation.js --typescript-root <buildmarks-root> --go-root <GOROOT/src/go/token> --output <report.json>
```

The harness copies production sources into disposable repositories. It never annotates or edits the originals, and verifies original source hashes before returning results. Both original-corpus checks passed.

| Corpus | Provenance | Scope | Files | Source bytes | Compiler |
| --- | --- | --- | ---: | ---: | --- |
| Buildmarks | `4884a072fc847223c4d27db843f0338d8a0de4e6` | `src/scoring`, `src/shared` | 13 | 67,253 | TypeScript 6.0.3 |
| Go standard library | Go 1.26.4 | `go/token`, production files | 4 | 38,125 | go/types 1.26.4 |

Each corpus has four identifier/receiver-name tasks. Conditions are fixed-string `rg`, ordinary live-source `discover`, and compiler-backed `discover --precise`. Condition order rotates by task. Each lookup requests at most five candidates; the harness opens each distinct candidate file until reaching the answer or exhausting the list.

`file@1` and `file@5` use deduplicated file rank. `definition@1` and `definition@5` require the exact physical declaration line. `rg` returns matching lines, including comments and uses, so its definition score measures this fixed command rather than an expert's subsequent search strategy. Its candidates are sorted by path and line for repeatability.

## Observations

| Corpus | Condition | file@1 | file@5 | definition@1 | definition@5 | Median lookup, ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| TypeScript | rg | 3/4 | 4/4 | 1/4 | 4/4 | 92.29 |
| TypeScript | discover | 4/4 | 4/4 | 4/4 | 4/4 | 81.02 |
| TypeScript | precise | 4/4 | 4/4 | 4/4 | 4/4 | 94.43 |
| Go | rg | 3/4 | 4/4 | 0/4 | 2/4 | 95.38 |
| Go | discover | 4/4 | 4/4 | 4/4 | 4/4 | 39.24 |
| Go | precise | 4/4 | 4/4 | 4/4 | 4/4 | 56.90 |

| Corpus | Condition | Lookup + file-read operations, total | Inspected source bytes, total |
| --- | --- | ---: | ---: |
| TypeScript | rg | 9 | 22,530 |
| TypeScript | discover / precise, each | 8 | 9,037 |
| Go | rg | 9 | 90,671 |
| Go | discover / precise, each | 8 | 69,633 |

These operation counts simulate lookup and file inspection; they are not captured model tool calls. Inspected bytes count whole files opened by the harness, separately from bytes scanned internally by discovery. They are not token usage. Individual response bytes and time to first correct file are retained in the raw report.

| Corpus | Compiler analysis + generation, s | Reanalysis + generation after an edit, s | Stale input rejected | Asserted call bindings |
| --- | ---: | ---: | --- | ---: |
| TypeScript | 3.758 | 3.495 | yes | 4/4 |
| Go | 4.782 | 4.345 | yes | 2/2 |

The maintenance edit adds an isolated function in a temporary copy. Setup excludes copying and configuration creation. Precise lookups include graph loading and freshness validation; ordinary discovery does not require that graph.

## Product decision

Keep ordinary discovery as the default for finding unannotated identifiers. It reached the same answers here with less work and no compiler setup. This sample gives no reason to change search ranking weights.

Use precise analysis when a task needs compiler-bound imports, shadowing, receiver methods, or caller/reference context. The six checked call bindings passed. Focused regression tests additionally cover TypeScript receiver references and wrapped callees, Go local initializer ownership and generic calls, and the CLI analysis-to-discovery flow. Those are correctness benefits; this pilot does not establish a retrieval-ranking advantage for precise mode.

The subsequent [controlled coding pilot](model-coding-evaluation.md) solved 8/8 tasks in each of the baseline, ordinary LLMNav and Serena conditions. LLMNav did not reduce reported uncached input against baseline in those small repairs. Better identifier ranks here therefore do not justify mandatory semantic navigation for every coding task or a token-savings claim.

## Evidence still held

This is one author-reviewed, eight-case retrieval pilot on two small scopes. It is not a sealed holdout, natural-language workload, large-monorepo stress test, or repeated latency experiment. Filesystem caches were not flushed. `rg` includes child-process launch costs, whereas discovery uses its JavaScript API in the harness process; elapsed times do not establish a universal speed comparison or an MCP round-trip cost.

The [Serena follow-up](serena-comparison.md) now records semantic lookup on these same corpus and task-plan hashes. [Actual model coding outcomes](model-coding-evaluation.md) are recorded separately and must not be inferred from this retrieval pilot. Human card-authoring and maintenance time remain unmeasured. The copied sources have no semantic cards. A competitive score cannot be inferred from these ranks.

The earlier local reports were excluded after correcting `./` path normalization and the even-sample median calculation. Only the final 0.15.1 report is used above.
