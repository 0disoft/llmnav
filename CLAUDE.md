# Claude Code instructions

## LLMNav code navigation

<!-- llmnav:start -->
Before broad grep, directory scans, or opening many source files, run `npm exec -- llmnav query "<task>" --top 5`.

Resolve the selected semantic ID with `npm exec -- llmnav show <id>`. Use `npm exec -- llmnav context <id> --depth 1 --budget 2500` when related policy, workflow, fallback, migration, or test cards are needed.

Read generated cards and signatures before opening full symbol bodies. Treat paths, line numbers, signatures, imports, and hashes as generated data rather than source-of-truth annotations.

Keep an existing LLMNav ID when a symbol or file is renamed or moved. Change `role`, `invariant`, `effect`, `risk`, and semantic `rel` values only when behavior or contracts change.

Do not add hand-maintained `calls`, `imports`, `references`, `implements`, `exports`, or `overrides` relations. Do not put paths, line numbers, commit hashes, timestamps, callers, or current signatures in LLMNav source comments.

After semantic changes, run `npm exec -- llmnav format`, `npm exec -- llmnav check`, and `npm exec -- llmnav generate`. Use broad text search only when LLMNav returns no credible candidate.
<!-- llmnav:end -->
