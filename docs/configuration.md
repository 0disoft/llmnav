# Configuration reference

Source collection always excludes `.llmnav/tmp`, `.llmnav/state`, `.llmnav/.transactions` and the configured generation cache directory. This also applies to explicit source paths; runtime scratch files must not affect a repository's generated snapshot.

`llmnav init` creates `.llmnav/config.json` and a local JSON schema at `.llmnav/schema/config.schema.json`.

## Complete shape

```json
{
  "$schema": "./schema/config.schema.json",
  "version": 1,
  "repositoryId": "example-service",
  "sourceRoots": ["src", "packages"],
  "includeExtensions": [".ts", ".tsx", ".go", ".rs", ".py"],
  "excludeDirectories": ["node_modules", "dist", "target"],
  "excludeFiles": ["*.generated.*", "*.gen.*"],
  "coverageRules": [],
  "audit": {
    "dispositions": []
  },
  "graph": {
    "indexFiles": []
  },
  "lint": {
    "maxRoleLength": 180,
    "maxSearchTerms": 6,
    "minSearchTerms": 2,
    "maxInvariants": 4,
    "maxEffects": 6,
    "maxRelations": 6,
    "maxBlockBytes": {
      "file": 400,
      "module": 1200,
      "symbol": 900
    },
    "maxSemanticRatio": 0.015,
    "minimumSourceBytesForRatio": 50000,
    "searchTermSaturation": 0.05,
    "minimumCardsForSaturation": 20,
    "genericSearchTerms": ["service", "manager", "handler"],
    "vagueRoleWords": ["handle", "manage", "process"],
    "strictRisks": ["auth", "money", "privacy"],
    "additionalEffects": [],
    "additionalRisks": [],
    "additionalRelations": [],
    "requireCanonicalOrder": true,
    "requireCanonicalFormatting": true
  },
  "generation": {
    "cacheDirectory": ".llmnav/cache",
    "moduleDepth": 2,
    "searchShardSize": 0,
    "repositoryCatalogStabilities": ["architecture"],
    "moduleCatalogStabilities": ["architecture", "contract"]
  },
  "evaluation": {
    "queryFile": ".llmnav/eval/queries.jsonl",
    "minimumRecallAt1": 0.75,
    "minimumRecallAt5": 0.9
  }
}
```

Initialization writes the full default object. Later releases may add defaults without requiring every repository to rewrite its file because configuration is merged with the active profile. Unknown properties are rejected at every supported level, preventing misspelled enforcement settings from being silently ignored.

## Repository identity

`repositoryId` distinguishes generated catalogs and future cross-repository relations. Use a stable lowercase repository name. Renaming an npm package does not require changing it when existing cross-repository IDs depend on the old value.

## Source selection

`sourceRoots` defines the only directory trees scanned during a normal command. CLI path arguments narrow that set for formatting or diagnostics.

Every source root must remain inside the repository and cannot be a symbolic link. Nested symbolic-link entries are not traversed.

`includeExtensions` is an allowlist. LLMNav does not scan Markdown or YAML by default because documentation examples routinely contain card syntax.

`excludeDirectories` matches directory names at any depth. Defaults exclude dependency and tool output including `node_modules`, `.bun-cache`, `.pnpm-store`, `.cache`, build directories, and language targets.

`excludeFiles` supports `*`, `?`, and `**`. A pattern without `/` matches a file name at any depth, so the default `*.min.js` also excludes `src/vendor/app.min.js`. A pattern with `/` is anchored at the repository root, so `src/generated/*.js` does not match `tools/src/generated/api.js`. `**` spans directories only when it occupies a whole path segment: `src/**` matches every file below `src`, and `a/**/c.ts` matches both `a/c.ts` and `a/b/c.ts`. Anywhere else, `**` behaves like `*` and never crosses `/`. Character classes and negation are not supported.

## Coverage rules

Coverage is opt-in and path-specific.

```json
{
  "name": "payment webhooks",
  "match": ["src/webhooks/payment/**/*.ts"],
  "scope": "file",
  "requiredFields": ["effect", "risk", "invariant"]
}
```

A coverage rule checks files already selected by `sourceRoots` and extension filters. Its fields are closed and `requiredFields` must name valid LLMNav keys. It should target a real architectural boundary, never an entire source tree.

Run `llmnav audit` to obtain path-specific candidate rules. A suggestion is not applied automatically and should be accepted only after the file's durable responsibility is confirmed. This separation prevents structural heuristics from creating vague or stale semantic cards.

## Audit dispositions

When a candidate has been reviewed and intentionally does not need a semantic card, record that decision instead of repeatedly ignoring it:

```json
{
  "audit": {
    "dispositions": [
      {
        "path": "src/adapters/local-cache.ts",
        "reason": "This private adapter mirrors its carded module contract and owns no durable policy."
      }
    ]
  }
}
```

Each disposition targets one exact normalized repository-relative path. Globs, trailing slashes, backslashes, duplicate paths, and reasons shorter than 12 characters are rejected. A matching candidate is omitted from the active queue and reported as `suppressed`. If the file disappears, gains card coverage, or stops qualifying as a candidate, the disposition is reported as `stale` with a machine-readable reason so obsolete decisions remain visible.

## Lint profile

Byte and field-count limits prevent semantic cards from becoming mini-documents. `maxSemanticRatio` produces a warning after the scanned source exceeds `minimumSourceBytesForRatio`.

Search saturation warns when one exact search phrase appears in too many cards. Repository-wide vocabulary such as a product name usually belongs in module IDs or aliases rather than every card.

`additionalEffects`, `additionalRisks`, and `additionalRelations` extend controlled vocabularies. Add namespaced values rather than weakening validation globally. Each entry is a lower-case controlled identifier, not a complete source expression. Configure `queue.publish`, then write `effect=queue.publish(job_ready)` in a card. Configuration values such as `queue.publish(name)`, `Data Loss`, and `calls>` are rejected.

## Generation

`generation.cacheDirectory` must be a relative path below `.llmnav/`. Generation removes and rebuilds that directory, so it cannot be pointed at ordinary source or arbitrary repository paths.

`moduleDepth` groups IDs by their first segments. With a depth of two, `auth.session.rotate` belongs to the `auth.session` catalog.

`searchShardSize` is `0` by default. Set a positive card limit in very large repositories to emit deterministic `search-shards.json` and `search-shards/NNNN.json` artifacts. Shards are sliced from the compact index without retokenizing cards. The compatible `search-index.json` remains available for existing consumers and preserves ranking behavior.

Stability filters decide which cards enter long-lived repository and module prompt material. Every card remains in `index.json` regardless of catalog filters.

## Graph inputs

`graph.indexFiles` lists optional generated definition and reference indexes. Paths must remain inside the repository and are loaded as data only. See [Repository graph](graph.md) for the schema and validation contract.

## Evaluation

`queryFile` must remain inside the repository. Each JSONL record contains task text and one or more accepted IDs.

The thresholds gate `llmnav eval`. Keep the default until the query set represents real work, then raise the values based on measured retrieval quality.
