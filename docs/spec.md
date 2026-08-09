# LLMNav/1 specification

Status: experimental normative specification

Package implementation: `llmnav` 0.2.x

## Purpose

LLMNav/1 defines a compact semantic card embedded next to selected code boundaries. A conforming implementation extracts cards, validates stable meaning, generates volatile structure, and exposes the result to coding agents without requiring broad repository reads.

The source card is not a complete documentation record. It contains only information that is expensive to infer from code and expected to remain valid across ordinary implementation changes.

The terms MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative.

## Encoding and line model

A card MUST be UTF-8 text.

Each metadata line MUST contain one `key=value` pair. The first `=` separates the key and value. Multiline values are not supported.

Tabs are not meaningful. A formatter MUST emit spaces and deterministic line endings matching the containing source file.

Unknown keys are errors. Implementations MUST NOT silently index them, and formatters MUST NOT silently delete them.

## Headers and scopes

Every card starts with:

```text
llmnav/1 <scope>
```

The valid scopes are `file`, `module`, and `symbol`.

A `file` card describes the responsibility of one source file. It SHOULD appear before imports after any shebang, license notice, or language-required package declaration.

A `module` card describes a domain, package, namespace, or architectural boundary. It SHOULD be used when one responsibility spans multiple declarations or files.

A `symbol` card attaches to the next declaration after whitespace, ordinary documentation comments, decorators, or attributes. A conforming checker MUST report a card that cannot be attached to a declaration.

## Comment encodings

### Block comments

```text
/* llmnav/1 symbol
id=domain.capability.action
role=Produce one observable result.
stability=contract
*/
```

### HTML comments

```text
<!-- llmnav/1 file
id=ui.checkout.page
role=Render the checkout workflow and submit one payment confirmation.
stability=contract
-->
```

### Line comments

Line-comment cards MUST use one prefix consistently and MUST end with an explicit `/llmnav` line.

```text
# llmnav/1 symbol
# id=domain.capability.action
# role=Produce one observable result.
# stability=contract
# /llmnav
```

The supported prefixes in the reference implementation are `//`, `#`, and `--`.

## Canonical key order

A formatter MUST emit keys in this order:

```text
id
role
owns
excludes
search
invariant
effect
risk
rel
stability
```

Stable key order is part of the format. It makes generated catalogs deterministic and avoids semantically meaningless prompt-prefix changes.

## Field cardinality

| Key | Cardinality | Value form |
| --- | --- | --- |
| `id` | exactly one | scalar |
| `role` | exactly one | scalar sentence |
| `owns` | zero or one line | pipe-separated list |
| `excludes` | zero or one line | pipe-separated list |
| `search` | zero or one line | pipe-separated list |
| `invariant` | repeated, zero to four | one assertion per line |
| `effect` | zero or one line | pipe-separated controlled values |
| `risk` | zero or one line | pipe-separated controlled values |
| `rel` | repeated, zero to six | one relation per line |
| `stability` | exactly one | controlled scalar |

Empty values are invalid in every field. Empty items inside a pipe-separated list are invalid. Optional fields MUST be omitted when they have no value. Duplicate values in list or repeatable fields are invalid after Unicode normalization and case folding.

## `id`

`id` is a durable semantic identity. It MUST describe a capability, contract, policy, or workflow rather than a current file or symbol name.

The grammar is:

```text
id = segment "." segment *("." segment)
segment = lowercase-letter *(lowercase-letter / digit / "-")
```

The reference validation expression is:

```regex
^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){1,5}$
```

Examples:

```text
auth.session.rotate
billing.credit.reserve
privacy.export.prepare
game.arena.collapse-sequence
```

An ID MUST remain unchanged when a file moves, a declaration is renamed, or an implementation is replaced without changing the semantic capability.

Deleted IDs MUST NOT be reused. `.llmnav/ids.jsonl` records active, redirected, replaced, or retired identities.

```jsonl
{"id":"auth.session.rotate","state":"active"}
{"id":"auth.session.renew","state":"redirect","to":"auth.session.rotate"}
{"id":"billing.credit.charge","state":"replaced","by":["billing.credit.reserve","billing.credit.capture"]}
```

