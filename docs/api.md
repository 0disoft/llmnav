# Programmatic API

The npm package exposes the deterministic operations used by the CLI. It is ESM-only, requires Node.js 22 or newer, and ships TypeScript declarations.

```js
import {
  generateProject,
  parseLlmnavBlocks,
  queryProject,
  scanProject,
  validateProject,
} from "llmnav";
```

## Parse one source string

```js
import { parseLlmnavBlocks } from "llmnav";

const blocks = parseLlmnavBlocks(source, "src/session.ts");
for (const block of blocks) {
  console.log(block.card.id, block.startLine);
}
```

Parsing does not perform project-level semantic validation. Read `syntaxErrors` on each block or validate a scanned project.

## Canonicalize one source string safely

```js
import { canonicalizeSource } from "llmnav";

const result = canonicalizeSource(source, "src/session.ts");
if (result.errors.length > 0) {
  throw new Error(result.errors.map((item) => item.message).join("\n"));
}
console.log(result.source);
```

Canonicalization refuses to erase unknown fields, malformed lines, or duplicate scalar fields. Unsafe blocks remain byte-for-byte unchanged.

## Scan and validate a repository

```js
import { scanProject, validateProject } from "llmnav";

const project = await scanProject(process.cwd());
const diagnostics = validateProject(project);
const errors = diagnostics.filter((item) => item.severity === "error");
```

`scanProject` performs a full source read. Use `scanProjectIncremental` when building a persistent tool that can reuse `.llmnav/cache/file-state.json`.

```js
import { scanProjectIncremental } from "llmnav";

const { project, fileState, stats } = await scanProjectIncremental(process.cwd());
console.log(stats.parsedFiles, stats.reusedFiles);
```

Stat hints are an optimization, not deterministic output. The returned `fileState` contains only repository-relative generated data.

Attached symbol declarations expose generated `language`, `exported`, `visibility`, optional Go `receiver`, `endOffset`, and declaration `bodyHash` fields. Indexed cards also expose sorted artifact, route, event, schema, migration, runtime, and command `boundaries` with confidence and evidence.

## Audit annotation coverage

```js
import { auditHasFindings, auditProject, explainProjectFile } from "llmnav";

const result = await auditProject(process.cwd());
for (const candidate of result.candidates) {
  console.log(candidate.priority, candidate.path, candidate.reasons);
}

if (auditHasFindings(result, "high")) process.exitCode = 1;

const explanation = await explainProjectFile(process.cwd(), "src/runtime.ts");
console.log(explanation.status, explanation.candidate?.score, explanation.recommendation.action);
```

`auditProject` is read-only and returns schemaVersion 1 data with repository-relative paths and deterministic ordering. Candidate signals are structural heuristics, not generated semantic meaning. Exact reviewed decisions from `audit.dispositions` are returned separately with `suppressed` or `stale` status; `auditHasFindings` considers only active candidates. `explainProjectFile` applies the same analysis to one path, preserving candidate score evidence and package-level coverage without mutating source. Consumers should review high and medium candidates before adding a card and should never turn a suggested coverage rule or recommendation into automatic source annotation.

## Generate incrementally and transactionally

```js
import { generateProject } from "llmnav";

const result = await generateProject(process.cwd());
if (!result.ok) {
  console.error(result.diagnostics);
  process.exitCode = 1;
}

console.log(result.changedCards);
console.log(result.affectedBoundaries);
console.log(result.affectedCatalogs);
console.log(result.incremental.files);
console.log(result.incremental.cards);
console.log(result.incremental.graph);
console.log(result.transaction);
```

`result.index.contractFingerprints` contains deterministic `exportedApi` and `configuration` SHA-256 values. A changed fingerprint produces a non-failing `LNV009` diagnostic so callers can require explicit contract review without treating every body edit as an API change.

Each `affectedBoundaries` record identifies the changed semantic ID, changed hash dimensions, module, generated structural boundaries, outbound semantic relation targets, and cards that depend on the changed ID. Records and nested IDs use deterministic ordering.

Default generation reuses file and card state and commits cache changes through a recoverable directory transaction.

A read-only drift check is explicit:

