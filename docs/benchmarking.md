# Benchmarking navigation impact

## What to measure

A successful deployment should reduce exploration cost without reducing task correctness.

Measure at least:

| Metric | Meaning |
| --- | --- |
| correct semantic ID Recall@1 | first result is an accepted target |
| correct semantic ID Recall@5 | an accepted target appears in the first five |
| mean reciprocal rank | rewards earlier accepted targets |
| first correct source time | elapsed time until the agent opens the right declaration |
| files opened | breadth of repository exploration |
| search tool calls | grep, glob, tree, language-server, and LLMNav calls |
| source lines read | amount of code inserted into model context |
| uncached input tokens | new model input paid and processed for the task |
| token cache ratio | cached input divided by total input |
| task success | tests and acceptance criteria pass |
| wrong-edit rate | edits made in an irrelevant boundary |

A high request-level cache hit rate is not enough. Track cached tokens and uncached tokens separately.

## Experimental groups

Compare three configurations.

`baseline` uses the repository's current agent instructions and search tools.

`comments-only` adds source cards but gives the agent no deterministic index or query tool. This isolates whether prose alone helps.

`full` uses cards, generated catalogs, query, bounded context, and stable prompt placement.

The comments-only group is important. It exposes designs that merely add tokens without improving navigation.

## Task set

Use 30 to 50 historical tasks when possible. Mix:

* bug fixes
* feature additions
* API changes
* refactors
* performance work
* test failures
* migration changes
* cross-module workflow changes

Record all acceptable target IDs for tasks with multiple valid entry points.

## Repetition

Agent execution is variable. Run each task multiple times with the same model, reasoning configuration, tools, repository state, and timeout policy.

Report medians and failure ranges rather than presenting one lucky run.

## Search regression file

LLMNav's built-in evaluation covers the retrieval layer only.

```jsonl
{"query":"duplicate webhook applies payment twice","expected":["billing.payment.apply-provider-event"]}
{"query":"same collapse seed produces a different arena","expected":["game.arena.collapse-sequence"]}
```

Use `llmnav eval --json` in benchmark scripts.

## Initial target gates

The defaults are intentionally demanding but not proof of end-to-end value.

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

Do not publish these targets as measured LLMNav results. They are deployment gates to validate on each repository.

## Failure analysis

Classify every miss before changing ranking weights.

* missing card
* weak or generic role
* missing task-language alias
* overloaded search phrase
* wrong module boundary
* missing semantic relation
* declaration attachment failure
* generated index stale
* lexical ranker limitation
* task legitimately requires broad structural analysis

Only the last two justify an embedding or graph-enricher investment.