## `role`

`role` states the observable result produced by the file, module, or symbol.

It MUST NOT merely restate a name or use an empty abstraction such as “handle data”, “manage sessions”, “service utility”, or “process logic”.

It MUST be no longer than 180 characters in the reference profile.

Good:

```text
role=Reserve user credits before an external generation job starts.
```

Bad:

```text
role=Handle billing data.
```

## `owns` and `excludes`

`owns` lists responsibilities for which the card is authoritative.

`excludes` names adjacent responsibilities that appear related but belong elsewhere. It reduces false-positive routing in repositories with dense domain vocabulary.

```text
owns=refresh-token family|session revocation
excludes=access-token signing|user profile storage
```

These fields SHOULD appear primarily on `file` and `module` cards.

## `search`

`search` bridges task language and code language. It contains phrases that a developer or product owner is likely to use but that may not appear in current identifiers.

When present, the reference profile requires two to six phrases.

```text
search=refresh token|token rotation|token family|replay detection
```

Generic phrases such as `service`, `manager`, `handler`, `helper`, `utility`, `data`, `process`, and `logic` are forbidden by default.

A repository SHOULD use one source-card language. Translations, abbreviations, product terminology, and historical names SHOULD be stored in `.llmnav/lexicon.json` rather than duplicated across source comments.

## `invariant`

Each `invariant` is a condition whose violation represents a bug, security failure, accounting failure, or broken contract.

```text
invariant=At most one live refresh token exists per family.
invariant=Replay revokes the entire token family.
```

Descriptions, goals, implementation notes, and temporary assumptions MUST NOT be presented as invariants.

The reference profile permits at most four invariants per card. More usually indicates that the annotated boundary is too broad or that policy belongs in a separate card.

## `effect`

`effect` uses a controlled vocabulary for externally observable or nondeterministic behavior.

The base vocabulary is:

```text
db.read(name)
db.write(name)
cache.read(name)
cache.write(name)
event.emit(name)
event.consume(name)
net.call(name)
fs.read
fs.write
process.spawn
clock.read
random.read
lock.acquire(name)
cookie.write(name)
auth.check(name)
```

The base vocabulary has fixed argument arity. `db.*`, `cache.*`, `event.*`, `net.call`, `lock.acquire`, `cookie.write`, and `auth.check` require one stable target argument. `fs.read`, `fs.write`, `process.spawn`, `clock.read`, and `random.read` accept no argument. Resource arguments identify a semantic resource rather than a path, host, timestamp, or current implementation detail.

A repository MAY extend the vocabulary in `.llmnav/config.json`. An extension declares only a lower-case effect kind such as `queue.publish`; the reference implementation accepts that custom kind with or without one target argument. Extensions MUST remain machine-parseable and SHOULD use a stable namespace.

Effects do not replace static analysis. They express semantic importance and provide retrieval signals while future enrichers compare declarations against actual sinks.

## `risk`

The base risk vocabulary is:

```text
auth
money
privacy
concurrency
migration
availability
performance
```

Cards containing `auth`, `money`, or `privacy` MUST contain at least one invariant and at least one `test>` relation under the reference profile.

A repository MAY add controlled risk values in configuration.

## `rel`

`rel` records a semantic relation that cannot be reliably derived from imports or call syntax.

The grammar is:

```text
rel=<type>><target-id>
```

The base relation types are:

```text
policy
workflow
fallback
mirror
migration
test
replaces
deprecated-by
cross-repo
```

Examples:

```text
rel=policy>auth.session.lifecycle
rel=workflow>auth.session.revoke-family
rel=fallback>auth.session.reauthenticate
rel=test>auth.session.rotate.contract
rel=cross-repo>zdp-core-auth/auth.session.rotate
```

The following structural relations MUST NOT be maintained by hand:

```text
calls
imports
references
implements
exports
overrides
```

They belong in generated structure indexes because source changes can invalidate them immediately.

A non-cross-repository target MUST resolve to a source card or an ID registry record.

## `stability`

`stability` controls catalog placement and cache strategy.

`architecture` describes ownership, boundaries, and responsibilities that normally survive file moves and implementation changes. Architecture cards enter the repository core catalog by default.