```js
const result = await generateProject(process.cwd(), { check: true });
```

A forced full rebuild is available for verification and benchmarks:

```js
const result = await generateProject(process.cwd(), { incremental: false });
```

`incremental: false` reparses every source file and retokenizes every card. It must produce the same deterministic cache bytes as incremental generation.

Independent source reads and directory listings run with at most `ioConcurrency` tasks in flight:

```js
const scan = await scanProject(process.cwd(), { ioConcurrency: 4 });
```

The default is 8. The limit changes only how long a scan takes: records keep discovery order, diagnostics keep their ordering, and generated bytes are identical at any limit. `generateProject`, `scanProject`, `scanProjectIncremental`, and `auditProject` accept it; a value that is not a positive integer raises a `TypeError`.

Failure injection options exist for the repository test suite and are not a normal application interface.

## Inject the generation runtime in tests

Time, process identity, randomness, sleeping, environment lookup, and process liveness come from one injectable object:

```js
import { createRuntime, generateProject } from "llmnav";

const runtime = createRuntime({
  now: () => 1_700_000_000_000,
  pid: 4242,
  randomHex: () => "abcdef",
});

await generateProject(process.cwd(), { runtime });
```

`createRuntime` fills omitted fields from `DEFAULT_RUNTIME`, which reads the real clock, process id, cryptographic randomness, `process.env`, and OS process liveness. Unknown keys raise a `TypeError`, so a misspelled field cannot quietly fall back to production behavior. The same object can be passed as `lockOptions.runtime` to `acquireGenerationLock` or `withGenerationLock`.

## Cancel long-running work

`generateProject`, `queryProject`, `scanProject`, and `auditProject` accept an optional `signal`:

```js
const controller = new AbortController();
const pending = generateProject(process.cwd(), { signal: controller.signal });
controller.abort("user cancelled");
await pending; // rejects with the abort reason
```

Cancellation is cooperative. Generation checks the signal while scanning, between graph and identifier work, and at every commit phase; a cancelled commit behaves like any other failure and rolls the cache back to its previous bytes. Queries check between ranking passes, and audits check between candidate modules. Omitting `signal` keeps the previous behavior, and an already-aborted signal fails before the first mutation.

`throwIfAborted(signal)` performs the same check in caller code, and `createAbortError(signal)` normalizes a signal into one error. An `Error` passed to `controller.abort(error)` is rethrown unchanged; any other reason becomes an `AbortError`.

A generation that is waiting for the lock also stops waiting when its signal aborts, so a cancelled CLI or editor command does not sit out the full lock timeout.

`loadSearchData`, `createProjectSession`, `showProjectCard`, `buildContext`, and `executeAgentOperation` also accept `signal` in their existing optional options object. Session `show`, `query`, `context`, and `refresh` accept a per-call signal. A creation signal applies to the initial load; it is not retained for future refreshes. Lock release and transaction rollback finish even after cancellation. Ownership changes are serialized by a short-lived `generation.lock.guard`. Dead main owners are recovered automatically. If a process dies while changing ownership and leaves a dead or unreadable guard, stop all LLMNav processes before removing that guard and retrying. All processes sharing a repository must use the same locking protocol. PID-based recovery coordinates processes on one host; a repository shared across hosts requires an external coordination authority.

`formatProject` serializes source rewrites with the repository generation lock. A source change detected immediately before replacement rejects with `LLMNAV_WRITE_CONFLICT`; retry reads and formats the current file. Check mode remains read-only. Editors and other tools that bypass this lock must be coordinated separately: the filesystem replacement does not provide CAS against nonparticipating writers.

For deterministic tests, lock options accept `scheduler.now`, a monotonic millisecond clock. Polling is clamped to the remaining timeout; zero permits one immediate acquisition attempt. `loadConfig`, `loadSearchData`, `queryProject`, `createProjectSession`, `scanProject`, and `scanProjectIncremental` accept an optional `io.readFile(path, "utf8", { signal })` hook. Existing two-argument hooks remain supported. Native reads receive the signal, and omitted hooks keep path-safety checks intact.

## Report failures with a cause and a deadline

