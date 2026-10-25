# Changelog

All notable changes to this project are documented here.

The npm package follows Semantic Versioning. The `llmnav/N` source protocol is versioned independently.

## [0.16.0] — 2026-10-25

### Added

* Opt-in, shared-budget live source excerpts in discovery (`includeSource`, `sourceBudget`; CLI `--include-source`, `--source-budget`). Agents can locate and inspect a candidate in one call instead of immediately rereading the file. Default discovery results and ranking stay unchanged.
* Agent tool schema version 5 describes the optional excerpt inputs; excerpt text uses normalized LF, UTF-8 byte limits and explicit truncation.

### Evaluation

* Add matched before/after coding conditions, independent installation preflights and sanitized item-type and source-payload counters.
* Record 40 coding attempts: bounded excerpts reduced required-navigation total input 7.4%, while neither the required-use nor optional-use cohort established uncached-token savings against ordinary navigation. Preserve all attempts and cache counters in the token cost review.

### Changed

* Installed agent instructions start known-file or exact-identifier work with ordinary bounded reads/searches, use semantic navigation when location or responsibility is unclear, and avoid redundant show/context/file-read calls.

## [0.15.3] — 2026-10-25

### Fixed

* Publish MCP read-only annotations so automatic clients can classify repository reads; distinguish opt-in index generation from live discovery without changing input or result contracts.

### Evaluation

* Add reproducible Serena symbol lookup and controlled model coding pilots on copied TypeScript and Go production source, with mutation controls, independent acceptance checks and sanitized tool metadata.

## [0.15.2] — 2026-10-23

### Fixed

* Exclude LLMNav's runtime scratch, state, transaction and cache directories from source collection, including explicit source paths, so local tooling cannot contaminate generated cache snapshots.
* Canonicalize Go project, package and selected-source identities together so Windows short-path aliases do not trigger false repository-escape errors.

### Documentation

* Add Bun project and global installation instructions, including the Node.js 22 runtime requirement.

## [0.15.1] — 2026-10-23

### Fixed

* Classify TypeScript method receivers as references and unwrap explicit callee expressions when identifying calls.
* Attribute Go local variable initializers to the enclosing callable and recognize generic and parenthesized call targets.

## [0.15.0] — 2026-10-23

### Added

* Opt-in TypeScript Compiler API 5/6 and Go standard-library type-checker adapters through `analyze` and `analyzeProject`, with alias/name/member binding, existing semantic-ID attachment, and generated structural IDs.
* Freshness-proved graph input schema 2; retain schema 1 compatibility and reject stale edited, added or deleted compiler inputs.
* `discover --precise` and `llmnav_discover` `precise` input (tool definition schema 4), returning compiler provenance and IDs usable with existing show/context operations.
* Bounded compiler subprocess deadlines, cancellation and output; atomic analysis publication, optional partial diagnostics, offline Go metadata and no project execution.

## [0.14.0] — 2026-10-23

### Added

* `discover` CLI, `discoverProject` API and appended `llmnav_discover` tool (tool schema version 3) search live paths and heuristic declarations before initialization, with explicit provenance and no generated semantic contracts.
* Opt-in `mcp --auto-generate`: detect source edits, additions, moves, deletion and metadata changes at request boundaries; generate incrementally before loading the shared session. Report preparation status and failures without returning stale data.

### Fixed

* Match Latin aliases at word boundaries while preserving CJK substring aliases.
* Stop excluded-only text from creating normal search hits. Use `excludes: <text>` to inspect excluded responsibilities explicitly, with an `excludes=` reason and no graph expansion.
* Include `.mts` and `.cts` in default source selection, TypeScript declaration/import extraction, and local graph resolution. Declaration files follow the existing `.d.ts` inclusion policy.

## [0.13.5] — 2026-10-23

### Changed

* Reuse module membership and preselected Go import targets instead of rebuilding them for each import, retaining target ordering and edge deduplication.
* Resolve registry paths iteratively and classify all cycle-reaching IDs in one graph pass, preserving replacement ambiguity and the first cycle witness.
* Read each generated artifact once per verification phase with bounded concurrency. Reuse staged exact-byte proofs only within staging; independently recheck installed files before commit and retain deterministic error selection.
* Discover Go module metadata with the configured I/O concurrency limit and avoid revisiting shared ancestor directories.

