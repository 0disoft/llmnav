# Compiler metadata: scope and measured costs

LLMNav 0.17.0 extends the existing TypeScript and Go compiler adapters and graph import path. Metadata is opt-in because it adds analysis, storage and tool-prefix costs. It provides structured declaration facts; this experiment does not establish lower agent token consumption.

## Use

Configure the output in `.llmnav/config.json` before generating:

```json
{ "graph": { "indexFiles": [".llmnav/imports/typescript.json"] } }
```

```sh
llmnav analyze --language typescript --metadata --output .llmnav/imports/typescript.json
llmnav generate
llmnav discover "Store" --precise --top 1 --json
llmnav show <returned-id> --metadata --json
llmnav show <returned-id> --metadata --members --top 5 --offset 0 --metadata-budget 4000 --json
```

Go uses `--language go`; configure its own output path. Follow `metadata.nextOffset` without regenerating between pages. For a large callable, list direct parameter declarations; for a class/type, list fields and methods. Oversized records have `detailOmitted: true`. See [the contract](precise-analysis.md#opt-in-declaration-metadata) for budgets and snapshot freshness.

## Language support

| Language | This implementation | Explicit limits |
| --- | --- | --- |
| TypeScript | Compiler types, declared/inferred/unknown origins, overload signatures, named callable parameters, class/interface fields and methods, ownership and physical locations | Constructors, computed names and destructured bindings have no separate definition; overload metadata parameters describe the selected implementation/first declaration, while signatures describe public overloads |
| Go | Compiler types, functions, struct fields, receiver methods, named declarations, callable parameters including unnamed/variadic parameters, generic signatures, physical locations | Active production build only; cgo and test variants excluded; no runtime dispatch inference; unnamed parameters are represented within the callable |
| JavaScript | Existing heuristic discovery remains available | No new compiler metadata; existing TS adapter currently selects TS files only |
| Rust | Existing heuristic discovery remains available | No new compiler metadata |
| Python | Existing heuristic discovery remains available | No new compiler metadata |

Measured tooling: TypeScript 6.0.3, Go 1.26.4, Node 24.18.0, Windows x64. TypeScript adapter compatibility remains 5/6; this experiment exercised 6. The runtime npm dependency count remains zero. Compiler output never modifies reviewed semantic cards.

## Reproduce

```sh
node benchmarks/code-metadata.js benchmarks/results/code-metadata.json
node --test tests/code-metadata.test.js tests/analysis.test.js tests/graph-input.test.js
npm run check
npm pack --dry-run
```

The [machine-readable observations](../benchmarks/results/code-metadata.json) record source hashes, environment, timings, sizes, update work and limitations. Two alternating analysis runs per mode reduce order bias; tables show their median. Generation is full in both modes. Other timings are single observations affected by compiler and filesystem caches. These are measurements on one machine, not latency guarantees.

The real-code probes copy LLMNav's public TypeScript declarations and Go analyzer into temporary projects. The Go semantic card is removed to isolate the code from repository-specific card relations. All temporary projects are removed after the run. No package installation, application execution, provider API or model call is involved.

## Correctness and output

Four source probes check 23 explicit facts: parameter names/types/origins, signatures, selected fields, error-free status and receiver ownership. All 23 match. This covers those probes rather than every declaration or language feature. Metadata-disabled and enabled analyses preserve all definition IDs, locations and reference edges in the four inputs.

Regression tests additionally cover overloads, default/rest parameters, inference, erroneous/unknown types, stale-source rejection, schema 1/2 compatibility, exact UTF-8 budgets, pagination, session result detachment and CLI/MCP option validation. They compare default `query`, `discover`, `show` and `context` results before and after enabling metadata.

The full repository check passes all 380 tests. The repository retrieval corpus passes all 36 queries at top 5, with 35 at top 1. Before this feature (`ae62cf2`), 32 of the original 33 queries ranked first. Three new representative queries rank first; the original corpus retains its top-1 count. A validator search phrase was clarified after new metadata cards displaced an existing semantic-validation query, restoring its first-place result without changing the ranker.

| Input | Definitions | Default show, before / after | Metadata page | Total detailed show |
| --- | ---: | ---: | ---: | ---: |
| TS fixture | 6 | 1,047 / 1,047 B | 871 B | 1,930 B |
| LLMNav TS declarations | 1,349 | 1,069 / 1,069 B | 1,423 B | 2,504 B |
| Go fixture | 7 | 1,015 / 1,015 B | 828 B | 1,855 B |
| LLMNav Go analyzer | 205 | 1,031 / 1,031 B | 705 B | 1,748 B |

Detail lookup needs one show call after obtaining the ID. The script does not measure the number of steps an agent needs to find that ID or a baseline source excerpt. Comparing the detailed response with an entire source file would not establish a fair ordinary-navigation baseline.

## Analysis and storage

| Input | Analysis, disabled / enabled | Full generation, disabled / enabled | Cache bytes, disabled / enabled |
| --- | ---: | ---: | ---: |
| TS fixture | 2,176.562 / 2,132.835 ms | 175.604 / 154.455 ms | 30,315 / 35,779 |
| LLMNav TS declarations | 2,292.164 / 3,115.130 ms | 697.346 / 815.619 ms | 3,577,667 / 4,774,381 |
| Go fixture | 2,763.147 / 2,889.453 ms | 150.724 / 176.577 ms | 33,418 / 39,538 |
| LLMNav Go analyzer | 4,232.336 / 4,305.594 ms | 266.655 / 298.169 ms | 1,050,192 / 1,207,824 |

For real TS declarations the observed analysis increase is about 36%, with about 33% more cache bytes. For the real Go probe they are about 2% and 15%. Small differences between fixture timings are not evidence of faster analysis. Metadata is retained in generated graph/state artifacts, so default loading can cost more even when the response bytes are unchanged.

Unchanged incremental generation took 479.603 ms for the real TS probe and 201.300 ms for the real Go probe. After a source edit, full compiler reanalysis took 3,369.414 and 4,557.797 ms respectively; subsequent incremental generation took 860.324 and 456.925 ms. This implementation reuses existing graph partitions but does not add file-only incremental compiler analysis: dependencies and configuration can invalidate other declarations.

## Synthetic member lookup

For 50,001 generated definitions, including a type with 50,000 fields:

* A five-member page is 1,550 bytes; serializing all generated metadata is 15,578,067 bytes. These are JSON bytes, not model tokens.
* The first indexed page takes 187.933 ms. Another 100 identical page requests take 9.065 ms total; a simple linear count reference takes 258.181 ms for 100 requests. The reference only counts matching records, so it does less work per request than the indexed path.
* The first indexed lookup costs O(D + sorting); warm lookups use an owner Map and visit O(page size) records. Serialization work is bounded by the page size and byte policy, except for measuring an individual oversized record.
* Enumerating all fields with five-member pages still needs at least 10,000 calls. Partial retrieval helps when the caller knows which subset it needs; it is unsuitable for dumping the whole repository through many small calls.

The shared tool definition JSON grows by 620 bytes for the five optional show inputs. Hosts that always send all tool definitions pay that prefix cost even when metadata is unused. Provider caching and tokenization were not measured.

## Decision and later phases

Keep metadata opt-in. A caller needing only a known declaration's source can continue to use bounded source discovery/read operations. Enable metadata when repeated structured signature/member queries justify its analysis and storage overhead. A real-agent comparison remains necessary before claiming token or task-completion improvements.

Later features should preserve these boundaries:

* JavaScript: first examine selected-file handling and compiler `allowJs`/`checkJs` semantics. JS files can affect module resolution and freshness; adding only a file extension would provide incomplete invalidation and capability claims.
* Rust/Python: choose explicit optional tooling and publish a capability matrix before promising compiler-grade extraction. New toolchains, version handling and fixtures require separate work; this phase adds no installer or language server.
* Git history: use an optional local lookup layer, separate from deterministic generated structure. Start with file-level provenance and distinguish HEAD, index and worktree state. A per-symbol Git process would add O(symbols) subprocess calls; prefer batched file queries and content-aware caching. Shallow/no-Git repositories and ambiguous renames need explicit unknown states. File change dates must not become function change dates.
* Validation receipts: bind evidence to source/dependency/configuration hashes, test inputs, command and tool/environment identity. Record execution result separately from snapshot applicability (`matches`, `stale`, `unknown`). A repository test pass supplies no per-function coverage proof. The storage and collection contract needs a separate design before implementation.

Git history, validation receipts and new JS/Rust/Python compiler adapters are deferred. No push or release is part of this implementation.