`withDeadline` accepts an optional `scheduler` with `setTimeout` and `clearTimeout` hooks. Deadlines range from zero to 2147483647 milliseconds; zero disables only the timer, while cancellation remains active. Already-aborted signals reject with their original reason. MCP request deadlines include session loading; a timed-out caller does not cancel a shared session load needed by other requests. Synchronous ranking remains cooperative and cannot be interrupted by a timer while it occupies the event loop.

Filesystem failures keep the original system error as `cause`, and the wrapper carries a stable code plus a retry classification:

```js
import { causeChain, createIoError, isRetryableError, toErrorPayload } from "llmnav";

try {
  await readSomething();
} catch (error) {
  const wrapped = createIoError("read", ".llmnav/cache/index.json", error);
  wrapped.code;        // "LNV100"
  wrapped.retryable;   // true for EACCES, EBUSY, EAGAIN, EMFILE, ENFILE, EPERM
  causeChain(wrapped); // [{ name, code, message }, ...] bounded and cycle-safe
  toErrorPayload(wrapped); // { code, retryable, cause } for a JSON-RPC or HTTP body
}
```

`ERROR_CODES` names the io codes (`LNV100` read, `LNV101` write) and the deadline code (`LNV102`). Retry only what `isRetryableError` marks as transient, and only for idempotent work: a write that may have partially applied should be reconciled from the transaction journal, not replayed. Generation and commit paths never retry themselves.

`withDeadline(operation, timeoutMs, promise, { signal })` bounds an awaited operation without running anything in the background:

```js
import { DEFAULT_REQUEST_TIMEOUT_MS, withDeadline } from "llmnav";

const result = await withDeadline("query request", DEFAULT_REQUEST_TIMEOUT_MS, queryProject(root, task));
```

A deadline rejects with `code: "LNV102"` and `retryable: false`; it does not cancel the underlying promise, so a timed-out read is abandoned rather than guaranteed stopped. `timeoutMs: 0` disables the deadline. The MCP server applies the same deadline per tool call through `requestTimeoutMs`.

Aggregate failures also include an optional `errors` array of cause chains. Nested aggregates share a 32-error budget, with at most eight entries per aggregate and eight levels of nesting. Atomic writes preserve write, close, and temporary-file cleanup errors together; parser wrappers retain the original syntax error as `cause`.

`runRead(label, read, options)` supplies a native signal to an idempotent read and cancels it on timeout or caller cancellation. Its default total deadline is 15000 ms and default retry count is zero. Set `timeoutMs: 0` to disable its timer. File-read APIs accept the same policy in `readPolicy`; their existing caller `signal` controls cancellation.

```js
import { runRead } from "llmnav";

const value = await runRead("read metadata", ({ signal }) => adapter.read({ signal }), {
  signal: callerSignal,
  timeoutMs: 5000,
  maxRetries: 2,
  baseDelayMs: 25,
  maxDelayMs: 250,
});
```

Retries use capped exponential backoff with full jitter. The total deadline includes every attempt and wait; cancellation, timeouts, and permanent failures stop retries. The default retry predicate allows only `EBUSY`, `EAGAIN`, `EMFILE`, and `ENFILE`. Permission errors require an explicit operation-specific `retryWhen` policy. `maxRetries` ranges from zero to ten; `random` and `scheduler` are injectable for tests. Adapters must honor the supplied signal. An adapter that ignores cancellation can keep running after its caller stops waiting, so timeouts never retry that attempt.

Use this wrapper only around individual idempotent reads. Search/session loading also acquires locks and recovers transactions, so its entire workflow must not be replayed as a read. Generation, initialization, formatting, and registry writes retain zero workflow retries; their existing rename/remove retries belong to the owned transaction recovery protocol.

MCP shared session loads have a separate 15000 ms deadline, configurable with `sessionLoadTimeoutMs`. A request timeout leaves other subscribers' work running. A shared-load timeout cancels its own signal, detaches the old session, and permits the next request to load again; late abandoned loads cannot publish snapshots. Server shutdown cancels shared loading with the original reason.