## [0.13.4] — 2026-10-23

### Fixed

* Bound shared MCP session loads independently of request deadlines; cancel abandoned loads, detach timed-out refreshes, and prevent late snapshot publication.
* Forward cancellation to native file reads and preserve original timeout and shutdown reasons.
* Preserve write, handle-close, and cleanup failures together, serialize bounded aggregate causes, and retain JSON parse causes.

### Added

* `runRead` and optional file `readPolicy` with a 15-second deadline, zero retries by default, and opt-in capped exponential backoff with jitter for transient idempotent reads. Write workflows remain single-attempt.

## [0.13.3] — 2026-10-23

### Fixed

* Serialize generation-lock publication, stale-owner reclamation, and release through a mutation guard so a stale observation cannot displace a live owner; retry transient Windows guard-read sharing errors.
* Serialize formatting with other repository writers and reject source changes detected immediately before replacement with `LLMNAV_WRITE_CONFLICT`.
* Stop MCP stdio waits on cancellation, output closure, or errors, and remove drain, close, error, and abort listeners on every exit.
* Prevent late older session and host refreshes from replacing newer successful snapshots, including prompt partitions and generation hashes.

### Changed

* A dead or unreadable mutation guard requires stopping all LLMNav processes and explicitly removing the guard before retrying. Dead main generation locks remain automatically recoverable.

## [0.13.2] — 2026-10-23

### Fixed

* Detach generated card imports and reused search-index phrase and posting arrays from caller-owned inputs.

### Changed

* Separate lexical scoring, result ranking, artifact assembly, line-card scanning, and relation validation into focused operations while preserving output and error precedence.
* Separate lock publication and committed or interrupted transaction recovery while retaining cleanup and retry behavior.
* Name audit scoring, representative selection, ID matching, declaration scanning, and token estimation policies without changing their values.

## [0.13.1] — 2026-10-23

### Fixed

* Retry transient filesystem errors with the production sleep implementation and reject invalid retry schedules.
* Preserve another writer's temporary file on name collisions; clean only files created by the current atomic write.
* Preserve all rejected values, including undefined, through concurrent work and generation lock cleanup.
* Apply MCP deadlines to session loading and execution, honor cancellation with disabled timers, and reject overflowing timer delays.
* Bound lock polling by elapsed time and propagate cancellation through repository reads and agent operations.
* Refresh MCP sessions after alias or configuration changes and follow configured cache directories.
* Rebuild search data for mutable caller-owned indexes while retaining prepared lookups inside project sessions.

### Added

* Optional scheduler hooks and read I/O hooks for deterministic tests without changing required arguments or result envelopes.

## [0.13.0] — 2026-10-22

### Added

* Accept `ioConcurrency` (default 8) on `generateProject`, `scanProject`, `scanProjectIncremental`, `auditProject`, `collectSourceFiles`, and `doctorProject` to bound how many source reads, directory listings, artifact comparisons, and manifest hash checks run at the same time.

### Performance

* Compare generated files, verify manifest hashes, and read sources with bounded concurrency, so a full rebuild waits less on the filesystem. On a 400-file fixture one full reparse took 590–660 ms at `ioConcurrency: 1` and 335–390 ms at the default limit on one Windows machine; discovery order and generated bytes stay identical at any limit.
* Index dependent cards once per generation instead of scanning every card for each changed card, which keeps a wide refactor from going quadratic.
* Cache card, graph-node, and Go module lookups per immutable snapshot instead of rebuilding them on every query.
* Inspect each audit module and file once, and read workspace `package.json` files concurrently, instead of rescanning them per comparison.

## [0.12.0] — 2026-10-22

### Added

* Export `LlmnavError`, `ERROR_CODES`, `createIoError`, `causeChain`, `toErrorPayload`, `errorCode`, `isAbortError`, `isRetryableError`, and `withDeadline`, so a host can classify a failure as retryable and read its cause instead of parsing a message.
* Add `withDeadline(operation, timeoutMs, promise, { signal })`. A deadline reports a timeout without cancelling the underlying work, and `0` disables it.

### Changed

