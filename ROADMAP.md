# Roadmap

## 0.1 — semantic foundation

Implemented:

* `llmnav/1` parser and formatter
* semantic validation and stable diagnostics
* persistent ID registry and append-only catalog order
* deterministic JSON, JSONL, repository, and module catalogs
* local multilingual lexical retrieval
* bounded semantic relation context
* search regression evaluation
* agent instruction adapters
* zero-runtime-dependency npm CLI

## 0.2 — deterministic incremental core

Implemented:

* persistent deterministic inverted index
* no per-query card retokenization
* file-level parsed-state reuse
* card-level posting-list updates
* transactionally staged cache generation
* rollback and interrupted-process recovery
* Windows transient rename and removal retries plus a mandatory Windows CI matrix
* changed-card and affected-catalog JSON output
* large fixture accuracy, speed, and memory regression gates
* fresh-process query and regeneration benchmark reports
* npm pack installation smoke test
* v0.1 index-schema and `llmnav/1` source compatibility

## 0.3 — stronger local structure

Implemented:

* exported API and configuration contract fingerprints
* route, event, schema, migration, and command-boundary detection
* language-aware TypeScript and Go declaration enrichers
* selective body hashes at declaration granularity
* richer affected-boundary reports
* SARIF diagnostic output
* sharded generated search artifacts for very large monorepos

## 0.4 — repository graphs

Implemented:

* optional import of generated definition and reference indexes
* edge provenance and confidence
* graph-aware ranking and bounded context packing
* workspace and cross-repository semantic ID resolution
* incremental graph invalidation

## 0.5 — agent protocol integrations

Implemented during 0.5 development:

* stable tool-schema adapters over existing query, show, context, and check operations
* prompt-prefix bundle generation with explicit cache partitions
* editor integrations and diagnostics
* provider-neutral integration examples

## 1.0 criteria

The source grammar and generated formats will be declared stable only after use across multiple TypeScript, Go, Rust, Python, and mixed-language repositories. A 1.0 release requires migration tooling, documented compatibility guarantees, benchmark fixtures with published methodology, sustained Windows and Linux verification, and no unresolved high-severity parser or transaction ambiguity.

## Non-goals

LLMNav will not become a general documentation generator, a source-of-truth call graph maintained by comments, an autonomous code modification service, a hosted source-ingestion platform, or a mandatory embedding database.
