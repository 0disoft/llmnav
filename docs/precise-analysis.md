# Compiler-resolved navigation

LLMNav can produce definition/reference graph inputs with installed compiler tooling. Analysis is explicit and runs outside the normal query process. The npm package keeps zero runtime dependencies. Its development dependencies include TypeScript 6 for adapter tests.

## TypeScript

Use TypeScript Compiler API 5 or 6. TypeScript 7.0 moved to a native implementation without that JavaScript API; the adapter rejects unsupported versions and missing APIs rather than silently falling back. See the [official Compiler API compatibility note](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) and [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).

Configure `.llmnav/config.json` first:

```json
{ "graph": { "indexFiles": [".llmnav/imports/typescript.json"] } }
```

Then run:

```sh
llmnav analyze --language typescript --project tsconfig.json --output .llmnav/imports/typescript.json
llmnav generate
llmnav discover "rotateSession" --precise --json
```

Without `--output`, analysis prints its result and writes nothing. `--project` is optional; without it the adapter uses selected TypeScript sources with NodeNext resolution. A project config selects compiler options and entry files, but emission and incremental compiler writes stay disabled. TypeScript is resolved from the target repository first, then the adapter installation. `--typescript /absolute/path/to/typescript.js` explicitly selects a compatible installed API. No compiler or target dependencies are downloaded by analysis.

The project config, every configuration read through `extends`, and repository-contained package manifests read for configuration or module resolution are included in `sourceHashes`. This covers package `imports`, `exports` and `type` changes even when TypeScript source files stay unchanged. Editing or deleting any tracked file invalidates the analysis, including changes made while analysis is running. Configuration files must stay inside the repository, including their resolved symlink targets; choose a repository root containing shared monorepo configurations. UTF-8 and UTF-16 BOMs remain supported. Re-run TypeScript analysis once after upgrading to add package metadata hashes to existing graph inputs.

Configuration hashes cover the exact bytes consumed by the compiler. Selected TypeScript sources also use this read-and-hash path: the worker hashes the same bytes it decodes for compilation, and the parent compares them with the initial source scan before accepting declarations. A transient edit followed by undo (A → B → A) is rejected even when the file is restored before the final filesystem check. Selected source hash paths retain scanner-owned spelling under the compiler's case rules. This adds SHA-256 work over consumed source bytes without another source-content read. Rerun TypeScript analysis after upgrading to capture these consumption hashes. Injected I/O can supply optional `io.readBytes(path, { signal })` for byte-preserving validation; existing `io.readFile` remains supported for UTF-8 content. Existing graph inputs with decoded-text hashes remain accepted.

The type checker resolves aliases, local names, cross-file symbols, class members and static call-site bindings. Instantiated symbols are matched through their compiler declaration identity. Dynamic dispatch and function values still require source review; a call edge identifies the compiler-resolved binding and does not enumerate runtime implementations.

## Go

```sh
llmnav analyze --language go --output .llmnav/imports/go.json
llmnav generate
llmnav discover "Rotate" --precise --json
```