Generation verification uses at most eight concurrent file reads, preserves sorted failure precedence, and completes pending reads before rollback. Each staged artifact is read once for exact-byte and manifest verification; installed files are independently reread after the directory swap. Go module discovery uses the scan's `ioConcurrency` limit and retains sorted module output and metadata symlink checks.

Registry resolution uses an explicit traversal stack and path-position lookup, so long redirect chains do not consume the JavaScript call stack. Shared acyclic replacement branches are visited once per resolution. Multi-target candidates retain their input order and remain ambiguous; cycle results retain the first depth-first witness. Validation classifies cycle-reaching IDs in linear graph work without constructing a result chain for every ID.

## Build and update an inverted index

```js
import { buildInvertedIndex } from "llmnav";

const initial = buildInvertedIndex(index);
const updated = buildInvertedIndex(nextIndex, initial.searchIndex);

console.log(updated.stats.indexedCards);
console.log(updated.stats.reusedCards);
```

The previous index is reused only when schema version, tokenizer version, field order, and repository ID match. Incremental and full builds serialize identically for the same primary index. Returned phrase and posting arrays are independent of the previous index, so editing either index does not alter the other. `buildArtifactSet` also copies card imports from the supplied project records.

Useful lower-level exports include:

```js
import {
  buildSearchDocument,
  isCompatibleSearchIndex,
  searchCardSetHash,
  searchDocumentHash,
  verifySearchIndex,
} from "llmnav";
```

## Query a generated project

```js
import { queryProject } from "llmnav";

const results = await queryProject(process.cwd(), "replayed refresh token", {
  top: 5,
});
```

`queryProject` recovers an interrupted transaction, loads `index.json`, loads or validates `search-index.json`, and applies repository aliases. Result limits are bounded from 1 to 100.

## Query in-memory indexes

```js
import { queryPreparedIndex } from "llmnav";

const metrics = {};
const results = queryPreparedIndex(index, searchIndex, "reserve credits", {
  top: 5,
  lexicon: { aliases: {} },
  metrics,
});

console.log(metrics.documentTokenizations); // 0
```

`queryIndex(index, query)` builds an in-memory inverted index when one is not supplied, so edits to caller-owned cards are visible on the next call. For repeated queries, use a prepared index or a project session; only session-owned token lookup tables are cached. Callers supplying an explicit inverted index must rebuild it after changing cards.

`queryPreparedIndex` borrows card and location objects from the supplied index. Clone these before exposing them to consumers that may edit them, or use `queryIndex` or a project session for detached results. `metrics` is an output object that the query updates intentionally; cancellation can leave partial counts.

`queryIndexLegacy(index, query)` retains the v0.1-compatible per-query retokenization path for regression tests and migration measurement. New integrations should not use it in production.

## Inspect changed cards and catalogs

```js
import { compareCardIndexes, describeAffectedCatalogs } from "llmnav";

const changes = compareCardIndexes(previousIndex, currentIndex);
const catalogs = describeAffectedCatalogs(
  changedFiles,
  config.generation.cacheDirectory,
  config,
  previousIndex,
  currentIndex,
);
```

Changed-card records distinguish semantic, structure, and body dimensions. Catalog records include only repository, module, agent-context, and prompt-prefix artifacts.

## Recover or commit a cache transaction

Most callers should use `generateProject`. Lower-level transaction functions are exported for integration testing and specialized hosts.

```js
import { recoverGenerationTransaction } from "llmnav";

const recovery = await recoverGenerationTransaction(root, {
  cacheDirectory: ".llmnav/cache",
});
```

`commitGeneratedCache` expects a complete artifact map and verifies the staged manifest before replacing the live cache. Its path and failure-injection options are deliberately strict.

## Resolve and build context

```js
import { buildContext, showProjectCard } from "llmnav";

const shown = await showProjectCard(root, "auth.session.renew");
const context = await buildContext(root, "auth.session.renew", {
  depth: 1,
  budget: 2500,
});
```

Redirected IDs resolve through `.llmnav/ids.jsonl` before source cards are selected.

## Constants

The package exports versioned generated-format constants:

