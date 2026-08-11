# Architecture and cache design

## Design target

LLMNav minimizes repository text an agent must inspect before reaching the correct declaration. It does this without turning comments into a stale copy of the program and without rebuilding every derived structure on every command.

```text
stable source cards
        +
generated declaration and import structure
        +
repository aliases and ID registry
        ↓
file-level parsed state
        ↓
compatible card index + deterministic inverted index + compact catalogs
        ↓
query → show → bounded context → selected source bodies
```

## Three information layers

| Layer | Contents | Persistence |
| --- | --- | --- |
| Stable meaning | ID, role, search phrases, ownership, invariants, effects, risks, semantic relations, stability | source comments |
| Generated structure | path, declaration, language, visibility, boundaries, imports, semantic/structure/body hashes | `.llmnav/cache` |
| Volatile execution hints | file size, mtime, ctime used only to avoid reads | `.llmnav/state`, ignored |

Generated paths, signatures, callers, references, timestamps, and hashes are never written into source comments. The generated layer may be discarded and rebuilt without changing source semantics.

## Compatible primary index

`.llmnav/cache/index.json` remains the primary interoperability artifact.

```json
{
  "schemaVersion": 1,
  "specVersion": "1",
  "generatedBy": "llmnav@0.6.0",
  "repositoryId": "example",
  "contractFingerprints": {
    "schemaVersion": 1,
    "exportedApi": { "count": 0, "sha256": "..." },
    "configuration": { "sha256": "..." }
  },
  "sourceHash": "...",
  "cards": []
}
```

The primary index preserves schemaVersion 1 and the v0.1 card fields. Contract fingerprints remain optional additive fields, so earlier consumers can continue reading the existing fields. Graph, graph-state, prompt-bundle, agent-operation, and editor-diagnostic artifacts have independent schema versions.

The exported API fingerprint covers annotated declarations that are public according to deterministic language conventions. The configuration fingerprint covers the effective validated configuration except the local `$schema` path. Body-only edits do not change either fingerprint. Generation emits warning `LNV009` when an existing fingerprint changes, but the warning does not block an intentional regeneration.

Each card carries three independent hashes.

| Hash | Input | Typical invalidation |
| --- | --- | --- |
| `semantic` | canonical stable card fields | role, invariant, effect, risk, semantic relation change |
| `structure` | path, scope, declaration, signature, imports | move, rename, signature or import change |
| `body` | attached declaration bytes for symbol cards; containing file bytes otherwise | body change inside the selected declaration or containing file |

## Local structure enrichment

Symbol attachment records the detected language, public/exported status, visibility, Go receiver when present, declaration span, and a declaration-level body hash. TypeScript and Go use dedicated deterministic declaration patterns; JavaScript, Rust, Python, and generic C-like declarations retain the compatible fallback patterns.

Generated cards may contain a sorted `boundaries` array. LLMNav detects `artifact`, `route`, `event`, `schema`, `migration`, `runtime`, and `command` boundaries from repository-relative paths, controlled semantic effects or risks, and narrow source evidence. Source evidence includes persistent dotted JSON filename builders, versioned schema literals, Tauri commands and invoke adapters, and platform lifecycle code. Each record includes `confidence` and explicit evidence. These hints are generated navigation data and are never copied into source comments.

Generation compares the previous and current primary indexes to emit `affectedBoundaries`. The report preserves the card change and hash dimensions while adding module IDs, structural boundary records, outbound relation targets, and reverse semantic dependents. It is returned through the API and `generate --json`; it is not stored in source cards.

## Annotation coverage audit

The read-only audit combines package entrypoints, public re-export reachability, generated structural boundaries, import fan-in, exported declaration counts, and source size. It lowers the priority of named utilities and low-fan-in export hubs, declaration files, non-production support paths, and pure re-export barrels. High-fan-in domain contract hubs do not receive the broad-utility penalty merely because they export many declarations. Every candidate retains its score inputs and deterministic repository-relative path.

This analyzer deliberately stops before semantic generation. Structure can identify a file worth inspecting, but it cannot safely invent a durable ID, role, ownership statement, invariant, risk, or relation. Accepted boundaries become explicit source cards, path-specific coverage rules, and retrieval regression queries through normal review.

## Deterministic inverted index

`.llmnav/cache/search-index.json` schemaVersion 2 with `compact-v1` encoding stores a sorted card-ID table, normalized phrase documents, a sorted token dictionary, and posting lists.

### Optional search shards

When `generation.searchShardSize` is positive and the repository exceeds that card count, generation emits `search-shards.json` schemaVersion 1 with `card-range-v1` encoding plus zero-padded shard files below `search-shards/`. Each manifest record contains the first and last semantic ID, card count, card-set hash, and artifact SHA-256.

Shards slice the already-built compact documents and postings, adjust local card ordinals, and never retokenize cards. Every shard independently satisfies the compact search-index compatibility checks for its card subset. The full `search-index.json` remains authoritative for built-in queries, preserving global document frequency and v0.2 ranking behavior. Cache transactions publish or remove the complete shard set atomically.

