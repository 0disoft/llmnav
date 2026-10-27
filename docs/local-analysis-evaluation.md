# Additional languages and local evidence: measured costs

These are Windows x64 script observations on Node 24.18.0, TypeScript 6.0.3 and Python 3.14.6. They measure elapsed time and compact UTF-8 JSON bytes, not actual model tokens or completed agent tasks. Raw observations are in [local-analysis-results.json](local-analysis-results.json).

Reproduce from the repository root with installed tooling:

```sh
node --test tests/additional-languages.test.js tests/git-history.test.js tests/verification.test.js
node benchmarks/local-analysis.js docs/local-analysis-results.json
```

The benchmark creates disposable projects and a temporary Git repository. It does not execute fixture applications, install tools, use a model, or change the working repository's Git state. Each case runs once with metadata disabled, once enabled, then updates a source and reruns analysis/generation. Baseline here means the same adapter without metadata, not an older release. Startup and filesystem caches affect timings; the order is not randomized and no speedup is inferred.

## Language support and checked facts

| Language | Analysis source | Supported facts | Limits |
| --- | --- | --- | --- |
| TypeScript | existing compiler API | named types, members, parameters, signatures, resolved references | computed/private-identifier names, constructors and destructuring are not separate definitions |
| JavaScript | same compiler API with JS checking | named functions/classes/members, JSDoc types, inferred literals, static references | implicit any parameters remain unknown; same declaration limits as TypeScript |
| Go | existing AST/type checker | named types, fields, receiver methods, parameters, static references | platform/build selection; tests and cgo excluded |
| Python | isolated standard AST | classes, functions/async methods, class fields, explicit annotations, named parameters and lexical ownership | no type checking, instance assignments, import/call resolution or decorator execution |
| Rust | conservative built-in lexical extractor | named structs/enums/traits, inline modules, named fields, functions/trait methods, parameters, simple local impl owners | not a complete parser; no type checking, macros/cfg/import resolution, generic impl owners, tuple fields or enum payloads |

Existing TypeScript/Go regressions remain part of the required checks. [Their previous measurement protocol](code-metadata-evaluation.md) is separate. New measurements use a JavaScript fixture, copied production `src/tokenizer.js`, a Python fixture and a Rust fixture. Source cards are stripped from the copied JS input, leaving its implementation intact; hashes identify the exact analyzed bytes.

Each case checks four selected facts: target declaration presence, parameter type, parameter type origin and signature presence. All 16 selected facts matched. This is a small correctness sample, not a language-wide accuracy rate. Additional tests reject syntax errors, check strict JavaScript configuration, preserve unknown types, reject stale sources, and ensure Python source is never executed. Rust fixtures reject comment/string/macro false positives and exercise generic tuple types, lifetimes and unresolved ownership. Python/Rust expose syntax precision and partial metadata throughout saved discovery.

## Analysis and storage observations

| Input | Definitions | Analysis without/with metadata (ms) | Graph without/with metadata (bytes) | Default/detailed show (bytes) |
| --- | ---: | ---: | ---: | ---: |
| JS fixture | 3 | 2,044 / 1,911 | 1,058 / 1,759 | 1,023 / 1,764 |
| JS production tokenizer | 15 | 2,248 / 2,195 | 8,084 / 11,469 | 1,063 / 1,813 |
| Python fixture | 6 | 710 / 572 | 1,696 / 3,126 | 1,015 / 1,835 |
| Rust fixture | 6 | 18 / 13 | 1,691 / 3,153 | 1,005 / 1,824 |

After a source edit, complete language reanalysis took approximately 1,925 / 2,114 / 602 / 11 ms respectively. Generation after that edit took 182 / 177 / 179 / 174 ms. Metadata increases storage and detailed output; it remains opt-in. A known ID needs one detail call. This does not compare task discovery paths or prove that fewer navigation calls are needed. Default navigation continues to omit metadata and local evidence.

The synthetic case contains one type and 50,000 fields. The whole graph is 14,266,945 bytes; one five-member page is 1,418 bytes. Building the index and the first page took 228 ms; 100 subsequent five-member page requests took 5.73 ms total. Enumerating every field still needs at least 10,000 calls at this page size. Large shared graphs still cost memory/loading time; paging reduces delivered output, not the resident graph size. These byte ratios are not token savings.

## History and verification observations

The temporary Git repository's first file-history lookup took 648 ms and its repeat took 522 ms; the summary was 546 bytes. Last-change lookup is cached, but working state and fingerprints are refreshed. The retained subprocess cost makes explicit, on-demand history preferable to attaching it to every navigation result.

Capturing one source snapshot took 8.50 ms, recording a receipt 21.40 ms, and reading its summary 7.76 ms. Receipt content was 620 bytes; the summary was 388 bytes. The fixture deliberately records `outcome: "unknown"`, rather than claiming a benchmark is a test pass. Declared complete inputs initially matched; changing the source made applicability stale. Separate tests cover parallel writes, tampering, missing evidence, incomplete coverage, renames/deletions and unborn/non-Git repositories.

File history remains file-scoped and best-effort. Verification is caller-reported and scoped to explicit files, not independent certification or function coverage. Toolchain changes require rerunning analysis; Python/Rust do not evaluate project build configuration. Further compiler adapters and incremental analysis should be added only after a representative workload shows that their precision or update savings justify the maintenance cost.

## Local verification

`npm run check` passed all 388 tests, source lint, semantic validation (71 cards, zero errors/warnings) and full generated-artifact freshness. `npm pack --dry-run --json` passed for version 0.19.0 with 105 packaged entries and zero bundled dependencies. Retrieval evaluation passed 42 queries: recall at 1 was 41/42 and recall at 5 was 42/42. No push, tag or deployment is part of this change.
