# LLMNav

LLMNav is a deterministic semantic navigation layer for LLM coding agents.

It adds compact, stable metadata to a small number of architectural and behavioral boundaries, compiles that metadata into repository catalogs and a persistent inverted index, and gives agents a fast path from task language to the code that matters.

LLMNav is not a documentation generator, an embedding database, or a reason to annotate every function. It is a zero-runtime-dependency Node.js CLI and ESM library for reducing broad repository scans, irrelevant context, stale hand-written links, repeated card tokenization, and avoidable cache invalidation.

## What v0.5 provides

* The backward-compatible `llmnav/1` source comment specification
* A parser and data-loss-resistant canonical formatter
* Semantic lint rules with stable diagnostic codes
* A schemaVersion 1 `index.json` compatible with v0.1 consumers
* A deterministic persistent inverted index that reuses unchanged card tokenization
* File and card-level incremental indexing
* Repository-locked transactional cache generation with rollback and interrupted-run recovery
* Machine-readable changed-card, affected-boundary, and affected-catalog output
* Exported API and effective configuration contract fingerprints
* TypeScript and Go declaration enrichment with declaration-level body hashes
* Generated route, event, schema, migration, and command boundaries
* SARIF 2.1.0 diagnostic output
* Optional deterministic card-range search shards for very large repositories
* Strict repository-local imports for generated definition and reference indexes
* Deterministic qualified repository graphs with edge provenance and confidence
* Confidence-aware graph ranking and context packing bounded by depth, tokens, and edges
* Exact qualified and ambiguity-safe workspace semantic ID resolution
* Content-addressed incremental graph partitions with safe invalidation
* A runnable provider-neutral host adapter example with typed package export
* Repository and module catalogs designed for prompt-prefix reuse
* Multilingual alias routing and CJK n-gram retrieval
* Search regression tests with Recall@1, Recall@5, and MRR
* Managed instructions for AGENTS.md, Claude Code, GitHub Copilot, and Cursor
* Linux and Windows CI gates plus npm pack installation smoke tests

The package supports Node.js 22 or newer, uses ESM, performs no network requests, and has no runtime dependencies.

## Install

```sh
npm install --save-dev llmnav
npx llmnav init --agents all --package-scripts
```

Initialization is explicit. LLMNav never edits a consumer repository from an npm `postinstall` script. Use `--agents none` when only the machine-readable control directory is desired.

## Add the first card

```ts
/* llmnav/1 symbol
id=auth.session.rotate
role=Rotate one refresh-token family atomically and reject replayed tokens.
search=refresh token|token rotation|token family|replay detection
invariant=At most one live refresh token exists per family.
invariant=Replay revokes the entire token family.
effect=db.write(session_tokens)|event.emit(auth.session.revoked)
risk=auth|concurrency
rel=policy>auth.session.lifecycle
rel=test>auth.session.rotate.contract
stability=contract
*/

export async function rotateSession(
  input: RotateSessionInput,
): Promise<RotateSessionResult> {
  // implementation
}
```

The ID describes a durable capability, not a file path or current function name. It survives moves and renames.

## Generate and search

```sh
npx llmnav format
npx llmnav check
npx llmnav generate
npx llmnav query "replayed refresh token should revoke the family" --top 5
npx llmnav show auth.session.rotate
npx llmnav context auth.session.rotate --depth 1 --budget 2500
```

The generated inverted index stores a deterministic token dictionary, compact posting lists, and normalized phrase documents. A query tokenizes only the task text; it does not tokenize every card again. If `search-index.json` is missing or incompatible, the library rebuilds it in memory from the compatible schemaVersion 1 `index.json`.

## Incremental and transactional generation

The first generation parses every source file and indexes every card. Later runs compare persisted file state and volatile stat hints.

```text
unchanged stat fingerprint  → reuse parsed file without reading it
changed stat, same SHA-256  → reuse parsed file after one content read
changed content             → parse that file and retokenize changed cards only
deleted file                → remove its cards and postings
```