* `createMcpServer` accepts `requestTimeoutMs` (default 15 seconds, `0` disables it) and answers with a JSON-RPC internal error carrying `data.code === "LNV102"` when one tool call outlives the deadline.
* Report MCP failures as `error.data` holding `{ code, retryable, cause }` rather than a message alone, so a client can tell a transient filesystem failure from a permanent one.
* Treat a cache artifact whose `stat` fails for a reason other than absence as a failure instead of a missing file, so a session no longer freezes on a stale snapshot after a permission or handle error.
* Stop waiting for the generation lock as soon as the caller's `signal` aborts.

### Fixed

* Keep the underlying error as the cause when `index.json` or `manifest.json` is malformed.
* Print the stable error code and, under `LLMNAV_DEBUG=1`, the cause chain from the CLI.

## [0.11.2] — 2026-10-22

### Fixed

* Merge active semantic IDs inside the generation lock and re-read the registry there, so two concurrent generations can no longer drop each other's newly registered IDs.
* Retry releasing the generation lock and force-drop a lock that still names this process, so one failed release cannot block every later generation; when both the generation and the release fail, both errors are reported instead of the release masking the original failure.
* Load one prepared session per concurrent MCP burst and wait for output drain before reading the next request, so bursts no longer multiply index loads and a slow or closed stdout no longer grows an unbounded buffer.
* Remove the partially written temporary file when an atomic write fails, so failed writes leave no orphaned `*.tmp-*` files.
* Resolve relations during agent check against the prepared session registry, include the registry in the MCP session stamp, and plan plus apply a migration under a single generation lock, so checks cannot read a half-swapped registry and a concurrent generation cannot invalidate a migration plan.

## [0.11.1] — 2026-10-22

### Changed

* Split record validation, the agent operation pipeline, generation and commit phases, audit analysis, the incremental scan, and the literal-mask parser into named stages with unchanged output, so diagnostics keep their order, parsed offsets stay identical, and generated artifacts are byte-for-byte the same.
* Centralize search ranking scores, input limits, and audit bounds in `src/policy.js` so the CLI help, the provider-neutral tool schema, and runtime defaults read one source of truth.

### Fixed

* Return detached card objects from `queryIndex`, `queryIndexLegacy`, `queryProject`, and the project session query, so mutating a result can no longer corrupt the cached index snapshot.

## [0.11.0] — 2026-10-22

### Added

* Accept an optional `signal` (`AbortSignal`) on generation, scanning, query, context, audit, and source-collection entry points. Long operations stop at cooperative checkpoints, a cancelled commit rolls the cache back like any other failure, and omitting the signal keeps the previous behavior.
* Export `createAbortError` and `throwIfAborted` so hosts can share one cancellation shape, and preserve an `Error` passed to `controller.abort(error)` unchanged.
* Export `createRuntime` and `DEFAULT_RUNTIME` as one injectable seam for the clock, process id, randomness, sleeping, environment lookup, and process liveness used by generation locks and transaction identifiers.

### Changed

* Match `excludeFiles` globs without `/` against file names at any depth, so the documented defaults such as `*.min.js` also exclude generated bundles inside subdirectories. Patterns with `/` stay anchored at the repository root, and `**` spans directories only when it occupies a whole path segment.
* Reject invalid generation-lock timing options up front and fail immediately on a lock owner record that cannot be read, instead of waiting out the full lock timeout.

### Fixed

* Raise `TransactionAbortError` from an abort failpoint instead of exiting the host process inside the library, while the CLI keeps exit code 86.
* Report the original generation error when the transaction journal itself is corrupt instead of replacing it with a parse error.
* Charge the truncation ellipsis against the token budget and never split a surrogate pair, so bounded prompts stay inside the requested budget.
* Detect a regenerated cache inside the same millisecond in the MCP server by stamping artifacts with nanosecond timestamps and file identity.

## [0.10.1] — 2026-10-22

### Performance

* Keep one prepared index snapshot inside the MCP server and reload it only when the generated cache artifacts change, so repeated `tools/call` requests skip the per-call cache read while a regenerated index is still picked up on the next call.

## [0.10.0] — 2026-10-22

### Added

* Add `llmnav_audit`, a sixth provider-neutral agent tool and MCP tool that returns the unannotated-boundary candidates from `llmnav audit`, filtered by a minimum priority and bounded by a candidate count, with the audit summary and an explicit truncation flag.
* Bump provider-neutral tool definitions to schemaVersion 2 so a host can detect that the stable tool set gained a definition; the operation envelope stays schemaVersion 1.

