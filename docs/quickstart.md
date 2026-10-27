# Quick start

Start with live discovery, then add semantic cards where a durable responsibility helps navigation. You can use the CLI without an API key or hosted service. Node.js 22+ is required, including when installing with Bun.

## Try live discovery first

Install with either package manager:

| npm | Bun |
| --- | --- |
| `npm install --save-dev llmnav` | `bun add --dev llmnav` |

Replace `rotateSession` with a symbol or task from your own repository:

```sh
npx llmnav discover "rotateSession" --top 1 --include-source --source-budget 4000 --json
```

Use `bunx llmnav` in place of `npx llmnav` for Bun. Discovery reads live source and needs no initialization, cards, or generated index. Its excerpt budget covers source text; JSON metadata is additional. If the excerpt is sufficient, reuse it for the edit. If you already know the file and identifier, start with a direct bounded read or exact search.

## Pick the next step

| Need | Next step |
| --- | --- |
| Locate unannotated code | Continue with `discover` and inspect the candidate source |
| Search by durable business responsibilities | Initialize, audit, and add one reviewed card below |
| Resolve compiler types or symbol references | Follow [language analysis setup](precise-analysis.md) |
| Connect an agent or MCP client | Follow [agent integration](agent-integration.md) |

## Install and initialize

```sh
npx llmnav init --agents all --package-scripts
```

This creates the `.llmnav` control directory, a JSON schema, the semantic ID registry, the stable order lock, deterministic generated indexes and catalogs, volatile state ignore rules, and managed instruction files for coding agents.

Initialization is explicit and may update managed agent files and package scripts; use `--agents none` to skip agent instruction files.

Review `.llmnav/config.json` before annotating code. The default scans the repository root while excluding build outputs, dependency directories, generated bundles, and common caches.

Source roots and evaluation files must remain inside the repository. The generated cache directory must remain below `.llmnav/`; parent traversal and symbolic-link control directories are rejected.

## Audit before annotating

```sh
npx llmnav audit
```

Start with high and medium candidates. The audit explains whether a file is a package entrypoint, public API, generated structural boundary, or high fan-in module. Narrow source signals also identify versioned schema literals, persistent dotted JSON filename protocols, and Tauri invoke adapters. It does not write source or invent card contents. Declaration files and common non-production or low-fan-in utility shapes are suppressed so the result is a review queue, not a demand to annotate every file.

In Go repositories, candidates represent packages. Full imports below a repository-contained `go.mod` contribute package fan-in, `cmd/*/main.go` is treated as a command entrypoint, and `_test.go` files do not create separate production candidates. Put one `module` card on a durable package representative; do not repeat the same package role on every Go file.

After accepting a candidate, write its durable meaning by inspecting the source, add a narrow `coverageRules` entry for that exact boundary, and add a real task-language query to `.llmnav/eval/queries.jsonl`. If review confirms that a candidate owns no durable navigation responsibility, add its exact path and a concrete reason to `audit.dispositions`. Never use a glob to dismiss a directory. The audit suppresses the reviewed candidate but reports the entry as stale when the file or its classification changes. Use `npx llmnav audit --fail-on high` in CI only after the initial review.

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
stability=contract
*/
export async function rotateSession() {}
```

Add semantic links such as `rel=policy>auth.session.lifecycle` and `rel=test>auth.session.rotate.contract` only after their target IDs exist as source cards or registry records. The minimal card above has no unresolved relation targets.

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

## Search when the responsibility is unclear

```sh
npx llmnav query "where do replayed refresh tokens revoke their family" --top 5
npx llmnav show auth.session.rotate
npx llmnav context auth.session.rotate --depth 1 --budget 2500
```

Queries use the persistent inverted index and do not retokenize every card. If a previous generation was interrupted, the query command restores the last committed cache before reading it.

For a task whose location is unclear:

1. Query from the task language.
2. Inspect the highest-ranked card and generated location; expand only for ambiguity.
3. Open the selected declarations.
4. Expand one semantic hop only when policy, test, fallback, or workflow context is needed.
5. Use ordinary search when no credible candidate appears. Known files and exact identifiers can go directly to a bounded read or text search.

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
