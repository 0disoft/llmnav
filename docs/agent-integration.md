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

Only the markers and an immediately adjacent generated `## LLMNav code navigation` heading are replaced. If that heading is missing, renamed, or separated from the marker by team instructions, the text before and after the markers remains in place. Repeated updates do not duplicate the generated heading or block.

Initialization checks every selected instruction file before bootstrap writes. Incomplete, reversed, or duplicate marker pairs fail with usage status 2 and leave existing instructions, configuration, and package scripts untouched, including with `--force`. Correct the named file and rerun initialization. Later filesystem failures or process interruption can still leave partial bootstrap writes; this preflight is not a transaction across all instruction files.

## Protocol installed for agents

The generated instruction tells an agent to:

1. Run `npm exec -- llmnav query "<task>" --top 5` before broad grep or directory scans.
2. Resolve a selected card with `npm exec -- llmnav show <id>`.
3. Use `npm exec -- llmnav context <id>` only when related semantic context is necessary.
4. Treat generated paths and signatures as volatile.
5. Keep IDs stable across moves and renames.
6. Update semantic fields only when meaning changes.
7. Never hand-maintain call, import, reference, implementation, export, or override relations.
8. Run `llmnav audit` after initialization and structural boundary changes, review high and medium candidates, and never annotate automatically.
9. Encode accepted boundaries in narrow coverage rules and retrieval queries.
10. Run format, check, and generation after semantic changes.
11. Fall back to broad search when no credible card is returned.

When a host supports structured tool calls, `llmnav tools --json` returns six stable provider-neutral definitions in fixed order: `llmnav_query`, `llmnav_show`, `llmnav_context`, `llmnav_check`, `llmnav_explain`, and `llmnav_audit`. New definitions are appended so the existing stable tool prefix keeps its order. `llmnav_audit` exposes the same unannotated-boundary candidates as `llmnav audit`, filtered by a minimum priority and bounded by a candidate count, so a host that only reads the tool list can still route to the audit workflow. The schemas reject unknown fields and omit the repository root so the trusted host binds scope outside model-generated input.

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

`llmnav mcp` serves the same schema over the Model Context Protocol stdio transport:

```sh
llmnav mcp --root .
```

The server answers `initialize`, `ping`, `tools/list`, and `tools/call`, mapping every call onto `executeAgentOperation(root, name, input)`. Responses are newline-delimited JSON-RPC 2.0, notifications such as `notifications/initialized` are accepted silently, and tool results carry the schemaVersion 1 envelope as text content with `isError` set whenever `ok` is false, so expected validation and not-found failures stay inspectable by the model instead of becoming transport errors. The server keeps one prepared index snapshot for the lifetime of the session and reloads it only when the generated cache artifacts change. Each tool call is bounded by `requestTimeoutMs` (default 15 seconds, `0` disables it); a call that outlives it returns a JSON-RPC internal error with `data.code === "LNV102"`. Other transport errors carry `data` with `{ code, retryable, cause }`, so a host can distinguish a transient filesystem failure from a permanent one instead of retrying blind.

A host that speaks a different transport can still pass `getAgentToolDefinitions()` to its provider SDK and route calls through `executeAgentOperation(root, name, input)`.

Suggested contract:

```json
{
  "schemaVersion": 1,
  "operations": ["llmnav_query", "llmnav_show", "llmnav_context", "llmnav_check", "llmnav_explain", "llmnav_audit"]
}
```

Every execution returns the same schemaVersion 1 envelope with `operation`, `ok`, `data`, and `error`. Expected validation and not-found failures use stable `LNVAP` codes. Keep the definition and operation order stable across sessions so provider prompt caches can reuse the tool prefix.

See [Provider-neutral host integration](provider-neutral-integration.md) for the packaged typed adapter and complete host-boundary examples.

## Failure behavior

An agent should not stop when a repository is partially annotated.

When `query` returns no credible result, the correct fallback is normal symbol search, grep, or language-server navigation. After completing the task, the agent may propose a new card only when the missed boundary satisfies the repository's annotation policy.

Search failure alone is not permission to annotate every function sharing a keyword.

Audit priority is also not permission to invent a card. It is a deterministic prompt to inspect likely boundaries; durable ownership and invariants still come from the current source and repository contracts.
