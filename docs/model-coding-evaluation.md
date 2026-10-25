# Controlled model coding pilot

For the subsequent investigation, measured before/after costs and conditional navigation changes, see the [token cost review](token-cost-review.md).

This pilot runs actual coding-agent turns and grades the resulting source edits. It is separate from [identifier retrieval](real-navigation-pilot.md) and [Serena symbol lookup](serena-comparison.md). The model is requested as `gpt-6.1-sol` with high reasoning effort through Codex CLI 0.164.0-alpha.11.1 and the existing ChatGPT login. The CLI does not expose a resolved provider model identifier, so that field remains null.

## Measured outcomes

Completed on 2026-10-25. The [raw coding report](../benchmarks/results/model-coding-0.15.3.json) contains all 24 scored attempts; the [derived summary](../benchmarks/results/model-coding-summary-0.15.3.json) records its exact input hash. All eight positive/negative oracle controls and all three final tool/write preflight checks passed. Original corpus hashes remained unchanged.

| Condition | TS success | Go success | Median elapsed, s | Completed tool events | Uncached input tokens, total | Aggregate cache share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 4/4 | 4/4 | 26.406 | 25 | 96,393 | 86.24% |
| LLMNav | 4/4 | 4/4 | 25.875 | 24 | 138,655 | 83.98% |
| Serena | 4/4 | 4/4 | 58.955 | 43 | 177,084 | 88.97% |

Every condition had zero scope failures, timeouts and navigation-condition violations. LLMNav and Serena navigation succeeded in all eight respective attempts; no MCP failures occurred in the scored cohort. Baseline adhered to the semantic-navigation prohibition.

All three approaches solved these simple repairs. LLMNav's reported uncached input was higher than baseline, so this run does not demonstrate token savings against ordinary tools. Its tool-event count and observed median time were close to baseline. Serena's fresh-session setup/instructions add work in this protocol; persistent sessions were not tested. No latency superiority or general coding-success advantage is established by these single observations.

The useful product change is the reproduced MCP approval-classification fix described below. Keep discovery available for unannotated code and precise analysis for compiler-bound relationships. These results do not justify new ranking weights, mandatory semantic-tool use for every small repair, or a competitive score.

## Task and outcome contract

Each disposable workspace contains one injected regression in copied real production code. Four tasks use Buildmarks scoring/shared source and four use Go 1.26.4's `go/token`. Source identities match the retrieval pilot: Buildmarks commit `4884a072fc847223c4d27db843f0338d8a0de4e6`, 13 files and 67,253 bytes; Go, four files and 38,125 bytes. The copies contain no semantic source cards. These tasks are author-curated mutations, not newly discovered production defects or a sealed holdout.

| Task | Injected failure | Independent acceptance coverage |
| --- | --- | --- |
| TS weight normalization | Missing division by applicable weight | One/multiple applicable dimensions, all unavailable and zero |
| TS private placeholder | Leading zero allowed in numbered private names | Positive suffixes, zero, leading zero, public inputs and private URL rejection |
| TS evidence repository | Empty string treated as omitted | Undefined versus empty versus named repository, metadata preserved without mutation |
| TS monorepo threshold | Exactly two nested manifests missed | One/two manifests, workspace marker, CLI precedence and Windows slash/case normalization |
| Go AddLine | End-of-file offset accepted | EOF, duplicate/decreasing offsets, valid interior offset and resulting position |
| Go SetLines | Duplicate offsets accepted | Strict increase, rejection without state mutation, EOF and empty table |
| Go operator | Tilde omitted and illegal token accepted | Tilde, operators/delimiters, non-operators and unchanged spelling |
| Go identifier | Leading digits accepted | ASCII/Unicode leading digits, later digits, Unicode letters, keywords, punctuation and empty input |

Before any scored attempt, all eight pristine sources must pass their acceptance tests and all eight mutants must fail behaviorally. A compiler failure or timeout does not qualify as a valid mutant control. The model never receives the acceptance test file in its workspace. After its turn, the grader copies only production sources to a separate directory, rebuilds TypeScript with trusted TypeScript 6.0.3 configuration or runs Go acceptance tests, and discards model-owned configs/scripts/tests.

A successful attempt requires acceptance success, exactly the intended production file changed, normal turn completion and process exit, and completion within the 180-second deadline. Additional files or changes outside the intended target within the fixture fail the scope check. Generated `.llmnav`/`.serena` state is excluded from that check. Original corpus hashes are checked independently. Hidden tests check the listed contracts; they do not replace either original project's full CI suite or a semantic review of every possible behavior.

## Conditions and measurement

Every task runs once in each of three conditions. All runs use the same requested model, effort, deadline and source snapshot. Conditions rotate by task index and execute serially. Each attempt starts an ephemeral CLI session with user configuration ignored and model memories disabled.