All generated cache artifacts are completed and verified in a staging directory before the live cache is replaced. If writing, verification, rename, or the process itself fails, the previous cache remains available or is restored before the next query or generation.

One repository-scoped generation lock serializes the complete source-to-cache operation. Readers wait for an active writer and recover only abandoned journals, so they cannot roll back a live generation. Windows transient rename failures such as `EPERM`, `EBUSY`, `EACCES`, `EEXIST`, and `ENOTEMPTY` are retried. CI executes the transaction and interruption suite on `windows-latest` as well as Linux.

## Machine-readable change output

```sh
npx llmnav generate --json
```

The JSON response preserves the v0.1 fields and adds stable records for changed cards, affected boundaries, affected catalogs, file reuse, card retokenization, and transaction recovery.

```json
{
  "changedCards": [
    {
      "id": "auth.session.rotate",
      "change": "modified",
      "dimensions": ["semantic"]
    }
  ],
  "affectedBoundaries": [
    {
      "id": "auth.session.rotate",
      "modules": ["auth.session"],
      "boundaries": [{ "kind": "route", "confidence": "high", "evidence": ["path"] }]
    }
  ],
  "affectedCatalogs": [
    {
      "file": ".llmnav/cache/modules/auth.session.txt",
      "kind": "module",
      "id": "auth.session"
    }
  ]
}
```

Locations and hashes are included in the complete records. Array ordering and generated JSON key ordering are deterministic.

## The core separation

| Layer | Examples | Owner | Storage |
| --- | --- | --- | --- |
| Stable meaning | role, invariant, domain search phrases, effects, risks, semantic relations | human or coding agent | source comment |
| Generated structure | path, declaration, language, visibility, boundaries, imports, fingerprints, hashes | LLMNav | generated cache |
| Task state | branch, diff, test output, current request | agent harness | never stored in a card |

Paths, line numbers, commit hashes, callers, imports, and signatures are forbidden in source cards. They change too often and are more accurately generated.

## Comment styles

C-style block comments work in TypeScript, JavaScript, Go, Rust, Java, C, C++, C#, Swift, Dart, PHP, Svelte, Astro, and Vue files.

```go
/* llmnav/1 module
id=auth.session
role=Own refresh-token issuance, rotation, replay detection, and revocation.
owns=refresh-token family|session revocation
excludes=access-token signing|user profile storage
search=session lifecycle|token family|session revocation
invariant=One token family has at most one live refresh token.
stability=architecture
*/
```

Line-comment cards require an explicit terminator and work with `//`, `#`, and `--`. HTML comments are supported for markup-oriented files.

## Commands

| Command | Purpose |
| --- | --- |
| `llmnav init` | Create configuration, registry, schemas, agent instructions, and the initial cache |
| `llmnav check` | Validate cards, relations, coverage rules, and registry state |
| `llmnav format` | Rewrite safe cards into canonical order and spacing |
| `llmnav generate` | Incrementally compile and transactionally commit generated artifacts |
| `llmnav index` | Alias for `generate` |
| `llmnav query` | Rank cards through the persistent inverted index |
| `llmnav show` | Resolve one active or redirected semantic ID |
| `llmnav context` | Build a bounded context bundle around one ID |
| `llmnav eval` | Run repository-specific search regression queries |
| `llmnav doctor` | Verify installation, cache integrity, transaction recovery, and drift |
| `llmnav spec` | Print source-spec vocabularies and key order |
| `llmnav tools` | Print stable provider-neutral agent tool schemas |
| `llmnav bundle` | Inspect the generated prompt-prefix cache partitions |
| `llmnav editor` | Print a deterministic editor task integration |

See [docs/cli.md](docs/cli.md) for every option and exit code.

## Generated layout

