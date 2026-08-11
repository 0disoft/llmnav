# Quick start

## Install and initialize

```sh
npm install --save-dev llmnav
npx llmnav init --agents all --package-scripts
```

This creates the `.llmnav` control directory, a JSON schema, the semantic ID registry, the stable order lock, deterministic generated indexes and catalogs, volatile state ignore rules, and managed instruction files for coding agents.

Review `.llmnav/config.json` before annotating code. The default scans the repository root while excluding build outputs, dependency directories, generated bundles, and common caches.

Source roots and evaluation files must remain inside the repository. The generated cache directory must remain below `.llmnav/`; parent traversal and symbolic-link control directories are rejected.

## Audit before annotating

```sh
npx llmnav audit
```

Start with high and medium candidates. The audit explains whether a file is a package entrypoint, public API, generated structural boundary, or high fan-in module. Narrow source signals also identify versioned schema literals, persistent dotted JSON filename protocols, and Tauri invoke adapters. It does not write source or invent card contents. Declaration files and common non-production or low-fan-in utility shapes are suppressed so the result is a review queue, not a demand to annotate every file.

After accepting a candidate, write its durable meaning by inspecting the source, add a narrow `coverageRules` entry for that exact boundary, and add a real task-language query to `.llmnav/eval/queries.jsonl`. Use `npx llmnav audit --fail-on high` in CI only after the initial review.

## Annotate a module boundary

Choose a boundary that an agent is likely to search for by behavior rather than by current symbol name.

```ts
/* llmnav/1 module
id=auth.session
role=Own refresh-token issuance, rotation, replay detection, and revocation.
owns=refresh-token family|session revocation
excludes=access-token signing|user profile storage
search=session lifecycle|token family|session revocation
invariant=One token family has at most one live refresh token.
stability=architecture
*/
```

Do not begin by annotating every function. One clear module card is more valuable than dozens of generic helper cards.

## Annotate a behavioral boundary

```ts
/* llmnav/1 symbol
id=auth.session.rotate
role=Rotate one refresh-token family atomically and reject replayed tokens.
search=refresh token|token rotation|token family|replay detection
invariant=At most one live refresh token exists per family.
invariant=Replay revokes the entire token family.
effect=db.write(session_tokens)|event.emit(auth.session.revoked)
risk=auth|concurrency
rel=policy>auth.session.lifecycle
rel=test>auth.session.rotate.contract
stability=contract
*/
export async function rotateSession() {}
```

The referenced policy and test IDs must exist as source cards or registry records.

## Format and validate

```sh
npx llmnav format
npx llmnav check
```

`check` exits with status 1 for errors. Warnings do not fail the command.

GitHub annotation output is available for CI:

```sh
npx llmnav check --format github
```

## Generate deterministic indexes and catalogs

```sh
npx llmnav generate
```

The first run parses every source file and builds `index.json`, `search-index.json`, `file-state.json`, semantic catalogs, and a manifest. Later runs reuse unchanged file parses and card search documents.

Commit `.llmnav/cache`, `.llmnav/ids.jsonl`, and `.llmnav/order.lock`. Do not commit `.llmnav/state` or transaction work files.

Inspect machine-readable impact data when integrating with CI or an agent:

```sh
npx llmnav generate --json
```

`changedCards` distinguishes semantic, structure, and body changes. `affectedCatalogs` identifies only repository, module, and agent-context catalogs whose bytes changed.

CI should run:

```sh
npx llmnav generate --full --check
```

That command fails when generated files, the registry, or the stable order lock differ from current source. It does not replace the live cache. Normal generation stages and verifies a complete replacement before committing it.

## Search before opening source

```sh
npx llmnav query "where do replayed refresh tokens revoke their family" --top 5
npx llmnav show auth.session.rotate
npx llmnav context auth.session.rotate --depth 1 --budget 2500
```

Queries use the persistent inverted index and do not retokenize every card. If a previous generation was interrupted, the query command restores the last committed cache before reading it.

The expected agent workflow is:

1. Query from the task language.
2. Inspect a few cards and generated signatures.
3. Open the selected declarations.
4. Expand one semantic hop only when policy, test, fallback, or workflow context is needed.
5. Use broad grep only after LLMNav fails to return a credible candidate.

## Add task-language aliases

```json
{
  "version": 1,
  "aliases": {
    "session renewal": "auth.session.rotate",
    "token replay attack": "auth.session.rotate",
    "credit reservation": "billing.credit.reserve"
  }
}
```

Aliases are evaluated before lexical ranking and receive a large deterministic score boost.

## Add search regression cases

```jsonl
{"query":"revoke every session in the family when a refresh token is replayed","expected":["auth.session.rotate","auth.session.revoke-family"]}
{"query":"reserve credits before starting an external generation job","expected":["billing.credit.reserve"]}
```

```sh
npx llmnav eval
```

Do not lower the gates simply because a new card displaced an old result. Fix ambiguous roles, overloaded search phrases, aliases, or missing semantic relations first.
