# Repository graph

## Optional generated inputs

LLMNav never executes repository code to discover definitions or references. Configure explicit generated JSON inputs instead:

```json
{
  "graph": {
    "indexFiles": [".llmnav/imports/payments.json"]
  }
}
```

Every path must stay inside the repository, use forward slashes, avoid parent traversal, and pass symlink traversal checks. Missing, malformed, or unsafe inputs produce blocking diagnostic `LNV014` during `check` and `generate`.

## Input schema

```json
{
  "schemaVersion": 1,
  "repositoryId": "payments",
  "generator": "scip-adapter@1",
  "definitions": [
    {
      "id": "billing.capture.run",
      "symbol": "runCapture",
      "path": "src/capture.ts",
      "line": 8,
      "kind": "function"
    }
  ],
  "references": [
    {
      "from": "billing.capture.run",
      "to": "accounts/auth.session.rotate",
      "kind": "calls",
      "path": "src/capture.ts",
      "line": 19,
      "confidence": 0.9
    }
  ]
}
```

Local IDs are qualified with the input `repositoryId`. A repository-qualified ID uses `repository-id/semantic.id`. Definitions are sorted by qualified ID and references by source, target, kind, path, and line.

`confidence` is a number from 0 to 1 and defaults to `0.8`. It records the generator's evidence strength; it does not grant authority to modify source or override semantic cards. Unknown fields, duplicate definitions, unsafe paths, invalid IDs, and out-of-range confidence values are rejected.

This normalized input is deliberately smaller than SCIP, LSIF, or a language-server database. External adapters own format conversion. LLMNav owns validation, qualification, graph generation, ranking, and bounded context consumption.

## Generated graph

Generation writes `.llmnav/cache/graph.json` schemaVersion 1. Nodes use `repository-id/semantic.id` keys and retain local card roles, generated locations, imported definitions, external status, and unresolved status.

Edges contain a stable SHA-256 ID, qualified `from` and `to` keys, kind, confidence, and provenance:

| Provenance | Default confidence | Evidence |
| --- | --- | --- |
| `source-card` | `1.0` | explicit semantic `rel` field |
| `local-import` | `0.85` | deterministically resolved relative source import |
| `generated-index` | supplied value, default `0.8` | configured definition/reference index |

Provenance records the owning input or source file, optional referenced path and line, and generator identity. Missing targets remain unresolved placeholder nodes rather than disappearing. The graph is part of the transactional cache and its bytes are covered by `manifest.json`.
