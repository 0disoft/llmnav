# Gradual migration

## Upgrade to 0.5

No source-card migration is required. Keep every `llmnav/1` comment and the existing `.llmnav/cache/index.json` consumer contract.

Upgrade and regenerate:

```sh
npm install --save-dev llmnav@^0.5.0
npx llmnav init --agents all
npx llmnav generate
npx llmnav doctor
```

The regeneration preserves the schemaVersion 1 primary index and existing graph artifacts, then adds deterministic `prompt-prefix.json`. Initialization refreshes the managed agent protocol so structured-tool hosts learn the trusted-root boundary. Volatile `state/`, `.transactions/`, and `generation-transaction.json` remain ignored.

Review `generate --json` during the first upgrade. Existing cards are reported as added only when no previous compatible primary index exists. The prompt-prefix artifact appears in affected catalogs when its bytes change. `LNV009` remains a non-failing contract-fingerprint review signal.

Do not delete `index.json`, rewrite semantic IDs, or copy generated paths or graph edges into comments. v0.5 tool schemas, prompt partitions, editor diagnostics, and host examples are additive; no source-card migration is required.

## Do not annotate the whole repository

The fastest way to destroy LLMNav's value is a campaign that adds a card to every declaration. It creates search-term competition, maintenance burden, and larger prompts before the repository has evidence that those cards help.

Adopt it in measured layers.

## Phase 1: baseline

Collect 20 to 50 historical coding tasks before adding cards.

Record:

* first correct file or symbol rank
* number of files opened
* grep or search calls before the correct location
* uncached input tokens when available
* task success and test result

These tasks become the first `.llmnav/eval/queries.jsonl` entries.

## Phase 2: architecture cards

Add one `module` card to each domain boundary that agents routinely confuse.

Prioritize ownership and exclusions. A strong module card prevents an agent from entering an adjacent service with similar vocabulary.

Generate the repository core catalog and update agent instructions.

## Phase 3: high-cost behavioral boundaries

Add `symbol` or `file` cards to:

* authentication and authorization flows
* money and credit accounting
* privacy access and deletion
* migrations and compatibility boundaries
* external provider orchestration
* event consumers with idempotency requirements
* concurrency-sensitive state transitions
* algorithms with non-obvious invariants

Require test relations for auth, money, and privacy cards.

## Phase 4: aliases

Read failed and low-ranked historical queries. Add aliases when the task language uses product terminology, local language, abbreviations, or retired names that source identifiers do not contain.

Do not add aliases for every synonym an LLM can invent. Add phrases observed in real tasks.

## Phase 5: search gates

Turn `llmnav eval` into a required CI check after the benchmark contains representative tasks.

The initial default gates are not sacred. Raise them when the repository's query set is broad enough that a higher score reflects real navigation quality.

## Phase 6: selective expansion

Add cards only when one of these is true:

* repeated task queries fail to retrieve a boundary
* a high fan-in symbol is hard to identify by name
* a serious bug was caused by an unstated invariant
* agents repeatedly edit the wrong adjacent module
* a semantic workflow or fallback is invisible to syntax

A missing card should have a concrete navigation failure behind it.

## Existing JSDoc and docstrings

Keep human-facing API documentation. LLMNav sits before it and serves a different purpose.

```ts
/* llmnav/1 symbol
id=auth.session.rotate
role=Rotate one refresh-token family atomically and reject replayed tokens.
search=refresh token|token rotation|replay detection
stability=contract
*/
/** Rotates a refresh token and returns its replacement. */
export async function rotateSession() {}
```

Do not copy full JSDoc into `role`. Do not add LLMNav fields to generated API documentation unless the output has a clear consumer.

## Renames and moves

Keep the semantic ID unchanged.

Run generation to update path, line, signature, structure hash, and body hash.

A rename that leaves behavior intact should usually produce no semantic hash change.

## Splits and merges

When one capability splits, mark the old registry record as replaced.

```json
{"id":"billing.credit.charge","state":"replaced","by":["billing.credit.reserve","billing.credit.capture"]}
```

When an old name redirects to one capability:

```json
{"id":"auth.session.renew","state":"redirect","to":"auth.session.rotate"}
```

Never assign a retired ID to unrelated new code.
