# Changelog

All notable changes to this project are documented here.

The npm package follows Semantic Versioning. The `llmnav/N` source protocol is versioned independently.

## [Unreleased]

### Added

* Added stable provider-neutral agent tool schemas and a bounded operation dispatcher for query, show, context, and check.
* Added deterministic prompt-prefix bundles with explicit package, repository, and module cache partitions.
* Added deterministic zero-based editor diagnostics and a generated VS Code task integration.

## [0.4.0] — 2026-08-09

### Added

* Added strict repository-local imports for generated definition and reference indexes with `LNV014` diagnostics.
* Added deterministic qualified repository graphs with source-card, local-import, and generated-index edge provenance and confidence.
* Added confidence-weighted graph ranking and context packing bounded by depth, token budget, and edge count.
* Added exact qualified and ambiguity-safe workspace semantic ID resolution with external definition rendering.
* Added content-addressed graph partitions with safe incremental invalidation and byte-equivalent full rebuilds.

## [0.3.0] — 2026-08-09

### Added

* Added deterministic exported API and effective configuration fingerprints with `LNV009` drift diagnostics.
* Added TypeScript and Go declaration enrichment, declaration-level body hashes, and generated route, event, schema, migration, and command boundaries.
* Added deterministic affected-boundary reports with modules, relations, and reverse semantic dependents.
* Added deterministic SARIF 2.1.0 diagnostic serialization and `llmnav check --format sarif`.
* Added opt-in deterministic card-range search shards with manifest hashes and transactional stale-shard removal.

### Changed

* Replaced the remaining Korean documentation examples with English equivalents.

### Removed

* Removed the Korean README so the project maintains one canonical English README.

## [0.2.0] — 2026-08-09

### Added

* Deterministic compact `search-index.json` containing a sorted token dictionary, normalized phrase documents, and ordinal posting lists with sparse field vectors.
* Card-level inverted-index updates keyed by deterministic search-document hashes.
* Deterministic `file-state.json` for file-level incremental parsing and card reuse.
* Volatile stat hints under `.llmnav/state/` to skip reading byte-identical files during no-op generation.
* Transactional cache generation through staged writes, manifest verification, directory replacement, rollback, and crash recovery.
* Automatic recovery before `query`, `generate`, and `doctor` read or replace generated cache data.
* Retry handling for Windows-style `EACCES`, `EBUSY`, `EEXIST`, `ENOTEMPTY`, and `EPERM` rename and removal failures.
* Machine-readable `changedCards`, `affectedCatalogs`, incremental metrics, and transaction state in `generate --json` output.
* Large synthetic fixture regression tests for ranking equality, query speed, index size, RSS, and heap use.
* Failure-injection tests before journaling, after moving the old cache, and after installing an uncommitted cache.
* Fresh-process query and regeneration benchmark harness with raw JSON and Markdown reports.
* npm tarball installation smoke test that initializes, generates, queries, validates, and diagnoses a clean project.
* Public ESM exports and TypeScript declarations for the v0.2 indexing and transaction APIs.

### Changed

* `llmnav generate` now performs incremental scanning by default and commits cache changes transactionally.
* `llmnav query` uses the generated inverted index and no longer tokenizes every card for every query.
* `llmnav doctor` validates search-index compatibility, file-state compatibility, manifest hashes, and interrupted transactions.
* Generated artifacts use locale-independent key and path ordering.
* `.llmnav/.gitignore` now excludes volatile stat hints and transaction work directories.
* CI runs the complete suite on Linux and Windows with Node.js 22 and 24, and runs the packed-package smoke test on Node.js 22.

### Compatibility

* The source grammar remains `llmnav/1`.
* `.llmnav/cache/index.json` remains schemaVersion 1 and retains its v0.1 fields.
* Existing v0.1 commands and default text output remain compatible.
* `search-index.json` and `file-state.json` are additive generated artifacts. A missing, malformed, corrupted, or incompatible search index is rebuilt in memory from `index.json`.

## [0.1.0] — 2026-08-09

### Added

* Initial `llmnav/1` source comment specification.
* Zero-runtime-dependency Node.js CLI.
* `init`, `check`, `format`, `generate`, `query`, `show`, `context`, `eval`, `doctor`, and `spec` commands.
* Stable semantic ID registry and append-only catalog ordering.
* Deterministic repository and module catalogs.
* Multilingual aliases and CJK n-gram retrieval.
* Search regression metrics and CI gates.
* Managed instructions for AGENTS.md, Claude Code, GitHub Copilot, and Cursor.
* JavaScript programmatic API and TypeScript declarations.
* Data-loss-resistant formatting that refuses malformed or unknown metadata.
* Strict configuration, registry-state, path-boundary, and CLI option validation.
* Redirect-aware bounded context and monorepo root discovery.