## [0.9.9] — 2026-10-22

### Added

* Serve the stable agent tool schema over the Model Context Protocol stdio transport with `llmnav mcp`, mapping `initialize`, `ping`, `tools/list`, and `tools/call` onto the existing provider-neutral operation dispatcher and returning the schemaVersion 1 envelope as tool content.

## [0.9.8] — 2026-10-22

### Fixed

* End declaration bodies at the real body brace instead of the first brace of a parameter or return type, so TypeScript object parameters, destructured props, object return types, generic constraints, and Go `interface{}` bodies produce distinct body hashes and appear in generation change reports instead of looking unchanged.
* Keep declaration signatures whole across type annotations, and stop Python signatures at the header colon instead of a brace inside a string literal.
* Serialize initialization and the following generation under one generation lock, so concurrent `init` or `generate` runs cannot overwrite each other, and let a rerun reclaim a lock whose owner process was killed.
* Check all selected agent instruction files before bootstrap writes and reject duplicate closing markers; malformed later adapters no longer leave earlier instructions or forced configuration partially updated.
* Preserve team instructions before managed agent blocks when the generated heading is missing, renamed, or separated from the marker by unrelated text.
* Infer valid repository IDs for numeric-leading and long package names so fresh initialization can generate its first index; preserve existing valid short IDs and distinguish long names with a deterministic suffix.
* Reject invalid agent selections before bootstrap writes and reject `all,none` combinations instead of installing every agent's instructions.
* Validate package JSON and script-object inputs before initialization changes files; preserve existing bootstrap state on invalid forced initialization and avoid echoing malformed manifest contents in diagnostics.

## [0.9.7] — 2026-09-28

### Fixed

* Recognize Go and Rust raw string boundaries before scanning LLMNav cards, preserving real cards and leaving card-shaped literal text untouched.
* Rank evaluation queries with the same repository graph used by project queries and sessions.
* Read prompt bundles under the generation lock and let hosts refresh prompt partitions and search from one generation snapshot.
* Validate the primary index against its manifest before trusting cached search and graph data, while retaining manifestless schema v1 reads.
* Reuse persisted parsed file state only when its manifest hash, record shape, and local stat-hint generation agree; otherwise read source and rebuild safely. Explicit caller-provided state remains reusable.
* Classify missing and ambiguous semantic IDs consistently across show and context agent operations.
* Report whether retrieval evaluation passed, failed, was invalid, or lacks enough cases; allow API callers to require a minimum case count without changing the default CLI exit behavior.
* Evaluate explicit no-result queries separately from positive recall, and require every no-result case to return no cards before evaluation passes.

### Performance

* Narrow session ID substring checks to precomputed candidates and resolve alias targets directly, preserving direct-query results and ranking.

## [0.9.2] — 2026-09-09

### Fixed

* Recognize JavaScript/TypeScript regular-expression literals while masking source strings, so quotes and comment-like text inside regexes do not hide later cards or create false cards. Preserve division expressions and ordinary JSX closing tags.
* Invalidate older parsed-file caches so unchanged consumer files receive the corrected parsing behavior.

## [0.9.1] — 2026-09-07

### Fixed

* Explain unsupported or disallowed hard-link lock publication, preserve its filesystem error, and verify installed host show, bounded context, and refresh operations.
* Prevent inherited npm `allow-scripts` environment policy from breaking isolated package installation smoke checks; installation lifecycle scripts remain disabled.
* Synchronize the public package-version constant with 0.9.1 and check both npm manifests in the normal test suite.
* Publish complete generation lock records atomically, clean up failed preparation, and explain repair of unreadable legacy locks.
* Hold the generation lock throughout search and registry snapshot reads.
* Apply context edge limits when falling back to semantic relations without a usable graph.

### Performance

* Distribute search postings to card-range shards in one pass while preserving byte-identical manifests and artifacts.
* Prepare card lookups, normalized IDs and aliases, and graph validation once per session snapshot; detach query and show results to protect cached state from caller mutation.
* Measure fresh-process session startup, graph-aware query and context latency, and refresh separately, with result parity checks against direct navigation APIs.
* Reuse graph adjacency and traversal ordering within project sessions; refresh rebuilds that state while direct query APIs continue to accept mutable graph inputs.
* Count removed graph partitions with keyed membership instead of scanning all current partitions for each previous key.

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
