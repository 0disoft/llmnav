# Navigation token cost review

The newer [0.20.0 multi-file source-query evaluation](multi-file-policy-evaluation.md#source-query-follow-up-0200) retains an unfavorable twelve-trial cohort, then a selection repair and four follow-up trials. One condition-adhering repair pair observed 8.7% less total input and 14.3% less time than ordinary navigation. The other pair has a flagged baseline; cache state and repeated-task familiarity are uncontrolled. Broader token savings remain unproven.

The confirmed waste was an extra locate step that often replaced neither a source read nor an agent round trip. The installed instructions also required a query before broad search and a subsequent `show`, even for simple tasks where ordinary search was sufficient. Version 0.16.0 adds bounded source excerpts and makes those navigation steps conditional.

## Evidence and attribution

The [original coding pilot](model-coding-evaluation.md) reported 138,655 uncached input tokens for LLMNav versus 96,393 for ordinary navigation. All eight LLMNav attempts performed discovery followed by a separate source read. In all four TypeScript cases, that read returned exactly the same byte count as baseline's source read. Five ranked candidates, signatures, scores, reasons and envelopes therefore added context without reducing those reads. CLI usage includes repeated system/tool context, not just returned source text.

Cache behavior is a separate factor: the original cache shares were 83.98% for LLMNav and 86.24% for baseline. Cache variation changes uncached input independently of response size. It is not sufficient to count visible tool events or estimate tokens from characters.

A [four-run no-tool probe](../benchmarks/results/token-prefix-probe-0.15.3.json) alternated baseline and an attached LLMNav server restricted to `llmnav_discover`. Every run reported 20,523 input tokens, 12,416 cached tokens and zero tool calls. This does not support attributing the original difference to an always-present initial schema cost in this host. Later activation/internal-request overhead is not separately exposed by CLI usage. The server advertises seven tools, while the host was configured to enable one; advertising seven is not evidence that all seven definitions entered the model prompt. An additional interaction probe is retained as excluded diagnostic evidence because a failed discovery attempt made its executed work unequal.

## Changes

* Discovery accepts optional `includeSource` and `sourceBudget`. A source-backed excerpt can replace the next read. The shared default is 4,000 UTF-8 text bytes, bounded to 256–16,000; JSON metadata is additional. Source text comes from the existing scan, with normalized newlines, explicit truncation and heuristic declaration/window provenance. Existing default results and ranking are unchanged.
* Tool guidance starts at one candidate with an excerpt. More candidates and surrounding source remain available when ambiguity or dependencies require them. Excerpts are evidence, not instructions or certified business contracts.
* Installed instructions permit targeted ordinary reads/searches for known files or identifiers. Query is for unclear locations/responsibilities; `show` and `context` are conditional on missing information. Sufficient excerpts should be reused. All supported adapters share the same protocol and preserve surrounding user rules. The protocol changed from 2,397 to 2,564 bytes, a bounded instruction increase rather than a removal of correctness constraints.
* The coding harness supports before/after and optional-navigation conditions. It retains usage, event types and excerpt counts/bytes without raw model reasoning, commands or source responses. Failed attempts remain in the denominator.

## Forced-navigation comparison

The [24-run report](../benchmarks/results/model-coding-token-0.16.0.json) and [derived summary](../benchmarks/results/model-coding-token-summary-0.16.0.json) compare ordinary navigation, the copied 0.15.3 engine and the 0.16.0 excerpt implementation. The same eight production-source mutations and acceptance controls are used. Before/after prompts and host settings are identical except for server installation; changed tool definitions are part of the product intervention. Conditions rotate by task. Each installation passes a separate lookup/write preflight.

| Condition | Accepted | Total input | Cached input | Uncached input | Tool events |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ordinary navigation | 8/8 | 639,497 | 537,088 | 102,409 | 24 |
| LLMNav 0.15.3, required | 8/8 | 866,867 | 742,912 | 123,955 | 24 |
| LLMNav 0.16.0, required | 8/8 | 802,735 | 676,096 | 126,639 | 21 |

Excerpts reduced total input by **7.4%** versus the previous engine, but uncached input **increased 2.2%**. Required LLMNav still used 25.5% more total input than ordinary navigation. This cohort does not establish uncached-token or monetary savings.

All eight updated runs requested excerpts, and three completed with just discovery and the edit. The other five still needed another operation. Reported shell/MCP response bytes fell from 36,786 to 19,465, or 47.1%; these event-byte counters are not provider token counts or complete wire-payload sizes. The much smaller response-byte count did not translate into lower uncached input. Preserving needed surrounding code is preferable to suppressing a justified read to improve a metric.

## Optional-navigation comparison

The routing cohort compares ordinary navigation with the same current MCP installation available on demand. It changes the navigation instruction, not the acceptance oracle. It permits skipping discovery and records actual use separately from coding success. Its results are reported separately from the required-use cohort; it does not retroactively change that cohort's outcome.

The [16-run routing report](../benchmarks/results/model-coding-routing-0.16.0.json) and [summary](../benchmarks/results/model-coding-routing-summary-0.16.0.json) retain every attempt:

| Condition | Accepted | Total input | Cached input | Uncached input | Tool events | Coding-run MCP calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Ordinary navigation | 8/8 | 712,334 | 629,888 | 82,446 | 26 | 0 |
| LLMNav available, optional use | 8/8 | 781,082 | 669,440 | 111,642 | 28 | 0 |

All eight optional-use attempts chose ordinary tools and passed acceptance. This verifies that the new guidance permits skipping semantic lookup in these simple tasks. It does **not** demonstrate token savings: aggregate input was 9.7% higher and uncached input 35.4% higher than the concurrent baseline. Five paired tasks had input totals within 2%; the Go identifier task used seven tool events, including three failed shell commands, versus baseline's five events and one failed command. That paired task contributed 43,975 of the 68,748 additional input tokens. The command bodies were not retained, so the failed commands' underlying causes are not assigned to the product. Other differences are not attributed from aggregate CLI counters alone. The optional-use failures/recoveries remain included; no run was discarded or repeated to obtain a better number.

The available-tool condition exercised no semantic lookup, so it measures routing and ordinary-tool behavior rather than a new retrieval capability. A larger repeated study would be needed to distinguish provider-cache and agent-trajectory variation from stable cost differences. Both cohorts had zero acceptance failures, scope failures, timeouts, MCP failures and recorded condition violations, with unchanged original corpora.

## Reproduce and limits

Run from a source checkout with the existing authenticated Codex CLI, local TypeScript development dependency and Go. No Serena runtime is needed for these conditions. First copy the old `bin`, `src` and `package.json` into an isolated directory while the old checkout is still available; the recorded engine hashes identify the measured sources.

```sh
node benchmarks/model-coding.js --typescript-root <buildmarks-root> --go-root <GOROOT/src/go/token> --conditions baseline,llmnav-before,llmnav --before-cli <old-installation/bin/llmnav.js> --output <forced.json>
node benchmarks/coding-summary.js <forced.json> <forced-summary.json>
node benchmarks/model-coding.js --typescript-root <buildmarks-root> --go-root <GOROOT/src/go/token> --conditions baseline,llmnav-adaptive --output <routing.json>
node benchmarks/coding-summary.js <routing.json> <routing-summary.json>
```

Each cohort reruns pristine-positive/mutant-negative controls, validates model write/tool access, grades edits outside the model workspace and rechecks original corpus hashes. The before installation must be a separate immutable copy, not an alias to the current CLI. Reported engine and harness hashes describe the measured revisions; the later routing-instruction update is a separate intervention.

These are single trials of eight small, known, author-curated regressions in bounded copies of real source, not blind holdouts or representative multi-file maintenance. Provider model resolution, monetary cost and per-internal-request token attribution remain unmeasured. Cache state is not controlled. Do not infer universal token savings, repeated-run reliability or a statistical speedup from these observations.

## Local verification

`npm run check` passed lint, 317 tests, semantic validation (zero errors/warnings) and forced full-generation freshness. The 33-query retrieval gate retained recall@1 97.0%, recall@5 100.0% and MRR 0.985. `npm pack --dry-run` and `npm run release:check` passed for local version 0.16.0. The package contains 93 files, excludes evaluation scratch copies and keeps zero runtime dependencies. Source/MCP/CLI excerpt parity, unchanged default ranking/results, shared UTF-8 limits, CRLF handling, truncation and adapter instruction preservation have focused coverage. The recorded forced-cohort harness matches commit `4471513`; both measured engine snapshots match their recorded source hashes. This is local verification, with no new registry publication or remote CI claim.

Skills applied: `llm-token-cost-control-review`, `agent-eval-integrity-review`, `api-contract-change`, `failure-triage` and `completion-evidence-gate`. Verification uses the child repository's direct commands.
