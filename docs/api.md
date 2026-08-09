# Programmatic API

The npm package exposes the same deterministic operations used by the CLI. The API is ESM-only and ships TypeScript declarations.

```js
import {
  generateProject,
  parseLlmnavBlocks,
  queryProject,
  validateProject,
  scanProject,
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

Parsing does not perform semantic validation. Read `syntaxErrors` on each block or validate a scanned project.


## Canonicalize one source string safely

```js
import { canonicalizeSource } from "llmnav";

const result = canonicalizeSource(source, "src/session.ts");
if (result.errors.length > 0) {
  throw new Error(result.errors.map((item) => item.message).join("\n"));
}
console.log(result.source);
```

Canonicalization does not erase unknown fields, malformed lines, or duplicate scalar fields. Unsafe blocks remain byte-for-byte unchanged and are returned through `errors`.

## Scan and validate a repository

```js
import { scanProject, validateProject } from "llmnav";

const project = await scanProject(process.cwd());
const diagnostics = validateProject(project);
const errors = diagnostics.filter((item) => item.severity === "error");
```

`scanProject` reads `.llmnav/config.json`, source files, and the semantic ID registry. It does not execute source code.

## Generate catalogs

```js
import { generateProject } from "llmnav";

const result = await generateProject(process.cwd(), { check: false });
if (!result.ok) {
  throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
}
```

Use `{ check: true }` for a read-only drift check.

## Query the current index

```js
import { queryProject } from "llmnav";

const results = await queryProject(
  process.cwd(),
  "replayed refresh token revokes the family",
  { top: 5 },
);

for (const result of results) {
  console.log(result.id, result.score, result.location.path);
}
```

`queryProject` requires an existing `.llmnav/cache/index.json`. Generate first. Result limits are bounded from 1 to 100.

## Query an in-memory index

```js
import { queryIndex } from "llmnav";

const results = queryIndex(index, task, {
  top: 5,
  lexicon: {
    aliases: {
      "토큰 재사용 공격": "auth.session.rotate",
    },
  },
});
```

This form is useful for MCP servers, editor integrations, and test harnesses that already hold the index in memory.

## Public stability

The CLI and exported JavaScript API follow npm semantic versioning. Object properties in the generated index are experimental during 0.x. Consumers should validate `schemaVersion` and avoid depending on undocumented internal modules.