## Prompt-prefix bundle

`.llmnav/cache/prompt-prefix.json` schemaVersion 1 packages the exact stable prefix material without applying any provider-specific cache API. Its ordered partitions are:

1. provider-neutral tool definitions with package cache scope
2. the managed agent protocol with package cache scope
3. the repository core catalog with repository cache scope
4. module catalogs in semantic-ID order with module cache scope

Every partition contains normalized content, SHA-256 content identity, an estimated token count, and an explicit boundary-after hint. The bundle records base and selectable module IDs separately and states that volatile context belongs after them. Its aggregate hash covers ordered partition IDs and content hashes.

The artifact contains no timestamp, branch, diff, user task, absolute path, or provider setting. It is covered by `manifest.json` and published in the same cache transaction as its source catalogs. A consumer must preserve base order, choose only relevant module partitions, and add volatile context afterward.

## Repository graph

`.llmnav/cache/graph.json` schemaVersion 1 is a deterministic derived artifact. It combines source-card semantic relations, resolvable relative imports, and configured generated definition/reference indexes. Nodes and edges use qualified repository keys. Edges retain confidence and provenance rather than flattening explicit and inferred evidence into one unqualified relation.

Unresolved targets are preserved as placeholder nodes. This allows later workspace resolution without inventing a local definition or silently dropping an imported reference. `manifest.json` covers the graph bytes and cache transactions publish it atomically with the primary and search indexes.

Search treats lexical results as seeds and applies only a confidence-scaled one-hop graph bonus. Context traversal is breadth-first and bounded by depth, token budget, and edge count. Invalid or manifest-mismatched graph data is not used for ranking; search falls back to the compatible lexical and source-relation behavior.

The graph is also the explicit workspace resolution surface. Qualified IDs resolve by exact node key. Unqualified IDs prefer the local repository and resolve externally only when the semantic ID is unique across imported repositories. No directory discovery or network lookup occurs during resolution.

`.llmnav/cache/graph-state.json` is a disposable schemaVersion 1 acceleration artifact. Content-addressed partitions isolate local cards and imported indexes. Partition keys and hashes include every graph-relevant dimension, and local path resolution changes invalidate all affected local-import decisions. Incompatible or malformed state is never partially trusted: generation rebuilds it from the current primary index and validated graph inputs.

Graph state contains no timestamps, absolute paths, or filesystem identity. Incremental and forced-full builds must produce byte-identical graph and state bytes, and the transaction publishes both with the manifest.

Each card entry stores a hash of its searchable fields and its normalized phrase fields. The global token dictionary is sorted once. Every dictionary entry points to a posting list encoded as sorted card ordinals and sparse field-frequency vectors. The ordinals resolve through the sorted `cardIds` table.

Field order and field weights are versioned constants. Tokens, card IDs, object keys, and posting entries use locale-independent UTF-16 lexical comparison.

The complete search index is deterministic across card traversal order. It contains no timestamp, absolute path, random ID, platform separator, or filesystem metadata.

During a query, LLMNav tokenizes only the task text. It reads posting lists for those tokens and does not tokenize every card. If the generated search index is missing, malformed, or incompatible with the primary index, LLMNav builds a compatible in-memory index from `index.json` instead of refusing v0.1 repositories.

## File-level incremental indexing

`.llmnav/cache/file-state.json` contains deterministic parsed state for each source file:

* repository-relative POSIX path
* SHA-256 content hash
* source and semantic byte counts
* generated import strings
* parsed LLMNav blocks
* attached declaration records

It contains no mtime, ctime, inode, device ID, absolute path, or OS-specific separator.

`.llmnav/state/stat-hints.json` is a volatile optimization. It records file size, mtime nanoseconds, and ctime nanoseconds. It is ignored by Git and never enters deterministic manifests.

Generation classifies each file as follows.

```text
matching stat hint
    → reuse file-state entry without reading source

changed or missing stat hint, matching content hash
    → read source once, reuse parsed file-state entry

changed content hash
    → parse source and rebuild only that file's records

missing current file
    → delete its records
```

A source file can contain multiple cards. Parsing is file-granular because comment syntax and declaration attachment require surrounding file text. Search-document rebuilding is card-granular because each card has an independent search hash.

## Card-level inverted-index updates

The previous `search-index.json` is usable only when its schema, tokenizer version, field order, and repository ID match.

For every current card:

```text
same search-document hash
    → reuse stored document and posting entries

different hash
    → remove old posting entries, tokenize the card once, add new entries

removed card
    → remove its document and posting entries
```

The incremental result is serialized from sorted maps and must be byte-identical to a full rebuild. Regression tests compare the complete object and generated bytes after add, modify, and remove operations.

## Stable catalog order

Alphabetically re-sorting a large catalog inserts new cards into the middle and shifts every later prompt token. LLMNav records first-seen semantic IDs in `.llmnav/order.lock`.

