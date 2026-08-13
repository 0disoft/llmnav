# Compatibility and deprecation policy

This policy applies to LLMNav releases before 1.0 and defines which surfaces are durable enough for repositories and integrations to depend on.

## Stability classes

| Surface | Stability before 1.0 | Compatibility rule |
| --- | --- | --- |
| `llmnav/1` source cards | Stable protocol | Existing valid cards keep their meaning. A breaking grammar or semantic change requires a new protocol header such as `llmnav/2`; LLMNav will not reinterpret `llmnav/1` incompatibly. |
| `.llmnav/cache/index.json` schemaVersion 1 | Stable primary generated contract | Additive optional fields are allowed. Removing or changing an existing field requires a new schema version and a migration path. |
| CLI commands, flags, exit codes, JSON fields, ESM exports, and TypeScript declarations documented in this repository | SemVer public API | Compatible additions may ship in a minor release. Removal or incompatible behavior requires a minor release before 1.0, a documented replacement, and the deprecation window below. |
| Diagnostic codes | Stable identifiers | A code may gain clearer wording, but its documented category and remediation meaning remain compatible. Retiring a code follows the deprecation window. |
| Search ranking and performance | Behavioral contract | Determinism and published regression thresholds are protected. Exact scores or ordering may change in a minor release when benchmarks justify the change and the changelog explains it. |
| `search-index.json`, `file-state.json`, `graph-state.json`, prompt bundles, shards, transaction journals, locks, and other generated accelerators | Disposable versioned formats | Consumers must not treat these as source truth. LLMNav may replace an incompatible format after `migrate --check`; it must rebuild or fail closed rather than silently misread it. |
| Undocumented internals and test helpers | Unstable | They may change in any release. Importing source files outside the documented package exports is unsupported. |

Package versions follow Semantic Versioning. Before 1.0, an incompatible change to a documented package API may use a minor version, while patches remain backward compatible. Protocol and generated-schema versions are independent from the npm package version.

## Deprecation window

For a documented CLI, JSON, ESM, or TypeScript surface:

1. The introducing release documents the deprecated surface, its replacement, and any automated migration.
2. The old surface remains functional for at least one subsequent minor release and for at least 90 days. Removal waits until both conditions are satisfied.
3. `llmnav doctor`, `check`, or `migrate --check` reports a stable diagnostic when repository action is required. A warning must not silently become destructive behavior.
4. The removal release records the change in `CHANGELOG.md` and `docs/migration.md`.

Immediate removal is reserved for an actively exploitable security issue or behavior that can corrupt source or repository state. The security release must explain the exception and provide the safest available migration.

## Upgrade guarantees

* Canonical source cards and `.llmnav/ids.jsonl` remain the recovery authority; disposable caches do not.
* `migrate --check` is read-only. `migrate --write` validates canonical source before mutation and publishes a complete recoverable cache transaction.
* A supported upgrade path covers the latest release of the previous minor line to the current release. Skipping several minor lines may require running the newest migration tool directly, but must not require installing every intermediate package version.
* Downgrade compatibility is not guaranteed for generated caches. Restore caches by regenerating them with the target version; never hand-edit generated schema versions.
* Node.js runtime support follows the declared `engines` range. Dropping a supported Node.js major is an incompatible documented API change and follows the deprecation window unless that runtime is no longer receiving security updates.

## 1.0 commitment

At 1.0, incompatible changes to documented package APIs require a new major package version. The `llmnav/1` and primary-index rules above already apply and do not wait for 1.0. The remaining 1.0 gates are sustained cross-platform evidence, published benchmark methodology, and closure of high-severity parser or transaction ambiguity.
