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

## 0.2 — stronger generated structure

Planned:

* incremental file and card indexing
* TypeScript compiler and Go parser enrichers
* exported contract fingerprints
* changed-card and affected-catalog reporting
* richer route, event, schema, and configuration boundary detection
* machine-readable SARIF output

## 0.3 — repository graphs

Planned:

* SCIP import
* definitions, references, implementations, and call edges
* edge provenance and confidence
* graph-aware ranking and context packing
* workspace and cross-repository index

## 0.4 — agent protocol integrations

Planned:

* MCP server over the existing query/show/context operations
* stable tool-schema adapters for coding agents
* prompt-prefix bundle generation with explicit cache partitions
* editor integrations and diagnostics

## 1.0 criteria

The source grammar and generated schema will be declared stable only after use across multiple TypeScript, Go, Rust, Python, and mixed-language repositories. A 1.0 release requires migration tooling, documented compatibility guarantees, benchmark fixtures, and no unresolved high-severity parser ambiguities.

## Non-goals

LLMNav will not become a general documentation generator, source-of-truth call graph maintained by comments, autonomous code modification service, hosted source ingestion platform, or mandatory embedding database.
