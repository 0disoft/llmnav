# Multi-file policy repair evaluation

The original six agent attempts repaired their assigned policy regressions without establishing a navigation cost advantage. The [0.20.0 follow-up](#source-query-follow-up-0200) below preserves twelve initially unfavorable trials and four trials after source-window selection changed. One condition-adhering repair pair then used less total input and time than ordinary navigation; broader savings remain unproven.

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

## Implemented follow-up

Candidate repairs highlighted unnecessary preparation for a root-only context. Version 0.19.20 defers session-owned graph adjacency until expansion is needed. `show`, `depth:0` and `maxEdges:0` avoid that preparation; legacy card-only context also skips its reverse-relation index. The first real expansion prepares and caches adjacency, and refresh starts a new snapshot. Public caller-owned mutable graphs retain their existing uncached behavior.

The executable regression in `tests/context-limits.test.js` instruments edge-array sorts in a generated 100-edge fixture. Before the change, session preparation plus two root-only project contexts sorted 300 edge entries; afterwards they sorted **zero**. The first session expansion sorted 100 entries and repeated expansion/query sorted zero more. Related tests retain output parity, ranking, graph fallback, validation reuse and refresh behavior; both policy acceptance oracles also passed after the change.

This removes adjacency construction/sorting (up to O(E log E)) and its O(E) temporary neighbor storage from the root-only path, plus O(C + R) reverse-relation preparation in legacy context. Graph/index I/O, validation and root rendering remain. It does not make the whole command O(1). At that stage no post-change model cohort had run: this was an internal-work reduction, not evidence of improved model token usage.

Skills applied: `agent-eval-integrity-review`, `performance-measurement-integrity-review`, `test-design-guard`, `delivery-verification-budget` and `docs-update`. Use the child repository's direct verification commands. Changes are local; no push or publication is part of this evaluation.

## Source-query follow-up (0.20.0)

### Why navigation added work

The original ordinary-navigation attempts used twelve shell search/read commands. Required LLMNav used twelve shell commands **plus two semantic queries**: the cards located boundaries but did not provide enough editable source. Optional navigation used no semantic calls, so its differences cannot be assigned to retrieval. CLI input usage includes repeated conversation/system/tool context; response bytes cannot substitute for token accounting.

Version 0.20.0 adds optional compact cards and live source windows in one `llmnav_query` operation. Its default source-text budget is 12,000 UTF-8 bytes; card/JSON metadata is additional. Default query results and CLI query options remain unchanged. See the [API contract](api.md#agent-operation-protocol).

### Initial repeated comparison: still worse than ordinary navigation

The [twelve-trial report](../benchmarks/results/policy-coding-source-0.20.0.json) freezes corpus commit `e4ccf72`, the previous 0.19.20 engine and the initial 0.20.0 engine. Two tasks, three conditions and two repetitions run serially with rotated condition order. The source condition also changes tool-use guidance and requests `top:2` instead of `top:3`; this compares the product and guidance together.

| Condition, four attempts each | Acceptance | Total input | Uncached input | Seconds | Tool events |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ordinary navigation | 4/4 | 736,101 | 120,421 | 208.3 | 26 |
| Previous engine, required cards | 4/4 | 1,059,555 | 128,611 | 248.7 | 29 |
| Initial source query | 4/4 | 991,363 | 131,843 | 239.9 | 29 |

Initial source mode used 6.4% less total input and 3.6% less time than required cards, but **34.7% more total input and 15.2% more time than ordinary navigation**. Cache shares were 83.6%, 87.9% and 86.7%. All twelve passed scope/navigation checks; none timed out or failed MCP. Setup preflights consumed another 18,158 uncached input tokens outside the table. All thirty repair patches are retained.

### Source-window selection repair

A diagnostic query with `maxEdges`, `--max-edges` and `context` returned CLI help while omitting the actual forwarding call. Broad terms also admitted unrelated files. The implementation now retains bounded path summaries per term, suppresses broad-only file matches and rereads at most twelve selected files for focused windows. Matches outside the existing language literal/comment mask rank ahead of quoted documentation. Literal-only searches remain supported. Omitted-file/window counters and truncation stay explicit; these heuristics do not certify complete change-impact coverage.

The regression verifies that forwarding outranks an earlier help string and that thirty broad-only distractors are counted as omitted. Related coverage retains UTF-8 budgets, CRLF normalization, live hashes, cancellation and API/session/MCP parity.

### Separate follow-up: one usable comparison pair

The [four-trial follow-up](../benchmarks/results/policy-coding-focused-source-0.20.0.json) freezes commit `a443060`, with unchanged task prompts and acceptance checks. It is a later cohort after selection changed, not pooled into the first table.

| Task / condition | Acceptance | Navigation condition | Total input | Uncached input | Seconds | Shell search/read commands |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Source budget / ordinary | pass | flagged | 283,132 | 34,428 | 71.5 | 9 |
| Source budget / focused query | pass | pass | 260,370 | 40,594 | 67.4 | 6 |
| Zero edge cap / ordinary | pass | pass | 197,859 | 27,875 | 42.2 | 8 |
| Zero edge cap / focused query | pass | pass | 180,699 | 20,187 | 36.1 | 3 |

The source-budget baseline triggered the conservative `semanticCliMentioned` detector in command text. Retained metadata cannot establish whether it invoked a forbidden CLI or only searched that spelling. Its repair passed acceptance, but `conditionAdhered:false`, `success:false` and all costs are preserved. **Do not use that pair or the four-row aggregate as a clean performance comparison.** No replacement attempt was run.

In the condition-adhering zero-edge-cap pair, both repairs passed independent acceptance. Focused query used **8.7% less total input**, **14.3% less time**, three rather than eight shell search/read commands, and five rather than nine total tool events. One query supplied 12,000 source-text bytes in ten windows, including CLI forwarding. Necessary searches remained. Uncached input was 27.6% lower alongside cache shares of 85.9% and 88.8%; monetary or cache-independent savings are not established.

All four repairs passed acceptance/scope checks; there were no timeouts or MCP failures. Both cohorts kept original corpus hashes unchanged, and all forty patch hashes were verified. The later preflight used another 5,540 uncached input tokens. Both requested `gpt-6.1-sol`, high reasoning, through existing Codex CLI 0.164.0-alpha.11.1 on native Windows/Node 24.18.0. Resolved provider model, cache state, annotation/index maintenance cost and monetary cost remain unmeasured. These are repeated, author-curated tasks without an A/A statistical validity gate or representative holdout. The clean pair is an observation, not evidence of a stable general speedup.

### Use and reproduce

Known files/identifiers still warrant ordinary bounded reads/search. Use combined query when reviewed boundaries and source in several files are both needed. Prefer specific identifiers alongside CLI flags: flag-only searches can locate help/forwarding but miss differently named API fields. Reuse sufficient windows; expand omissions or ambiguity when correctness requires it.

```js
await executeAgentOperation(root, "llmnav_query", {
  task: "preserve an explicit zero context edge cap across CLI and operations",
  top: 2,
  includeSource: true,
  sourceTerms: ["maxEdges", "--max-edges"],
});
```

```sh
node benchmarks/policy-coding.js --conditions baseline,llmnav-required,llmnav-source --before-engine <frozen-0.19.20-engine> --repetitions 2 --output <initial-source.json>
node benchmarks/policy-coding.js --conditions baseline,llmnav-source --repetitions 1 --output <focused-source.json>
```

Keep the previous engine in a separate immutable copy containing its `bin`, `src`, `schema`, `templates` and `package.json`. Recorded hashes identify measured engines and harnesses. Use distinct output paths and retain flagged, failed and slower attempts. No further trials were added to seek a favorable aggregate.