```text
.llmnav/
  AGENT_INSTRUCTIONS.md
  config.json
  ids.jsonl
  lexicon.json
  order.lock
  schema/
    config.schema.json
  eval/
    queries.jsonl
  state/                    # volatile, ignored
    stat-hints.json
  cache/                    # deterministic, commit this
    index.json              # v0.1-compatible schemaVersion 1
    cards.jsonl
    search-index.json       # compact token dictionary, phrases, and postings
    file-state.json         # deterministic parsed-file state
    graph.json              # qualified nodes and provenance-aware edges
    graph-state.json        # disposable content-addressed graph partitions
    prompt-prefix.json      # explicit package, repository, and module cache partitions
    repo-core.txt
    agent-context.md
    manifest.json
    modules/
      auth.session.txt
      billing.credit.txt
```

`.llmnav/.transactions/`, `.llmnav/generation-transaction.json`, and `.llmnav/generation.lock` may exist only while a cache transaction is active or incomplete. They are ignored; abandoned state is recovered automatically after lock ownership is checked. Generated structure is never written back into source comments.

`order.lock` is append-only under normal development. New IDs are appended rather than inserted into a globally re-sorted catalog, preserving larger prompt prefixes as the repository grows.

## Multilingual task language

Keep source cards in one repository language. Map product wording, local language, abbreviations, and retired names in `.llmnav/lexicon.json`.

```json
{
  "version": 1,
  "aliases": {
    "session renewal": "auth.session.rotate",
    "token replay attack": "auth.session.rotate",
    "credit reservation": "billing.credit.reserve"
  }
}
```

## Search regression gates

Add real task descriptions to `.llmnav/eval/queries.jsonl` and run `npx llmnav eval`. The default gates are Recall@1 at 0.75 and Recall@5 at 0.90. Large synthetic accuracy, speed, and memory regression tests are also part of this repository's test suite.

The measured v0.2 benchmark report is in [docs/performance-v0.2.md](docs/performance-v0.2.md). It records the exact fixture, environment, fresh-process query timing, incremental and forced-full regeneration timing, memory, and byte-equivalence checks. The report does not present estimates as measurements.

## Recommended adoption boundary

Annotate architectural modules, public entry points, authentication and payment boundaries, privacy boundaries, migrations, orchestration code with multiple external effects, high fan-in symbols, and code with non-obvious invariants.

Do not annotate trivial getters, generated files, obvious wrappers, every test function, or every private helper. LLMNav becomes worse when keyword-heavy comments cover the whole repository.

## Current implementation boundary

Version 0.5 adds stable provider-neutral agent tools, trusted-root operation dispatch, explicit prompt-prefix cache partitions, deterministic editor diagnostics, a VS Code task integration, and a runnable typed host example to the repository graph and incremental navigation layers.

LLMNav does not discover sibling repositories automatically and does not ship an MCP server, embedding database, hosted service, SCIP generator, or complete language-aware call graph. External tools may export the documented compact graph-input schema. Generated structure never writes derived edges into source cards.

## Documentation

* [Quick start](docs/quickstart.md)
* [Normative `llmnav/1` specification](docs/spec.md)
* [CLI reference](docs/cli.md)
* [Configuration reference](docs/configuration.md)
* [Programmatic API](docs/api.md)
* [Architecture and cache design](docs/architecture.md)
* [Repository graph](docs/graph.md)
* [Agent integration](docs/agent-integration.md)
* [Editor integration](docs/editor-integration.md)
* [Provider-neutral host integration](docs/provider-neutral-integration.md)
* [CI and enforcement](docs/ci.md)
* [Gradual migration](docs/migration.md)
* [Language examples](docs/language-examples.md)
* [Benchmarking methodology](docs/benchmarking.md)
* [Measured v0.2 performance](docs/performance-v0.2.md)
* [Research basis](docs/research.md)
* [Publishing checklist](docs/publishing.md)
* [FAQ](docs/faq.md)

## Development

```sh
npm ci
npm test
npm run test:coverage
npm run lint
npm run check
npm run smoke:pack
npm run benchmark:v0.2
```

The project uses the Node.js standard library and built-in test runner. There is no build step and no production dependency tree to audit.

## Status

LLMNav is an experimental protocol and a usable v0.5 CLI. The source format remains `llmnav/1`; npm package changes and source-grammar changes are versioned independently.

## License

MIT
