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

LLMNav emits catalogs but deliberately leaves provider-specific caching to the agent harness.

## Tool wrappers

LLMNav v0.2 does not ship an MCP server. A separate wrapper may expose a small stable tool surface instead of one tool per operation.

Suggested contract:

```json
{
  "name": "llmnav",
  "operations": ["query", "show", "context", "check"]
}
```

Keep the tool definition and operation order stable across sessions. Return JSON output from the existing CLI or import the library API directly.

## Failure behavior

An agent should not stop when a repository is partially annotated.

When `query` returns no credible result, the correct fallback is normal symbol search, grep, or language-server navigation. After completing the task, the agent may propose a new card only when the missed boundary satisfies the repository's annotation policy.

Search failure alone is not permission to annotate every function sharing a keyword.