`contract` describes externally relevant behavior, invariants, effects, and semantic workflow links. Contract cards enter module catalogs by default.

`implementation` describes a current algorithm or optimization that may change frequently. Implementation cards remain searchable but are excluded from shared stable catalogs by default.

## Forbidden volatile data

Source cards MUST NOT contain fields for:

```text
path
line
span
commit
updated_at
owner
callers
callees
imports
references
implementation_count
test_status
current_signature
```

Equivalent path, line, commit, and timestamp data hidden inside `role`, `search`, or `invariant` values is also invalid.

Current locations, signatures, imports, hashes, and future call-graph edges belong in generated files.

## Size profile

The reference implementation applies these default byte limits:

| Scope | Maximum bytes |
| --- | ---: |
| `file` | 400 |
| `module` | 1,200 |
| `symbol` | 900 |

For repositories with at least 50,000 scanned source bytes, LLMNav comments SHOULD remain below 1.5% of source bytes. The checker reports a warning when the configured ratio is exceeded.

These are anti-bloat limits, not targets.

## Canonicalization

A canonical formatter MUST refuse to erase malformed lines, unknown fields, overlapping blocks, or duplicate scalar values. Unsafe cards remain unchanged until the checker-reported issue is fixed.

For valid cards, a canonical formatter MUST:

* emit the standard header and terminator for the original comment style
* emit keys in canonical order
* emit list fields once with `|` separators
* emit one line per `invariant` and `rel`
* remove empty optional fields
* preserve the containing file's newline convention
* preserve source indentation

A checker MAY reject non-canonical formatting. The reference implementation does so by default.

## Generated index

The reference implementation emits `.llmnav/cache/index.json` with:

* stable card fields
* generated path and source line
* attached declaration name, kind, line, and signature when recognized
* generated import strings
* separate semantic, structure, and body SHA-256 hashes

`semantic` hashes change only when card meaning changes.

`structure` hashes change when path, declaration, signature, or import structure changes.

`body` hashes change when the containing source file changes.

Generated files MUST be deterministic. Wall-clock timestamps, absolute paths, platform-specific separators, random transaction IDs, and filesystem stat values MUST NOT be embedded in deterministic catalogs.

The reference implementation preserves `index.json` schemaVersion 1 for v0.1 consumers and emits additive generated accelerators:

* `search-index.json` contains a versioned deterministic token dictionary, normalized phrase documents, and compact posting lists
* `file-state.json` contains versioned deterministic parsed-file state
* `manifest.json` hashes every deterministic cache artifact except itself

An implementation MAY use volatile filesystem stat hints to avoid reading unchanged files, but those hints MUST remain outside deterministic cache output and MUST NOT affect generated bytes.

Incremental generation MUST produce the same deterministic artifacts as a full generation for identical source, configuration, registry, aliases, and stable order.

A generated search index MUST be treated as an accelerator rather than source truth. Implementations MUST be able to reject an incompatible accelerator and rebuild it from the primary card index.

Transactional work directories and recovery journals are not deterministic artifacts. They MUST NOT be copied into source comments or committed as semantic metadata.

## Stable order

`.llmnav/order.lock` records semantic IDs in append-only catalog order. Implementations SHOULD preserve existing lines and append new active IDs.

A deleted ID MAY remain in the lock. Removing or globally reordering entries is an explicit cache-epoch operation, not routine formatting.

## Conformance

A source parser conforms to LLMNav/1 when it recognizes all required comment encodings, field syntax, and canonical keys.

A checker conforms when it enforces required fields, controlled values, ID syntax, forbidden volatile data, relation resolution, registry state validity, and declaration attachment.

An indexer conforms when it keeps source semantics separate from generated location and emits deterministic output for identical input.

A coding-agent integration conforms when it directs the agent to query compact cards before broad repository exploration and does not treat generated paths as stable source metadata.

## Versioning

The npm package version and source specification version are independent.

Backward-compatible parser, CLI, ranking, or diagnostic improvements use normal semantic package versioning.

A breaking source grammar change requires a new header such as `llmnav/2`. Implementations MUST NOT reinterpret a `llmnav/1` card under incompatible rules.
