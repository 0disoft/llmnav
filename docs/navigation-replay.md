# Historical navigation replay pilot

## Result

On 2026-09-08, six curated historical changes were replayed against runtime commit `d30d80015ea10ea43a0875bc329669fa4019a457`. Both methods included the expected source file in their first five candidates for all six cases. LLMNav ranked four expected files first; the regex baseline placed one first in alphabetical file order. These are different ordering policies, not an agent success-rate comparison.

| Historical task | Source change | Expected source | Regex rank / candidates | LLMNav rank / candidates |
| --- | --- | --- | ---: | ---: |
| Filesystem capability required by generation locking | `5b0d837` | `src/transaction.js` | 2 / 2 | 2 / 20 |
| Context still follows edges at a zero edge limit | `34f56a6` | `src/search.js` | 4 / 4 | 2 / 23 |
| Explain suppressed annotation-audit candidates | `592849f` | `src/audit.js` | 3 / 6 | 1 / 17 |
| Resolve a Go module import to its package | `fcd40cb` | `src/module-resolution.js` | 3 / 3 | 1 / 23 |
| Upgrade generated formats without partial cache state | `839ab1c` | `src/migration.js` | 5 / 6 | 1 / 25 |
| Remove repeated posting scans during sharding | `d30d800` | `src/search-shards.js` | 1 / 1 | 1 / 23 |

Candidate counts include the complete positive-result list, not just the first five displayed paths. LLMNav returns more broad matches, while known technical keywords can narrow regex discovery much further. The two non-first LLMNav results put `src/audit.js` ahead of the locking implementation and `src/graph.js` ahead of the context-limit implementation. No query, expected target, annotation, or rank weight was tuned after this run.

## Reproduce

From the Git repository, run:

```sh
node benchmarks/navigation-replay.js
```

The script performs no model calls, network requests, source edits, or cache generation. It requires an existing generated LLMNav index and the referenced Git history. Expected targets must both exist in current source and occur in the cited historical change. The output includes source, harness, and case hashes so a rerun can distinguish changed inputs from changed ranking. Refresh the index through the normal generation workflow before comparing a later source revision.

Both output scopes contain 37 tracked JavaScript files under `src/` and `bin/`. The baseline performs one fixed case-insensitive line-regex search per case and sorts matching paths alphabetically. LLMNav performs one query, preserves score order, deduplicates paths, and restricts output to that same source scope. Its scoring still uses the complete repository index before filtering. Source annotations remain visible to the baseline. The script refuses a truncated 100-card result instead of treating hidden hits as misses.

Input identities for the recorded run:

```text
harness 706834dc4a0faf0b5111f11dc854d929f5c84a4b6757542bd3a98041d0b47f33
cases   c23e467540d03544a68a4ffabc9cb4c91c2ecea87f655f6e3b55257adf404364
source  2a8e5f8e2bff1f6236bd2117998d134a44cacb728d1667a5f3fb747a7fff8c7b
```

## Evidence boundary and decision

The cases are author-curated English paraphrases of known changes, not verbatim user requests, representative traffic, Korean-language coverage, or a sealed holdout. They run on already corrected current source, not the pre-fix repository. The author knew the expected paths while constructing both symptom queries and regexes. This is a diagnostic retrieval pilot, not a claim that LLMNav outperforms a developer adaptively using `rg`.

Each method performs one search per case, but actual agent tool calls, files opened, uncached tokens, elapsed task time, edit correctness, and task completion are **unmeasured** and reported as `null`, not inferred from candidate rank. No full agent trace was captured. The pilot therefore does not complete the end-to-end evaluation described in [benchmarking](benchmarking.md).

The existing changes were delivered and their Windows/Linux CI passed before this pilot. No runtime optimization is added on the strength of these results: they do not establish that `show` or `context` latency blocks development work. Further session lookup caching and shard-memory work remain deferred. The existing ranking and substring-search behavior are unchanged.
