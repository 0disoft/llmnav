# Quick start

## Install and initialize

```sh
npm install --save-dev llmnav
npx llmnav init --agents all --package-scripts
```

This creates the `.llmnav` control directory, a JSON schema, the semantic ID registry, the stable order lock, generated catalogs, and managed instruction files for coding agents.

Review `.llmnav/config.json` before annotating code. The default scans the repository root while excluding build outputs, dependency directories, generated bundles, and common caches.

Source roots and evaluation files must remain inside the repository. The generated cache directory must remain below `.llmnav/`; parent traversal and symbolic-link control directories are rejected.

## Annotate a module boundary

Choose a boundary that an agent is likely to search for by behavior rather than by current symbol name.

```ts
/* llmnav/1 module
id=auth.session
role=Own refresh-token issuance, rotation, replay detection, and revocation.
owns=refresh-token family|session revocation
excludes=access-token signing|user profile storage
search=session renewal|refresh token|token replay
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

## Generate deterministic catalogs

```sh
npx llmnav generate
```

Commit `.llmnav/cache`, `.llmnav/ids.jsonl`, and `.llmnav/order.lock`.

CI should run:

```sh
npx llmnav generate --check
```

That command fails when generated files, the registry, or the stable order lock differ from current source.

## Search before opening source

```sh
npx llmnav query "where do replayed refresh tokens revoke their family" --top 5
npx llmnav show auth.session.rotate
npx llmnav context auth.session.rotate --depth 1 --budget 2500
```

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
    "세션 갱신": "auth.session.rotate",
    "토큰 재사용 공격": "auth.session.rotate",
    "크레딧 선점": "billing.credit.reserve"
  }
}
```

Aliases are evaluated before lexical ranking and receive a large deterministic score boost.

## Add search regression cases

```jsonl
{"query":"재사용된 리프레시 토큰이면 같은 세션을 모두 폐기","expected":["auth.session.rotate","auth.session.revoke-family"]}
{"query":"외부 생성 작업 전에 크레딧을 먼저 묶어둔다","expected":["billing.credit.reserve"]}
```

```sh
npx llmnav eval
```

Do not lower the gates simply because a new card displaced an old result. Fix ambiguous roles, overloaded search phrases, aliases, or missing semantic relations first.
