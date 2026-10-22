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

The type checker resolves aliases, local names, cross-file symbols, class members and static call-site bindings. Instantiated symbols are matched through their compiler declaration identity. Dynamic dispatch and function values still require source review; a call edge identifies the compiler-resolved binding and does not enumerate runtime implementations.

## Go

```sh
llmnav analyze --language go --output .llmnav/imports/go.json
llmnav generate
llmnav discover "Rotate" --precise --json
```

Run at a Go module root and configure `graph.indexFiles` for the output first. The adapter uses the installed Go command, `go list -deps -export`, and standard-library `go/ast`, `go/types`, and `go/importer`. [Go's type information](https://pkg.go.dev/go/types) supplies declaration/use identity; [go list export metadata](https://pkg.go.dev/cmd/go) supplies dependency type data.

The active platform and build constraints select production package files; test variants and cgo are excluded. Dependency exports may be compiled, but application binaries, tests, `go generate`, and module installation are not run. `GOPROXY=off`, `GOTOOLCHAIN=local`, `GOWORK=off`, `CGO_ENABLED=0` and read-only module mode prevent automatic module/toolchain downloads and manifest updates. Missing dependencies fail explicitly. Temporary helper executables are removed after exit.

## Results, freshness and contracts

Results include compiler identity/version, diagnostics, counts, and a graph input. Graph input schema 2 adds required SHA-256 `sourceHashes`; schema 1 remains accepted unchanged. Generation and precise discovery verify source hashes and the selected source set, rejecting edited, added or deleted inputs with `LNV014`. Rerun analysis after source/configuration changes, then generation. Ordinary `show` and `context` read the last generated snapshot; `mcp --auto-generate` reports stale compiler inputs until they are reanalyzed.

`discover --precise` and `llmnav_discover` with `precise: true` return `source: "compiler"`, a qualified structural `id`, and `compiler` provenance. Feed the ID to existing `show` and `context` operations to inspect resolved definitions and edges, including related semantic cards. Tool definition schema is now 4; the operation result envelope, source card protocol and generated repository graph schema stay unchanged.

An exactly attached reviewed card retains its existing ID. Other definitions receive `code.ts.s<hash>` or `code.go.s<hash>` IDs derived from source identity. They are generated navigation identifiers; moving or renaming unannotated code can change them. Business invariants and effects are never inferred or written into source comments.

Errors abort analysis before output replacement by default. `--allow-errors` explicitly permits partial type information, reports diagnostics and lowers reference confidence to 0.8. Syntax, dependency-export or configuration errors can still make analysis impossible. Subprocesses have bounded output and deadlines, and API callers may supply `signal` and `timeoutMs`.

```js
import { analyzeProject, writeAnalysis, discoverProject } from "llmnav";
const analysis = await analyzeProject(root, { language: "typescript", project: "tsconfig.json", signal });
await writeAnalysis(root, ".llmnav/imports/typescript.json", analysis, { signal });
const candidates = await discoverProject(root, "rotateSession", { precise: true, top: 5, signal });
```
