# LLMNav

LLMNav is a deterministic semantic navigation layer for LLM coding agents.

It adds compact, stable metadata to a small number of architectural and behavioral boundaries, compiles that metadata into repository catalogs, and gives agents a fast path from a task description to the code that matters.

LLMNav is not a documentation generator, an embedding database, or a reason to annotate every function. It is a protocol and a zero-runtime-dependency CLI for reducing broad repository scans, irrelevant context, stale hand-written links, and repeated prompt input.

## What it provides

* The `llmnav/1` comment specification
* A parser and data-loss-resistant canonical formatter
* Semantic lint rules with stable diagnostic codes
* A deterministic JSON and JSONL repository index
* Repository and module catalogs designed for prompt reuse
* Multilingual alias routing without duplicating translations in source comments
* `query`, `show`, and bounded `context` commands for coding agents
* Search regression tests with Recall@1, Recall@5, and MRR
* Managed instructions for AGENTS.md, Claude Code, GitHub Copilot, and Cursor
* GitHub Actions workflows for CI and npm publication

The package has no runtime dependencies and supports Node.js 22 or newer.

## Install

```sh
npm install --save-dev llmnav
npx llmnav init --agents all --package-scripts
```

The initialization command is explicit. LLMNav never edits a consumer repository from an npm `postinstall` script. Use `--agents none` when only the machine-readable control directory is desired.

The default initialization creates `.llmnav/`, installs a managed section into `AGENTS.md`, and generates an empty deterministic index. `--agents all` also creates managed instructions for Claude Code, GitHub Copilot, and Cursor.

## Add the first card

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

export async function rotateSession(
  input: RotateSessionInput,
): Promise<RotateSessionResult> {
  // implementation
}
```

The ID describes a durable capability, not a file path or current function name. It survives moves and renames.

## Generate and search

```sh
npx llmnav format
npx llmnav check
npx llmnav generate
npx llmnav query "replayed refresh token should revoke the family" --top 5
npx llmnav show auth.session.rotate
npx llmnav context auth.session.rotate --depth 1 --budget 2500
```

A query result includes the stable ID, role, generated location, current declaration signature, score, and ranking reasons. The agent reads those compact results before opening full source bodies.

## The core separation

LLMNav deliberately separates three kinds of information.

| Layer | Examples | Owner | Storage |
| --- | --- | --- | --- |
| Stable meaning | role, invariant, domain search phrases, effects, risks, semantic relations | human or coding agent | source comment |
| Generated structure | path, declaration, signature, imports, hashes | LLMNav and future language enrichers | generated index |
| Task state | branch, diff, test output, current request | agent harness | never stored in a card |

Paths, line numbers, commit hashes, callers, imports, and signatures are forbidden in source cards. They change too often and are more accurately generated.

## Comment styles

C-style block comments work in TypeScript, JavaScript, Go, Rust, Java, C, C++, C#, Swift, Dart, PHP, Svelte, Astro, and Vue files.

```go
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

Line-comment cards require an explicit terminator and work with `//`, `#`, and `--`.

```py
# llmnav/1 symbol
# id=billing.credit.reserve
# role=Reserve credits before an external generation job starts.
# search=credit hold|reserve credits|generation billing
# invariant=Captured credits never exceed the active reservation.
# effect=db.write(credit_reservations)
# risk=concurrency
# stability=contract
# /llmnav

def reserve_credits():
    pass
```

HTML comments are supported for markup-oriented files.

## Commands

| Command | Purpose |
| --- | --- |
| `llmnav init` | Create configuration, registry, schema, agent instructions, and the initial index |
| `llmnav check` | Parse and validate cards, relations, coverage rules, and registry state |
| `llmnav format` | Rewrite cards into their canonical key order and spacing |
| `llmnav generate` | Compile cards into deterministic cache catalogs and `index.json` |
| `llmnav query` | Rank cards for a natural-language task |
| `llmnav show` | Resolve one active or redirected semantic ID |
| `llmnav context` | Build a bounded context bundle around one ID |
| `llmnav eval` | Run repository-specific search regression queries |
| `llmnav doctor` | Inspect installation, generated-file drift, and manifest hashes |
| `llmnav spec` | Print machine-readable vocabularies and key order |

See [docs/cli.md](docs/cli.md) for every option and exit code.

## Generated layout

```text
.llmnav/
  AGENT_INSTRUCTIONS.md
  config.json
  ids.jsonl
  lexicon.json
  order.lock
  schema/
    config.schema.json
  eval/
    queries.jsonl
  cache/
    index.json
    cards.jsonl
    repo-core.txt
    agent-context.md
    manifest.json
    modules/
      auth.session.txt
      billing.credit.txt
```

`.llmnav/cache` is deterministic and intended to be committed. CI runs `llmnav generate --check` to reject stale generated context.

`order.lock` is append-only under normal development. A new card is appended rather than inserted into a globally re-sorted catalog, which preserves larger prompt prefixes across repository growth.

## Multilingual task language

Keep source cards in one repository language. Map user language, product wording, abbreviations, and historical names in `.llmnav/lexicon.json`.

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

This avoids repeating translations throughout source files and prevents a translation change from invalidating unrelated semantic cards.

## Search regression gates

Add real task descriptions to `.llmnav/eval/queries.jsonl`.

```jsonl
{"query":"재사용된 리프레시 토큰이면 같은 세션을 모두 폐기","expected":["auth.session.rotate","auth.session.revoke-family"]}
{"query":"외부 생성 작업 전에 크레딧을 먼저 묶어둔다","expected":["billing.credit.reserve"]}
```

Then run:

```sh
npx llmnav eval
```

The default gates are Recall@1 at 0.75 and Recall@5 at 0.90. A repository should tune these only after collecting representative historical tasks.

## Recommended adoption boundary

Annotate architectural modules, public entry points, authentication and payment boundaries, privacy boundaries, migrations, orchestration code with multiple external effects, high fan-in symbols, and code with non-obvious invariants.

Do not annotate trivial getters, generated files, obvious wrappers, every test function, or every private helper. LLMNav becomes worse when keyword-heavy comments cover the whole repository.

## Current implementation boundary

Version 0.1 provides the stable semantic layer, deterministic index, generated import lists, declaration attachment heuristics, relation traversal, and local lexical ranking.

It does not yet parse SCIP indexes, construct a full call graph, or use language-server ASTs. Those belong to generated structure enrichers rather than hand-written source metadata. The extension design is documented in [ROADMAP.md](ROADMAP.md) and [docs/architecture.md](docs/architecture.md).

## Documentation

* [Quick start](docs/quickstart.md)
* [Normative `llmnav/1` specification](docs/spec.md)
* [CLI reference](docs/cli.md)
* [Configuration reference](docs/configuration.md)
* [Programmatic API](docs/api.md)
* [Architecture and cache design](docs/architecture.md)
* [Agent integration](docs/agent-integration.md)
* [CI and enforcement](docs/ci.md)
* [Gradual migration](docs/migration.md)
* [Language examples](docs/language-examples.md)
* [Benchmarking](docs/benchmarking.md)
* [Research basis](docs/research.md)
* [Publishing checklist](docs/publishing.md)
* [FAQ](docs/faq.md)

## Development

```sh
npm install
npm test
npm run lint
npm run check
npm pack --dry-run
```

The project intentionally uses the Node.js standard library and built-in test runner. There is no build step and no production dependency tree to audit.

## Status

LLMNav is an experimental protocol and a usable v0.1 CLI. The source format is versioned independently from the npm package. Breaking syntax changes require a new `llmnav/N` header.

## License

MIT
