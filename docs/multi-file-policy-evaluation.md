# Multi-file policy repair evaluation

The six agent attempts repaired their assigned policy regressions. This experiment did **not establish a navigation cost advantage** for LLMNav: required semantic search increased total input and elapsed time, while its lower uncached input coincided with a higher cache share.

## Work and controls

The corpus is copied production JavaScript from commit `8ede9ee`, version 0.19.19. These are two author-curated injected regressions, not newly discovered incidents, blind holdouts or cross-project evidence:

| Task | Injected regression | Separate acceptance checks |
| --- | --- | --- |
| `source-budget` | API minimum, tool-schema minimum and CLI forwarding disagree across three source files | Integer UTF-8 limits 256–16,000, default 4,000; nearest invalid values; Unicode, source-byte budget, unchanged ranking, cancellation and operation/CLI behavior |
| `zero-edge-cap` | Operation and CLI replace explicit zero with the default | Root-only zero, positive/default limits, invalid input, project/session parity and generated-graph/card-only fallback |

Pristine-positive and mutant-negative controls passed before each cohort. Initial oracle setup assumptions about identifier matching and CLI negative-number handling were corrected before any scored model turn. CLI numeric clamping remains distinct from tool-schema rejection. Each grader copies only production files into a separate fixture; candidate-owned tests and scripts do not decide acceptance. All six attempts changed at least two production JavaScript files and satisfied the recorded scope and navigation conditions. There were no scored timeouts or MCP failures. Original corpus hashes remained unchanged.

The requested model was `gpt-6.1-sol`, high reasoning, through the existing Codex CLI. [The reports](../benchmarks/results/policy-coding-0.19.19.json) retain environment/version, engine and harness hashes, acceptance checks, sanitized tool metadata, usage counters and repository-relative candidate patches. The resolved provider model is unknown. Workspace/tool restrictions are prompt enforced, not adversarial isolation.

## Observations

One attempt per task and condition, serialized, with a 240-second deadline. Ordinary/optional conditions alternate order by task. Both optional attempts skipped semantic tools, so a **separate later required-use follow-up** tested retrieval itself. It is not an interleaved repeat of the first cohort.

| Condition, two tasks each | Accepted | Total input | Cached input | Uncached input | Seconds | Tool events | MCP query calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Ordinary navigation | 2/2 | 448,475 | 377,472 | 71,003 | 142.5 | 14 | 0 |
| LLMNav available, optional | 2/2 | 475,091 | 418,816 | 56,275 | 157.0 | 19 | 0 |
| LLMNav required, later follow-up | 2/2 | 524,797 | 475,264 | 49,533 | 165.0 | 16 | 2 |

The [required-use report](../benchmarks/results/policy-coding-required-0.19.19.json) records one successful `llmnav_query` before ordinary navigation in each task; neither used `show` or `context`. Search/read commands still followed both queries. Required use had **17.0% more total input**, **15.8% longer elapsed time** and **30.2% less uncached input** than the earlier ordinary cohort. Cache shares were 84.2%, 88.2% and 90.6%, respectively. Uncontrolled provider caching and agent trajectories prevent attributing uncached differences to retrieval.

Recorded tool-response bytes were 117,668 / 119,517 / 117,391. These are event payload counters, not tokens or full wire sizes. CLI startup and editing are included in elapsed time; external acceptance grading is excluded. Two unscored tool/write preflights used another 24,215 uncached input tokens; those are setup costs outside the table. Monetary costs and index/card authoring and maintenance costs are unmeasured.

Known identifiers and shared policy constants made targeted search effective even across several files. Multiple files alone are insufficient reason to require semantic lookup. Keep ordinary navigation available and use semantic context when responsibility or policy relationships are unclear. This cohort does not test whether context retrieval helps harder cross-boundary tasks.

## Reproduce

Use a source checkout with its generated cards and the existing authenticated Codex CLI. No dependency installation is performed by this harness.

```sh
node benchmarks/policy-coding.js --controls-only --output <controls.json>
node benchmarks/policy-coding.js --output <optional.json> --repetitions 1
node benchmarks/policy-coding.js --conditions llmnav-required --output <required.json> --repetitions 1
```

Use a new output path for every measured cohort; keep unsuccessful attempts. `--engine <copied-installation>` selects a separate engine. Direct API callers can also supply `source` to freeze the corpus separately. The controls-only report intentionally has `complete:false`: no coding cohort ran. Patch headers from the first cohort were normalized after capture; repair hunks and usage counters were preserved.

The sample is two related tasks in one annotated repository. Repetition, task-family familiarity, sequential follow-up, provider caches and model resolution limit inference. No statistical speedup, universal token savings or cross-language advantage is claimed.
