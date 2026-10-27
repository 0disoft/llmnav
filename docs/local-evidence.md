# Local provenance and verification

## File history

```sh
llmnav history src/analysis.js --json
```

API: `getFileHistory(root, file, { signal, timeoutMs, gitCommand })`; MCP: `llmnav_history` with `{ file }`. Use a path from `show` or `discover`. The operation has no default-navigation cost and writes no Git state or generated artifact.

`lastChange` names the last file commit and committer date, with `scope: "file"`. `dirty` separates staged, unstaged and untracked changes. Index and working-file byte fingerprints refresh even when HEAD is unchanged. Missing/deleted working files have a null hash. Unborn repositories have no HEAD or last change; non-Git folders return `unknown`. Missing tools, permissions, cancellation and process failures propagate rather than becoming an empty history.

History lookup pins `git log --follow` to the observed HEAD. Its bounded in-memory cache keys repository, revision, path and shallow state; volatile status and worktree hashes are never cached. Shallow repositories report incomplete history. Rename handling follows Git's heuristic. Reads are best-effort observations rather than an atomic Git/worktree transaction, and `symbolHistory` remains `unknown`. File dates do not establish when a particular function changed, whether tests passed, or whether performance improved.

Git runs with literal pathspecs, disabled filesystem-monitor hooks, no optional locks, bounded output, a default 10-second deadline and cancellation. File fingerprints reject path traversal and symlink/junction traversal, bound each file to 64 MiB and close owned handles on failure.