* **Baseline:** ordinary shell/file navigation, including `rg`. The prompt explicitly prohibits semantic navigation even if ancestor instructions recommend it.
* **LLMNav:** ordinary `llmnav_discover` over MCP before source bodies or broad text search, followed by ordinary file/edit tools. No compiler graph or hand-authored cards are supplied.
* **Serena:** `find_symbol` or `get_symbols_overview` before source bodies or broad text search, followed by the same file/edit tools. Read-only navigation tools and Serena's required initial instructions are exposed. A disposable onboarding memory avoids asking the model to write project memories.

The raw report records each attempt's acceptance result, changed files, scope result, tool adherence, elapsed milliseconds, emitted completed tool events, MCP failures and CLI usage counters. Event metadata retains tool names/status, command hashes, response byte counts and coarse error classes. Raw prompts, model reasoning and command output are not retained. Edited copies are deleted after grading; candidate patches are not archived, so a past candidate cannot be regraded against expanded tests. Tool-event counts describe the events the CLI emitted; errors rejected before an event exists cannot be reconstructed from them.

Elapsed time includes CLI/MCP startup, model turns, navigation and edits; external acceptance grading is excluded. Each Serena attempt uses a fresh session and reads its instructions again. A persistent multi-task session could amortize that cost. Dependency installation precedes measurements. Filesystem caches are not flushed. Token totals include CLI system/tool context and use reported input/cache counters, not source-byte estimates. Aggregate cache share divides summed cached input by summed input; missing counters remain unknown. Monetary cost and human authoring/maintenance time are unmeasured.

## Setup failures and product fix

Two early attempts are retained in the [excluded environment cohort](../benchmarks/results/model-coding-0.15.3-environment-invalid.json). File writes in an external temporary workspace were rejected as read-only despite the requested workspace-write mode, and the LLMNav MCP call required approval. Those observations are not coding-success scores. The run was interrupted, its owned process tree stopped, and original source hashes rechecked.

Fixtures were moved under the authorized repository's ignored `.llmnav/tmp` directory and the existing Windows unelevated backend was selected per process. No global configuration or permission policy was changed. A [second unscored cohort](../benchmarks/results/model-coding-0.15.3-preflight-failed.json) verified successful writes and Serena calls but still caught LLMNav's approval failure before starting any coding tasks.

The missing LLMNav behavior annotations were then corrected. Default read operations advertise read-only behavior. Index-backed operations with opt-in automatic cache generation advertise possible writes; live discovery stays read-only. Tool names, inputs, result envelopes and host approval policy remain unchanged. The final cohort requires successful LLMNav lookup, Serena lookup and a model-created exact-content sentinel before any scored attempts. This preflight directly verifies the integration fix.

## Reproduce and interpret

Run from a source checkout; benchmark scripts and recorded reports are not included in the npm tarball. Use the [environment snapshot](../benchmarks/results/evaluation-environment-0.15.3.json) for exact language-server versions and selected engine hashes. Evaluation requires the existing authenticated Codex CLI, local TypeScript development dependency, installed Python 3.11, Serena 2.1.0 and compatible gopls 0.23.0. Keep `SERENA_HOME` outside the repository, and add the isolated gopls directory only to the child process PATH. Serena's TypeScript server uses TypeScript 5.9.3 / typescript-language-server 5.1.3; acceptance uses the repository's TypeScript 6.0.3.

```sh
node benchmarks/model-coding.js --typescript-root <buildmarks-root> --go-root <GOROOT/src/go/token> --output <report.json>
node benchmarks/coding-summary.js <report.json> <summary.json>
```

The summarizer rejects incomplete/excluded cohorts, missing source-integrity checks, failed preflights and missing/duplicate task observations. A valid model failure remains in the denominator; it is not retried or discarded. A failed environment cohort remains separately visible.

This is a small, single-trial pilot of simple regressions in bounded source scopes. The tasks are not blinded; Go standard-library familiarity may help the model. They do not exercise multi-file maintenance or the overloaded-receiver challenge from the retrieval tasks. Navigation and read-boundary instructions are prompt-enforced rather than an adversarial isolation boundary. Tool adherence and coding success are separate measures. Equal or unequal success here does not establish reliability across repeated runs, large repositories or complex maintenance tasks. Observed latency/token differences are diagnostic, without a statistical speedup or universal savings claim. The official [non-interactive CLI documentation](https://learn.chatgpt.com/docs/non-interactive-mode) describes the execution and usage-event interface.

## Repository verification

`npm run check` passed: lint, 311 tests, semantic-card validation and a forced full-generation freshness check. The 33-query retrieval gate reported recall@1 97.0%, recall@5 100.0% and MRR 0.985. `npm pack --dry-run` and `npm run release:check` passed for local version 0.15.3. Runtime dependency count remains zero. This task does not claim remote CI or package publication.

Skills applied: `agent-eval-integrity-review`, `performance-measurement-integrity-review`, `failure-triage`, `api-contract-change` and `completion-evidence-gate`. Repository checks are direct child-repository commands required by its AGENTS.md.