```js
import {
  CONTRACT_FINGERPRINT_SCHEMA_VERSION,
  FILE_STATE_SCHEMA_VERSION,
  MIGRATION_REPORT_SCHEMA_VERSION,
  SEARCH_INDEX_ENCODING,
  SEARCH_INDEX_SCHEMA_VERSION,
  SEARCH_SHARD_ENCODING,
  SEARCH_SHARD_SCHEMA_VERSION,
  SOURCE_INDEXER_VERSION,
  TOKENIZER_VERSION,
  TRANSACTION_SCHEMA_VERSION,
  SARIF_VERSION,
} from "llmnav";
```

`migrateProject(root, { write: false })` returns a schemaVersion 1 compatibility report and a full-regeneration plan without committing generated artifacts. With `{ write: true }`, it applies a required upgrade through the same generation lock and recoverable transaction used by `generateProject`. Source validation errors stop the operation before mutation, and successful repeated writes are no-ops.

`diagnosticsToSarif(diagnostics)` maps existing diagnostics to a deterministic SARIF 2.1.0 object without discovering or mutating diagnostics.

`diagnosticsToEditor(diagnostics)` groups repository-relative diagnostics into schemaVersion 1 documents with zero-based ranges and stable severity mappings. `renderEditorDiagnostics` serializes the report deterministically. `getEditorIntegration("vscode")` returns a VS Code task and custom problem matcher without modifying editor files.

`buildSearchShards(index, searchIndex, shardSize)` returns a deterministic manifest and map of card-range shard contents. A size of zero or a card count at or below the limit returns no shard artifacts. The function slices compact postings and documents rather than rebuilding search documents.

`normalizeGraphInput(value, file, contentHash)` validates and normalizes one schemaVersion 1 definition/reference index. `loadGraphInputs(root, config)` reads configured repository-local inputs and returns normalized indexes plus deterministic `LNV014` diagnostics without executing project code.

`buildRepositoryGraph(project, index)` returns the schemaVersion 1 qualified node and edge graph. `renderRepositoryGraph(graph)` serializes it deterministically. Successful generation also exposes the graph as `result.graph` and writes it to `.llmnav/cache/graph.json`.

`buildRepositoryGraphIncremental(project, index, previousState)` returns `{ graph, state, stats }`. Compatible content-addressed partitions are reused; incompatible state is ignored. `compatibleGraphState` validates the disposable state boundary, and `renderGraphState` serializes `.llmnav/cache/graph-state.json`. `result.incremental.graph` reports total, reused, rebuilt, and removed partition counts.

`queryPreparedIndex` accepts an optional `graph`. Graph bonuses preserve lexical seeds and scale by edge confidence and direction. `buildContext` accepts `maxEdges` in addition to `depth` and `budget`, and returns the stable IDs of packed edges as `includedEdges`.

`resolveGraphNode(graph, id, localRepositoryId)` returns `resolved`, `ambiguous`, or `missing`. `renderGraphNode(node)` emits compact external definition context. `showProjectCard` returns either a local `card` or an external graph `node`.

The normative source vocabulary remains available from `llmnav/spec`.

