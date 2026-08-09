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
