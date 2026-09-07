# Changelog

All notable changes to this project are documented here.

The npm package follows Semantic Versioning. The `llmnav/N` source protocol is versioned independently.

## [Unreleased]

## [0.9.1] — 2026-09-07

### Fixed

* Publish complete generation lock records atomically, clean up failed preparation, and explain repair of unreadable legacy locks.
* Hold the generation lock throughout search and registry snapshot reads.
* Apply context edge limits when falling back to semantic relations without a usable graph.

## [0.9.0] — 2026-08-15

### Added

* Added `llmnav explain <file>` and `explainProjectFile` to report one file's navigation cards, module coverage, audit score evidence, reviewed disposition, and bounded next action without modifying source.

## [0.8.0] — 2026-08-15

### Added

* Added exact-path audit dispositions with mandatory review reasons, deterministic suppression, and stale-decision reporting so intentional non-cards do not reappear without becoming hidden permanent ignores.

## [0.7.4] — 2026-08-14

### Fixed

* Required npm provenance in package metadata, release validation, and the tag publication workflow so public Trusted Publisher releases fail closed if provenance is disabled.

## [0.7.3] — 2026-08-14

### Fixed

* Resolved repository-local Go module imports for annotation audit fan-in and repository graph edges, grouped Go audit candidates by package, recognized `cmd/*/main.go` entrypoints, suppressed `_test.go` support files, and invalidated graph partitions when module resolution changes.

## [0.7.2] — 2026-08-13

### Added

* Documented pre-1.0 stability classes, a one-minor and 90-day public API deprecation window, generated-format migration guarantees, and the limited security exception.

## [0.7.1] — 2026-08-13

### Fixed

* Revalidated managed-write parent identity and symbolic-link traversal immediately before atomic replacement, preventing a concurrent directory swap from redirecting source formatting or control-file writes outside the repository.

## [0.7.0] — 2026-08-13

### Added

* Added `llmnav migrate --check/--write` and `migrateProject` to report generated-format compatibility and apply full transactional upgrades from canonical source.
* Added migration regression coverage for read-only planning, idempotent writes, validation blocking, and transaction rollback.

## [0.6.6] — 2026-08-12

### Added

* Added a read-only cross-repository conformance matrix with repository-isolated validation, retrieval, audit, repeatability, cache-freshness, and held-language evidence.

### Fixed

* Invalidated parsed file-state caches created by older source indexers so upgraded installations rebuild semantic and declaration hashes from source instead of silently reusing incompatible state.

## [0.6.4] — 2026-08-11

### Fixed

* Rejected symlink and junction traversal across search caches, incremental state, and public registry reads and writes.
* Enforced parser card limits before materialization and replaced repeated interval and line-number scans with bounded indexes.
* Bounded aggregate declaration extraction work per source file, including malformed declarations and whitespace lookahead.

## [0.6.3] — 2026-08-11

### Fixed

* Rejected nested symlink and junction traversal before managed cache, state, schema, and prompt-bundle filesystem operations.
* Replaced per-marker lexical rescans with a bounded single-pass parser classification.
* Required npm release tags to resolve to commits on the protected `origin/main` lineage.

## [0.6.2] — 2026-08-11

### Added

* Added generated boundary signals for persistent dotted JSON filename protocols, versioned schema literals, and TypeScript Tauri invoke adapters.

### Fixed

* Stopped classifying high-fan-in domain contract hubs as broad utilities solely because they export many declarations.
* Made tag-driven publication create an idempotent GitHub Release after npm integrity verification or publication succeeds.

## [0.6.1] — 2026-08-10

### Added

* Added compact `audit --summary` output and repository-contained `audit --output <path>` reports.
* Added nested workspace package entrypoint discovery and Rust/Tauri command, module, and platform-lifecycle signals.

### Fixed

* Excluded Bun and pnpm package-manager caches from default source discovery.

## [0.6.0] — 2026-08-10

### Added

* Added semantic boundaries for configuration, source discovery and formatting, project scanning, declaration extraction, diagnostics, ID lifecycle, and the public protocol specification, with targeted coverage and retrieval regression queries.
* Added a deterministic, read-only `audit` command and public API that ranks likely missing module boundaries, explains every signal, suggests narrow coverage rules, and supports opt-in CI thresholds.
* Added generated agent guidance and an `llmnav:audit` package script so new repositories review coverage after initialization and structural changes.

### Fixed

* Suppressed declaration files and reduced false positives from tests, fixtures, benchmarks, broad utilities, and re-export barrels.

## [0.5.2] — 2026-08-09

### Fixed

* Made tag publication idempotent only when the existing npm tarball integrity matches the tagged package.
* Kept Trusted Publisher OIDC releases compatible with a private source repository by disabling unsupported provenance generation.
* Aligned the package author and MIT copyright holder with the public `0disoft` identity.

## [0.5.1] — 2026-08-09

### Added

* Added canonical-source `generate --full` verification for CI, release, and doctor gates.
* Added repository-scoped generation locking, transaction owner checks, and atomic cache, registry, and stable-order recovery.
* Added reusable project navigation snapshots with explicit refresh for long-lived provider-neutral hosts.
* Added runtime-to-declaration export parity coverage.

### Fixed

* Normalized foreign path separators, encoded SARIF artifact URIs, and blocked cache and staging path escapes.
* Corrected JavaScript import extraction and regex-body scanning, Python declaration body hashing, and Rust lifetime parsing.
* Invalidated pre-fix file-state accelerators so corrected declaration and import data is rebuilt from source.
* Preserved multi-target replacement ambiguity and detected cycles hidden in replacement branches.
* Synchronized public TypeScript declarations with runtime return values and graph-aware options.
* Normalized the npm executable path so current npm clients publish the `llmnav` binary without metadata correction.

## [0.5.0] — 2026-08-09

### Added

* Added stable provider-neutral agent tool schemas and a bounded operation dispatcher for query, show, context, and check.
* Added deterministic prompt-prefix bundles with explicit package, repository, and module cache partitions.
* Added deterministic zero-based editor diagnostics and a generated VS Code task integration.
* Added a runnable typed provider-neutral host example that binds repository authority outside tool input.

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
