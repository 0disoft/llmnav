# Architecture and cache design

## Design target

LLMNav minimizes the amount of repository text an agent must inspect before reaching the correct declaration. It does this without turning comments into a second, stale copy of the program.

The pipeline is:

```text
stable source cards
        +
generated declaration and import structure
        +
repository aliases and ID registry
        ↓
deterministic index and compact catalogs
        ↓
query → show → bounded context → selected source bodies
```

## Why the source layer is small

Code already contains names, signatures, imports, and control flow. Repeating them in prose increases tokens and creates drift.

Source cards retain only high-value semantic information:

* the durable capability ID
* one observable role
* scarce task-language phrases
* ownership and exclusion boundaries
* true invariants
* important external effects and risks
* relations that syntax cannot derive reliably
* expected stability

The default comment-size and repository-ratio checks are designed to make annotation growth visible before it becomes a retrieval pollutant.

## Deterministic generated layer

The generated index contains current location data. It is rebuilt rather than edited.

Each card receives three independent hashes.

`semantic` hashes the canonical stable card. A body-only refactor leaves it unchanged.

`structure` hashes path, scope, current declaration, signature, and imports. A move or public signature change updates it without pretending the semantic contract changed.

`body` hashes the containing source file. It is useful for invalidation and future incremental enrichers.

Generated catalogs contain no wall-clock timestamp. Identical source, configuration, registry, and order produce identical bytes.

## Stable catalog order

Alphabetically re-sorting a large catalog inserts new cards into the middle and shifts every later token. LLMNav instead records first-seen semantic IDs in `.llmnav/order.lock`.

Normal generation preserves existing lines and appends new IDs. A deliberate full reorder should be treated as a cache epoch change and reviewed separately from feature work.

## Catalog tiers

`repo-core.txt` contains cards whose stability matches `repositoryCatalogStabilities`, which defaults to `architecture`.

`modules/<id>.txt` contains cards grouped by the first configured ID segments. The default module depth is two and includes `architecture` plus `contract` cards.

`index.json` and `cards.jsonl` retain every card, including `implementation` cards.

Repository and module catalogs contain semantic fields only. Current paths, lines, declarations, imports, and signatures remain in the index and in `query`, `show`, or dynamic `context` output. A body edit, symbol rename, or file move therefore changes the structure index without invalidating a semantic catalog whose meaning stayed intact.

A model-provider harness can place the repository core before a prompt-cache breakpoint, the selected module catalog before a second breakpoint, and task-specific source after it. The CLI itself does not call a model API and does not force one provider's cache controls.

## Search pipeline

The built-in v0.1 ranker performs:

1. Unicode NFKC normalization.
2. Exact semantic ID matching.
3. Alias resolution from `.llmnav/lexicon.json`.
4. Field-weighted token matching with inverse document frequency.
5. Exact phrase bonuses.
6. Hangul, Han, Hiragana, and Katakana bigram and trigram expansion.
7. One-hop semantic relation expansion from the highest-ranked cards.
8. Deterministic score and ID sorting.

The ranker is deliberately local and predictable. Repositories should add embeddings only after evaluation data shows a persistent lexical recall failure.

## Declaration attachment

Version 0.1 recognizes common declarations in TypeScript, JavaScript, Go, Rust, Python, and a generic class/function profile. It skips ordinary documentation comments, decorators, and attributes after a card.

This parser is a conservative heuristic rather than a full language AST. A card that cannot attach is an error instead of being silently indexed against the wrong code.

Candidates inside ordinary single, double, backtick, and Python triple-quoted string literals are ignored. This prevents parser fixtures and embedded source examples from becoming false cards. Full language parsers remain the correct long-term answer for unusual raw-string and regex-literal syntax.

## Future structure enrichers

SCIP, language servers, Tree-sitter, and compiler APIs belong behind generated enrichers. Planned enrichers may add:

* definition and reference edges
* call edges with provenance and confidence
* implementation and override edges
* route, event, and schema boundaries
* side-effect sink comparison
* exported contract fingerprints
* changed-symbol incremental generation

An enricher must never write generated edges back into source cards.

## Security model

LLMNav reads repository source and writes only `.llmnav`, selected managed instruction files during explicit initialization, and source comments during explicit formatting.

It performs no network requests, executes no repository code, loads no plugins in v0.1, and has no install script.

Configured source, evaluation, and cache paths must remain relative to the repository. Generated cache output must remain below `.llmnav/`. Existing symbolic links in control and agent-instruction paths are rejected before writes.

The local index is not a security boundary. It may contain current signatures, imports, and source paths. Repositories handling sensitive source should apply the same access controls to `.llmnav/cache` as to the source itself.