`analyzeProject(root, { language, metadata: true })` opts into graph input schema 3 declaration metadata. `showProjectCard(root, id, { metadata: true, members?, top?, offset?, metadataBudget? })` adds a bounded metadata page; prepared sessions and MCP show accept the same options. Defaults continue to exclude metadata. See [compiler metadata](precise-analysis.md#opt-in-declaration-metadata) for type origins, unsupported declarations, snapshot freshness, byte budgets and follow-up paging.

```js
import { KEY_ORDER, EFFECT_KINDS, RISK_KINDS } from "llmnav/spec";
```

## Retrieval evaluation

`evaluateProject(root, { minimumCases: 1 })` requires at least one reviewed query before returning `ok: true`. The result's `status` is `passed`, `failed`, `insufficient`, `unmeasured`, or `invalid`. An empty dataset keeps the existing default `ok: true` for callers that use `eval` during setup, but always reports `status: "unmeasured"`; pass/fail gates should set `minimumCases` explicitly. The default CLI does not set this option.

Each query record requires a non-empty `query`. A positive case supplies at least one non-empty ID in `expected`; multiple IDs mean **any one** is an acceptable answer. A no-result case supplies `"expectNoResults": true` and omits `expected`. Recall@1, Recall@5, and MRR use only positive cases, while every no-result case must return zero cards for `status: "passed"`. At least one positive case is needed to pass. The current format does not require every listed ID to be found.

## Agent operation protocol

`getAgentToolDefinitions()` returns defensive copies of nine schemaVersion 7 tool definitions in fixed order. Their JSON Schema inputs reject unknown fields and deliberately omit the repository root.

```js
import { executeAgentOperation, getAgentToolDefinitions } from "llmnav";

const tools = getAgentToolDefinitions();
const result = await executeAgentOperation(
  process.cwd(),
  "llmnav_query",
  { task: "rotate a replayed refresh token", top: 5 },
);
```

The trusted wrapper binds `root`; the model supplies only the validated operation input. Results use one schemaVersion 1 envelope containing `operation`, `ok`, `data`, and `error`. Input errors use `LNVAP002`, missing IDs use `LNVAP404`, ambiguous IDs use `LNVAP409`, and unexpected operation failures use `LNVAP500`.

Long-lived hosts can load one explicit snapshot for repeated navigation calls:

```js
import { createProjectSession, executeAgentOperation } from "llmnav";

const session = await createProjectSession(process.cwd());
const result = await executeAgentOperation(
  process.cwd(),
  "llmnav_query",
  { task: "rotate a replayed refresh token" },
  { session },
);
await session.refresh(); // after generation or checkout changes
```

`query`, `show`, and `context` reuse the loaded index, postings, graph, lexicon, and registry. `refresh()` replaces the complete snapshot; it never mutates one layer in place. Concurrent refreshes publish in request order: an older completion cannot overwrite a newer successful refresh. Failed or cancelled refreshes leave the last published snapshot intact. The `check` operation still scans current source and does not use session data.

The MCP server refreshes sessions when configuration, aliases, registry records, or generated search artifacts change. Its artifact stamp follows `generation.cacheDirectory`, including non-default cache locations. The stdio transport observes cancellation while idle or waiting for output drainage, closes its reader, and removes its listeners on every exit. A closed output ends the transport successfully; other output errors and cancellation reject the serving operation. Caller-owned streams remain under caller control.

Each stdio request frame is limited to 1 MiB of UTF-8 bytes, excluding its CR/LF delimiter. The limit is enforced before line assembly, even without a delimiter or EOF. Overflow cancels active work and rejects `serveMcpStdio` with code `LLMNAV_MCP_FRAME_LIMIT`. Direct `handleLine` calls check the supplied line before JSON parsing and return JSON-RPC error `-32600` with a null ID on overflow.

Pass `{ withPromptBundle: true }` to `createProjectSession` when a host needs prompt partitions and navigation from the same generation. The returned session exposes `promptBundle` and a content-derived `generationHash`; `refresh()` replaces both alongside the search snapshot. The hash identifies generated cache content, not whether ungenerated source edits exist in the working tree.

Sessions prepare graph adjacency and traversal order once per snapshot for reuse by `query` and `context`. Refreshing prepares a new graph, and obsolete prepared state can be garbage-collected with the previous snapshot. Direct `queryIndex` and `queryPreparedIndex` calls do not cache caller-owned graphs, so in-place changes to supplied edges remain visible on the next call.

Private snapshots also prepare an ID resolver that reuses graph validation for `show` and `context`. Repeated ID resolution does not rescan edges; `refresh()` replaces the resolver together with the graph. Public `resolveGraphNode` continues to validate caller-owned graph edges on every call. Local ID preference, ambiguity and malformed-graph fallback remain unchanged.

Session queries also reuse card lookup tables, normalized IDs and aliases, and graph validation. Session ID substring checks use precomputed three-code-unit candidates before exact verification; direct queries retain their full ID scan. Phrase matching still scans all documents to preserve ranking. Session `query` and `show` return detached results: caller edits cannot invalidate the private prepared snapshot. These tables are rebuilt on `refresh()` and retained only with that snapshot.

The typed `llmnav/examples/provider-neutral-host.mjs` export composes these APIs into a trusted-root closure. It exposes tool definitions, base and module-selected prompt partitions, the generation hash, one snapshot-backed operation executor, and an explicit refresh method without importing a model SDK. Refresh prepares a complete replacement before switching the host's prompt and search references. A late older refresh cannot replace a newer successful host refresh.

`buildPromptPrefixBundle(input)` constructs ordered package, repository, and module partitions with normalized newlines, SHA-256 content hashes, estimated token counts, and explicit cache-boundary hints. `renderPromptPrefixBundle` serializes it deterministically. `loadPromptPrefixBundle(root)` accepts only a schema-compatible artifact whose exact bytes match `manifest.json`.

## Registry updates

`ensureActiveIds(root, registry, ids, options?)` re-reads the current on-disk registry under the generation lock before merging new IDs. If that file has parse or validation errors, the operation rejects with registry diagnostics and preserves its contents. Correct the current file before retrying; a caller's earlier snapshot is never used to overwrite invalid current data.

## Compatibility boundary

The public API follows package semantic versioning. `index.json` schemaVersion 1 and `llmnav/1` source syntax remain compatible. Contract fingerprints are optional additive index fields. `search-index.json`, `file-state.json`, `graph-state.json`, transaction journals, and performance metrics retain their own schema or implementation versions.

See [Compatibility and deprecation policy](compatibility.md) for the pre-1.0 stability classes, removal window, migration guarantees, and security exception.

## Discover source without a generated index

```js
import { discoverProject } from "llmnav";
const result = await discoverProject(root, "rotate session", { top: 5, signal });
```

Returns `{ schemaVersion: 1, repositoryId, results, matched, truncated }`. Each candidate carries `source` (`file` or `declaration`), `path`, one-based `line`, `cardIds`, `score`, and `reasons`. Declarations also carry `symbol`, `signature`, `kind`, and `language`. These are syntax heuristics, including nested declarations when within the shared scan budget; they do not provide type resolution, stable semantic IDs, or inferred business contracts. The operation reads selected live sources, honors include/exclude rules and cancellation, uses bounded file I/O, and writes nothing. `top` is an integer from 1 to 100.

Use `{ top: 1, includeSource: true, sourceBudget: 4000 }` to locate and inspect a candidate in one call. The optional `sourceExcerpt` contains `{ scope, startLine, endLine, text, truncated }`. Text comes from the existing live scan, with LF normalization and no second file read. `sourceBudget` is a shared UTF-8 text-byte limit, default 4,000, minimum 256 and maximum 16,000; JSON metadata is additional. Later candidates omit the excerpt when the budget is exhausted. Default calls omit all excerpts and preserve existing result fields and ranking.

`scope: "declaration"` uses the heuristic parser's declaration span. File and compiler hits use `scope: "window"`, starting at the candidate line; discovery does not extract compiler body-end coordinates. `truncated` describes byte-budget clipping, not semantic completeness. Read surrounding code when dependencies or behavior remain unclear. MCP accepts the same options on `llmnav_discover`; tool schema version 5 adds optional inputs without changing operation envelopes.

## Compiler analysis

`analyzeProject(root, { language, project?, typescriptPath?, pythonCommand?, allowErrors?, metadata?, signal?, timeoutMs? })` supports TypeScript, JavaScript, Go, Python and Rust. It returns diagnostics and schema 2 graph input (schema 3 with metadata). Python/Rust expose syntax precision and limitations rather than compiler resolution. `writeAnalysis` rechecks source freshness before atomic publication; `discoverProject(root, task, { precise: true })` searches configured saved definitions with explicit provenance. See [analysis support](precise-analysis.md).

## Local provenance

`getFileHistory(root, file, options?)` provides file-level Git history and current working state. `captureVerificationSnapshot(root, files, options?)`, `recordVerification(root, manifest, options?)` and `getVerification(root, id, options?)` retain caller-reported checks and assess source, environment and evidence applicability separately from outcomes. API callers can pass cancellation and detail budgets. MCP exposes read-only `llmnav_history` and `llmnav_verification`. See [local evidence](local-evidence.md) for manifests, unknown states and immutable local storage.