Run at a Go module root and configure `graph.indexFiles` for the output first. The adapter uses the installed Go command, `go list -deps -export`, and standard-library `go/ast`, `go/types`, and `go/importer`. [Go's type information](https://pkg.go.dev/go/types) supplies declaration/use identity; [go list export metadata](https://pkg.go.dev/cmd/go) supplies dependency type data.

The active platform and build constraints select production package files; test variants and cgo are excluded. Dependency exports may be compiled, but application binaries, tests, `go generate`, and module installation are not run. `GOPROXY=off`, `GOTOOLCHAIN=local`, `GOWORK=off`, `CGO_ENABLED=0` and read-only module mode prevent automatic module/toolchain downloads and manifest updates. Missing dependencies fail explicitly. Temporary helper executables are removed after exit.

## Opt-in declaration metadata

Add `--metadata` to either analysis command (API: `metadata: true`) to produce graph input schema 3. Schema 1 and 2 inputs remain accepted; analysis without the flag continues to emit schema 2 with identical definition IDs and reference edges. Schema 3 adds generated declaration metadata: language, category, owner ID, compiler type, callable signatures, parameters and explicit `declared`, `inferred`, or `unknown` type origins. Unknown types are null, not guesses. Error-tolerant analysis marks metadata `partial`.

TypeScript includes named declarations, class/interface members, overload signatures and named parameters. Go includes types, struct fields, methods with receiver ownership, parameters, generics and variadic parameters. The selected compiler's source set and existing freshness checks still apply. Constructors, computed TypeScript names and destructured bindings are not separate definitions; unnamed Go parameters appear in callable metadata only. Metadata never becomes a semantic source card. [File history and verification receipts](local-evidence.md) are separate on-demand operations.

## Additional languages

```sh
llmnav analyze --language javascript --metadata --output .llmnav/imports/javascript.json
llmnav analyze --language python --python python --metadata --output .llmnav/imports/python.json
llmnav analyze --language rust --metadata --output .llmnav/imports/rust.json
```

Configure each output in `graph.indexFiles`, then generate. JavaScript reuses the installed TypeScript 5/6 API with `allowJs` and `checkJs`; `.js`, `.mjs`, `.cjs` and `.jsx` are selected. JSDoc annotations count as declared types; unannotated implicit `any` parameters remain unknown with null metadata types. Without `--project`, implicit-any diagnostics are disabled for JavaScript; explicit project strictness is preserved. `--allow-errors` retains partial metadata when other compiler diagnostics exist. Constructors and computed/destructured bindings have the same limitations as TypeScript.

Python uses the installed Python 3.9+ AST through an isolated `-I -B` subprocess (API: `pythonCommand`). It parses UTF-8 source without importing target modules, and extracts classes, functions, async methods, named parameters and module/class variable annotations. Parameter defaults and variadic arguments are retained; decorators, instance assignments, type comments, destructuring and generic type parameters are not separate definitions. Only explicit annotations provide types. An annotation's presence does not prove its correctness. The tested interpreter is Python 3.14; accepted syntax depends on the installed interpreter. AST byte columns are converted to JavaScript UTF-16 offsets for card attachment, with one-based physical lines. Physical lines use CR, LF or CRLF; Unicode separators inside strings remain content. A UTF-8 BOM occupies one UTF-16 source unit even though decoding removes it. ASCII columns use direct arithmetic; non-ASCII lines lazily build a byte-to-UTF-16 correction index once, then use binary search for each declaration instead of re-encoding line prefixes.

Rust uses a built-in conservative lexical extractor with no dependency or toolchain installation. One owned Node subprocess per analysis keeps tokenization and declaration walking off the calling event loop. The shared compiler runner applies cancellation, a default 120-second deadline and a 32 MiB output cap, and waits for process exit before resolving cancellation/failure. Worker V8 old-space is limited to 256 MiB; this is not a total-RSS limit. Process startup and exit add latency, and deadline completion also includes exit/cleanup time. See [the isolation reproduction](rust-analysis-isolation.md).

The extractor returns named structs/enums/traits, inline modules, named struct fields, functions, trait methods and function parameters. Simple impl receivers bind only to a unique same-scope local type. Generic/qualified receivers remain unresolved. Nested comments, strings, character literals, raw strings and macro token trees are skipped. This is not a complete Rust parser: it rejects unterminated literals/comments and unbalanced delimiters, but does not validate other syntax. Macro expansion, cfg evaluation, crate/import resolution, aliases, enum payloads, tuple fields, nested local items and destructuring remain unsupported.

Python and Rust return `precision: "syntax"`, explicit `limitations`, and metadata marked `partial`. They generate lexical `declares` edges, without inferred call/reference edges. Their generators are `llmnav-python-syntax@1;python-ast@<version>` and `llmnav-rust-syntax@1;rust-lexical@1`. `discover --precise` searches these saved definitions too, returning `source: "declaration"`, `precision: "syntax"` and `analyzer` instead of compiler provenance. The flag selects fresh saved analysis; it does not upgrade syntax precision.

All five languages reuse graph schemas, ID binding, bounded metadata/member pages and source-set/hash invalidation. `code.js`, `code.py` and `code.rs` prefix generated IDs. Python/Rust do not interpret build configurations or monitor installed toolchain changes; rerun analysis after interpreter/extractor upgrades. Reanalysis currently processes the entire selected language; downstream generation can reuse unchanged files. [Reproducible measurements](local-analysis-evaluation.md) distinguish costs and support limits.

After saving a metadata analysis and regenerating, use existing discovery IDs:

```sh
llmnav analyze --language typescript --metadata --output .llmnav/imports/typescript.json
llmnav generate
llmnav discover "Store" --precise --top 1 --json
llmnav show <id> --metadata --json
llmnav show <id> --metadata --members --top 5 --offset 0 --metadata-budget 4000 --json
```

`show --metadata` adds one `metadata` page. `--members` selects direct children, including Go receiver methods and callable parameters; show a file's generated module ID to list its top-level declarations. Member pages use deterministic ID/path/line ordering. Follow `nextOffset` using the same generated snapshot; regeneration can change page membership. `total` counts matching definition records, and an empty type has zero members. Older analyses return `status: "unavailable"`.

The budget covers UTF-8 bytes of compact `JSON.stringify(result.metadata)`, excluding the existing show result and pretty-print whitespace. It defaults to 4,000 bytes (256–64,000); page size defaults to 10 (1–100). An oversized record returns `{ id, detailOmitted: true }`; increase the budget or inspect its direct members. If even that ID cannot fit, the page is empty, `nextOffset` stays unchanged, and `requiredBytes` states the minimum budget for the omission record. Types and signatures are never silently cut into misleading fragments.

API: `showProjectCard(root, id, { metadata: true, members: true, top: 5, offset: 0, metadataBudget: 4000, signal })`. Session `show` and MCP `llmnav_show` accept the same metadata options. Paging options require `metadata: true`; default `show`, `query`, `discover` and `context` responses exclude the new metadata. Graph metadata remains generated, optional data; it increases stored graph size and loading work when enabled. Session member indexes are built lazily once per graph snapshot and replaced on refresh. Optional details describe that generated snapshot, not live source freshness; use precise discovery or regenerate after analysis to reject stale inputs.

## Results, freshness and contracts

Results include compiler identity/version, diagnostics, counts, and a graph input. Graph input schema 2 adds required SHA-256 `sourceHashes`; schema 1 remains accepted unchanged. Generation and precise discovery verify source hashes and the selected source set, rejecting edited, added or deleted inputs with `LNV014`. Rerun analysis after source/configuration changes, then generation. Ordinary `show` and `context` read the last generated snapshot; `mcp --auto-generate` reports stale compiler inputs until they are reanalyzed.

For compiler analyses, `discover --precise` and `llmnav_discover` with `precise: true` return `source: "compiler"`, a qualified structural `id`, and `compiler` provenance. Syntax analyses use the provenance described above. Feed the ID to existing `show` and `context` operations. Tool definition schema is 7; the operation result envelope, source card protocol and generated repository graph schema stay unchanged. Repository graph definitions may additionally carry schema 3 declaration metadata.

An exactly attached reviewed card retains its existing ID. Other definitions receive `code.ts.s<hash>` or `code.go.s<hash>` IDs derived from source identity. They are generated navigation identifiers; moving or renaming unannotated code can change them. Business invariants and effects are never inferred or written into source comments.

TypeScript overloads share one definition per compiler symbol. Functions and methods with an implementation use its source location. An implementation-attached card takes precedence; a card on the first signature remains supported when the implementation has no card. Declaration-only overload groups retain their first signature location.

Errors abort analysis before output replacement by default. `--allow-errors` explicitly permits partial type information, reports diagnostics and lowers reference confidence to 0.8. Syntax, dependency-export or configuration errors can still make analysis impossible. Subprocesses have bounded output and deadlines, and API callers may supply `signal` and `timeoutMs`.

```js
import { analyzeProject, writeAnalysis, discoverProject } from "llmnav";
const analysis = await analyzeProject(root, { language: "typescript", project: "tsconfig.json", signal });
await writeAnalysis(root, ".llmnav/imports/typescript.json", analysis, { signal });
const candidates = await discoverProject(root, "rotateSession", { precise: true, top: 5, signal });
```
