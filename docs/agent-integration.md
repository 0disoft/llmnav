# Agent integration

## Explicit initialization

Installing an npm package must not unexpectedly edit the host repository. LLMNav therefore performs no `postinstall` mutation.

Run the integration step explicitly:

```sh
npx llmnav init --agents all
```

The command writes one managed navigation protocol to the selected instruction files and always writes the canonical copy at `.llmnav/AGENT_INSTRUCTIONS.md`.

## Supported adapters

| Adapter | File |
| --- | --- |
| `agents` | `AGENTS.md` |
| `claude` | `CLAUDE.md` |
| `copilot` | `.github/copilot-instructions.md` |
| `cursor` | `.cursor/rules/llmnav.mdc` |

The adapters contain the same operational rules so agents do not develop vendor-specific navigation behavior.

Each Markdown adapter uses managed markers:

```md
<!-- llmnav:start -->
...
<!-- llmnav:end -->
```

Re-running initialization replaces the managed block and preserves unrelated repository instructions.

## Protocol installed for agents

The generated instruction tells an agent to:

1. Run `npm exec -- llmnav query "<task>" --top 5` before broad grep or directory scans.
2. Resolve a selected card with `npm exec -- llmnav show <id>`.
3. Use `npm exec -- llmnav context <id>` only when related semantic context is necessary.
4. Treat generated paths and signatures as volatile.
5. Keep IDs stable across moves and renames.
6. Update semantic fields only when meaning changes.
7. Never hand-maintain call, import, reference, implementation, export, or override relations.
8. Run format, check, and generation after semantic changes.
9. Fall back to broad search when no credible card is returned.

When a host supports structured tool calls, `llmnav tools --json` returns four stable provider-neutral definitions in fixed order: `llmnav_query`, `llmnav_show`, `llmnav_context`, and `llmnav_check`. The schemas reject unknown fields and omit the repository root so the trusted host binds scope outside model-generated input.

The protocol does not order an agent to trust a card over source code. It uses the card to choose what source to inspect.

## Package runners

Generated instructions use `npm exec -- llmnav` so a local dev dependency works without a global installation. Equivalent package-manager runners include:

```sh
npx llmnav query "task"
npm exec -- llmnav query "task"
pnpm exec llmnav query "task"
bunx llmnav query "task"
```

A project may replace command examples in its surrounding instructions, but re-running initialization restores the managed npm runner. The package has no install hook and `npm exec` resolves the already installed local binary.

## Prompt-cache placement

An agent harness that controls model input should use this order:

```text
stable tool definitions
stable agent protocol
.llmnav/cache/repo-core.txt
cache breakpoint
selected .llmnav/cache/modules/<module>.txt
cache breakpoint
user task
branch and diff state
query results
selected source bodies
test and tool output
```

The first two layers change rarely. The task and source bodies change frequently and belong after cache breakpoints.

Generation writes this ordering and the exact content into `.llmnav/cache/prompt-prefix.json`. Each partition records package, repository, or module cache scope, a content hash, an estimated token count, and an explicit boundary-after hint. `llmnav bundle` verifies the artifact against `manifest.json` before displaying it.

The host selects only the modules relevant to the current task, preserves the declared base order, and appends volatile task, diff, source, and tool-result context after the selected partitions. LLMNav deliberately leaves provider-specific cache-control syntax to the host.

## Tool wrappers

LLMNav v0.5 does not ship an MCP server. A wrapper can pass `getAgentToolDefinitions()` to its provider SDK and route calls through `executeAgentOperation(root, name, input)`.

Suggested contract:

```json
{
  "schemaVersion": 1,
  "operations": ["llmnav_query", "llmnav_show", "llmnav_context", "llmnav_check"]
}
```

Every execution returns the same schemaVersion 1 envelope with `operation`, `ok`, `data`, and `error`. Expected validation and not-found failures use stable `LNVAP` codes. Keep the definition and operation order stable across sessions so provider prompt caches can reuse the tool prefix.

## Failure behavior

An agent should not stop when a repository is partially annotated.

When `query` returns no credible result, the correct fallback is normal symbol search, grep, or language-server navigation. After completing the task, the agent may propose a new card only when the missed boundary satisfies the repository's annotation policy.

Search failure alone is not permission to annotate every function sharing a keyword.
