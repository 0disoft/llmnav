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

Attached symbol declarations expose generated `language`, `exported`, `visibility`, optional Go `receiver`, `endOffset`, and declaration `bodyHash` fields. Indexed cards also expose sorted route, event, schema, migration, and command `boundaries` with confidence and evidence.

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

Failure injection options exist for the repository test suite and are not a normal application interface.

## Build and update an inverted index

```js
import { buildInvertedIndex } from "llmnav";

const initial = buildInvertedIndex(index);
const updated = buildInvertedIndex(nextIndex, initial.searchIndex);

console.log(updated.stats.indexedCards);
console.log(updated.stats.reusedCards);
```

The previous index is reused only when schema version, tokenizer version, field order, and repository ID match. Incremental and full builds serialize identically for the same primary index.

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

`queryIndex(index, query)` builds and weakly caches an in-memory inverted index when one is not supplied.

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

`diagnosticsToSarif(diagnostics)` maps existing diagnostics to a deterministic SARIF 2.1.0 object without discovering or mutating diagnostics.

`diagnosticsToEditor(diagnostics)` groups repository-relative diagnostics into schemaVersion 1 documents with zero-based ranges and stable severity mappings. `renderEditorDiagnostics` serializes the report deterministically. `getEditorIntegration("vscode")` returns a VS Code task and custom problem matcher without modifying editor files.

`buildSearchShards(index, searchIndex, shardSize)` returns a deterministic manifest and map of card-range shard contents. A size of zero or a card count at or below the limit returns no shard artifacts. The function slices compact postings and documents rather than rebuilding search documents.

`normalizeGraphInput(value, file, contentHash)` validates and normalizes one schemaVersion 1 definition/reference index. `loadGraphInputs(root, config)` reads configured repository-local inputs and returns normalized indexes plus deterministic `LNV014` diagnostics without executing project code.

`buildRepositoryGraph(project, index)` returns the schemaVersion 1 qualified node and edge graph. `renderRepositoryGraph(graph)` serializes it deterministically. Successful generation also exposes the graph as `result.graph` and writes it to `.llmnav/cache/graph.json`.

`buildRepositoryGraphIncremental(project, index, previousState)` returns `{ graph, state, stats }`. Compatible content-addressed partitions are reused; incompatible state is ignored. `compatibleGraphState` validates the disposable state boundary, and `renderGraphState` serializes `.llmnav/cache/graph-state.json`. `result.incremental.graph` reports total, reused, rebuilt, and removed partition counts.

`queryPreparedIndex` accepts an optional `graph`. Graph bonuses preserve lexical seeds and scale by edge confidence and direction. `buildContext` accepts `maxEdges` in addition to `depth` and `budget`, and returns the stable IDs of packed edges as `includedEdges`.

`resolveGraphNode(graph, id, localRepositoryId)` returns `resolved`, `ambiguous`, or `missing`. `renderGraphNode(node)` emits compact external definition context. `showProjectCard` returns either a local `card` or an external graph `node`.

The normative source vocabulary remains available from `llmnav/spec`.

```js
import { KEY_ORDER, EFFECT_KINDS, RISK_KINDS } from "llmnav/spec";
```

## Agent operation protocol

`getAgentToolDefinitions()` returns defensive copies of four schemaVersion 1 tool definitions in fixed order. Their JSON Schema inputs reject unknown fields and deliberately omit the repository root.

```js
import { executeAgentOperation, getAgentToolDefinitions } from "llmnav";

const tools = getAgentToolDefinitions();
const result = await executeAgentOperation(
  process.cwd(),
  "llmnav_query",
  { task: "rotate a replayed refresh token", top: 5 },
);
```

The trusted wrapper binds `root`; the model supplies only the validated operation input. Results use one schemaVersion 1 envelope containing `operation`, `ok`, `data`, and `error`. Input errors use `LNVAP002`, missing IDs use `LNVAP404`, and unexpected operation failures use `LNVAP500`.

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

`query`, `show`, and `context` reuse the loaded index, postings, graph, lexicon, and registry. `refresh()` replaces the complete snapshot; it never mutates one layer in place. The `check` operation still scans current source and does not use session data.

The typed `llmnav/examples/provider-neutral-host.mjs` export composes these APIs into a trusted-root closure. It exposes tool definitions, base and module-selected prompt partitions, one snapshot-backed operation executor, and an explicit refresh method without importing a model SDK.

`buildPromptPrefixBundle(input)` constructs ordered package, repository, and module partitions with normalized newlines, SHA-256 content hashes, estimated token counts, and explicit cache-boundary hints. `renderPromptPrefixBundle` serializes it deterministically. `loadPromptPrefixBundle(root)` accepts only a schema-compatible artifact whose exact bytes match `manifest.json`.

## Compatibility boundary

The public API follows package semantic versioning. `index.json` schemaVersion 1 and `llmnav/1` source syntax remain compatible. Contract fingerprints are optional additive index fields. `search-index.json`, `file-state.json`, `graph-state.json`, transaction journals, and performance metrics retain their own schema or implementation versions.
