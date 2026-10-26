# Editor integration

## Deterministic diagnostics

```sh
llmnav check --format editor
```

The schemaVersion 1 report groups diagnostics by repository-relative path. Ranges use zero-based line and character coordinates, while each item retains numeric severity, textual level, stable diagnostic code, source, and message. The output contains no absolute workspace path, timestamp, editor identity, or platform separator.

An editor adapter should bind the repository root itself, map each relative path to its workspace document, and replace the previous LLMNav diagnostics for that document. Do not let model-generated input choose the root.

## Visual Studio Code

```sh
llmnav editor vscode
```

This prints a schemaVersion 1 integration envelope whose `config` value is a VS Code `tasks.json` configuration. The task runs the local package with `npm exec -- llmnav check` and maps LLMNav's standard text output into the Problems panel through a custom problem matcher.

If `.vscode/tasks.json` already exists, merge the generated task into its `tasks` array instead of replacing unrelated tasks. The generated command performs no file mutation.

The matcher follows the current [VS Code task and problem matcher contract](https://code.visualstudio.com/docs/debugtest/tasks): repository-relative file, line, column, severity, code, and message capture groups are declared explicitly.

## Other editors

Editors and language-client wrappers should consume `check --format editor` or call `diagnosticsToEditor(diagnostics)`. This keeps coordinate conversion and severity mapping in LLMNav while leaving document URI construction, lifecycle, debounce, and Problems-panel ownership to the editor integration.

LLMNav does not run a watcher or language server. A host decides when to invoke checks and how to cancel or replace stale results.

## Source freshness for MCP

Start `llmnav mcp --auto-generate` to refresh indexes on demand before tool calls. The first call prepares the index. Later calls compare selected source paths and file metadata (including nanosecond modification/change times and file identity), configured graph inputs, configuration and Go module metadata. Additions, edits, renames, deletions and branch checkouts trigger incremental generation through the normal repository lock and recovery transaction. The default `llmnav mcp` keeps host-managed generation.

Schema 2 graph inputs also contribute every safe path recorded in `sourceHashes`, including compiler configurations and lockfiles outside the selected source roots. Graph files are read with bounded concurrency; dependency changes are detected through file metadata without reading each dependency's contents during stamping. A changed or deleted compiler dependency triggers generation's freshness validation and rejects the stale snapshot. Rerun `llmnav analyze` after compiler-input changes; automatic generation does not rerun compilers. Malformed graph inputs keep the existing blocking `LNV014` validation path.

Concurrent requests share preparation and wait for it before querying. Request cancellation stops only that subscriber's wait; preparation has its own bounded session deadline and server-shutdown signal. Failed generation returns a JSON-RPC error with `LLMNAV_REFRESH_FAILED` and cause details; no previous snapshot is returned. A later request can retry after correction. Embedders can inspect `server.status()` for `idle`, `checking`, `preparing`, `loading`, `ready`, or `error` and error details.

Change detection runs at the request boundary, without a persistent watcher. An edit made during generation is checked again on the next request. Filesystems or tools that preserve all metadata can require explicit `llmnav generate --full`; this is metadata-based freshness rather than a snapshot of a concurrently edited filesystem.