Normal generation preserves existing lines and appends new IDs in deterministic order. A deliberate full reorder is a cache-epoch change and should be reviewed separately from feature work.

## Catalog tiers

`repo-core.txt` contains cards whose stability matches `repositoryCatalogStabilities`, which defaults to `architecture`.

`modules/<id>.txt` contains cards grouped by configured semantic-ID depth. The default module depth is two and includes `architecture` plus `contract` cards.

`index.json`, `cards.jsonl`, `search-index.json`, and `file-state.json` retain every card, including `implementation` cards.

Repository and module catalogs contain semantic fields only. Current paths, lines, declarations, imports, and signatures remain in generated indexes and dynamic query output. A body edit, symbol rename, or file move therefore does not invalidate a semantic catalog whose meaning stayed intact.

## Transactional cache generation

Generation never mutates the live cache file by file. It builds a complete replacement under `.llmnav/.transactions/<id>/stage`.

The complete source scan and cache commit are serialized by `.llmnav/generation.lock`. The lock records a process and opaque owner ID. A reader waits for a live owner to finish and only then evaluates recovery, while an abandoned lock from a dead process can be removed without granting another process authority over an active journal.

```text
write every staged artifact
verify exact staged bytes
verify manifest hashes and primary index schema
write transaction journal: prepared
rename live cache to backup
write journal: old-moved
rename stage to live cache
write journal: new-installed
verify installed cache
write journal: committed
remove backup, transaction directory, and journal
```

The journal is `.llmnav/generation-transaction.json`. It records the writer owner ID, and transaction paths are repository-relative and validated to remain below `.llmnav/.transactions`.

When generation discovers new semantic IDs, the staged transaction also owns `.llmnav/ids.jsonl` and `.llmnav/order.lock`. Their previous bytes are backed up beside the cache, their replacements are verified by content hash, and recovery restores or finalizes all three surfaces together.

If generation throws before commit, rollback restores the backup. If the process is killed, the next `query`, `generate`, or `doctor` recovers from the journal before reading cache data.

An installed cache is considered authoritative only after the journal reaches `committed`. A crash after installing a new cache but before commit restores the previous cache. A crash after recording `committed` keeps the new verified cache and completes cleanup.

## Windows rename behavior

Directory replacement is expressed as two renames rather than relying on replacing a non-empty destination directory. Transient rename and removal errors with these codes are retried with bounded delays:

```text
EACCES
EBUSY
EEXIST
ENOTEMPTY
EPERM
```

The failure-injection suite covers process exits after moving the old cache and after installing an uncommitted cache. The CI matrix executes the same suite on `windows-latest` and Ubuntu with Node.js 22 and 24.

## Machine-readable impact records

`generate --json` compares the previous and current primary indexes.

A changed-card record reports:

* stable ID
* `added`, `modified`, or `removed`
* changed hash dimensions: `semantic`, `structure`, `body`
* compact previous and current snapshots

An affected-catalog record reports repository, module, or agent-context artifacts whose bytes changed. Output arrays and object serialization are deterministic, making them safe for CI, agent orchestration, and release tooling.

## Search pipeline

The v0.2 local ranker performs:

1. Unicode NFKC normalization.
2. Exact semantic ID and ID-substring matching.
3. Alias resolution from `.llmnav/lexicon.json`.
4. Query tokenization with word tokens and CJK bigram/trigram expansion.
5. Field-weighted posting-list scoring with inverse document frequency.
6. Exact phrase bonuses from pre-normalized card phrases.
7. One-hop semantic relation expansion from the highest-ranked cards.
8. Deterministic score and semantic-ID sorting.

The score model remains compatible with v0.1. Large synthetic tests compare complete ranked ID and score sequences against the v0.1-compatible legacy implementation.

## Prompt-cache placement

A model-provider harness can use this stable order:

```text
stable tool definitions
stable agent protocol
.llmnav/cache/repo-core.txt
cache breakpoint
selected .llmnav/cache/modules/<module>.txt
cache breakpoint
user task
branch and diff state
query results
selected source bodies
test and tool output
```

The CLI emits deterministic semantic catalogs but does not call a model API or force provider-specific cache controls.

## Declaration attachment

The local parser recognizes common declarations in TypeScript, JavaScript, Go, Rust, Python, and a generic class/function profile. It skips ordinary documentation comments, decorators, and attributes after a card.

This parser is a conservative heuristic rather than a complete language AST. A card that cannot attach is an error instead of being silently indexed against the wrong code. Generated language-aware enrichers may improve structure in later releases but must not write derived data into source cards.

## Security model

LLMNav reads repository source and writes only `.llmnav`, selected managed instruction files during explicit initialization, and source comments during explicit formatting.

It performs no network requests, executes no repository code, loads no plugins, and has no install script. Configured source, evaluation, and cache paths must remain relative to the repository. Existing symbolic links in control and agent-instruction paths are rejected before writes.

The local index is not a security boundary. It may contain source paths, current signatures, imports, and semantic descriptions. Apply the same access controls to `.llmnav/cache` as to the source repository.
