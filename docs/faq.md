# FAQ

## Should every function receive a card?

No. That makes retrieval noisier and creates a second copy of the program in prose. Start with architectural modules, public boundaries, risky workflows, orchestration points, and non-obvious invariants.

## Why not use JSDoc or docstrings alone?

JSDoc and docstrings target generated human documentation and language tooling. They do not define durable semantic IDs, controlled effects and risks, append-only catalog order, relation validation, deterministic search artifacts, or search regression gates. They can coexist with LLMNav cards.

## Does v0.2 change the `llmnav/1` syntax?

No. The source grammar remains `llmnav/1`. v0.2 adds generated acceleration and recovery files beside the existing schemaVersion 1 `index.json`.

## Does every query still tokenize every card?

No. `search-index.json` stores a sorted token dictionary, compact posting lists, and normalized phrase documents. A query tokenizes task text and reads only matching posting lists, while preserving v0.1 ranking behavior. Missing or incompatible search indexes are rebuilt in memory from `index.json`.

## What is the difference between `file-state.json` and `stat-hints.json`?

`file-state.json` is deterministic generated cache and can be committed. It stores content hashes and parsed records.

`stat-hints.json` is volatile and ignored. It stores size, mtime, and ctime only to avoid reading unchanged files. Deleting it changes performance, not generated output.

## What happens when generation fails halfway through?

The live cache is never edited one file at a time. LLMNav builds and verifies a staged cache, journals the directory swap, and retains a backup until commit. A thrown error rolls back immediately. A killed process is recovered by the next query, generation, or doctor command.

## Why is the built-in search lexical?

It is deterministic, local, measurable, multilingual enough for routing aliases, and requires no model or vector database. Embeddings should be considered only after real evaluation queries expose a persistent lexical gap.

## Why are paths and callers forbidden in cards?

They change during routine refactoring and can be derived more accurately. LLMNav writes current paths and declarations into generated indexes. Generated structure is never copied back into source comments.

## Why commit `.llmnav/cache`?

The files are deterministic agent context. Committing them makes drift reviewable, lets agents query without an initial setup run, and allows CI to verify byte equality. Do not commit `.llmnav/state`, `.llmnav/.transactions`, or an interrupted transaction journal.

## Does LLMNav execute project code?

No. Version 0.3 reads text files and writes its generated artifacts or explicitly requested card formatting. It has no plugin loader, install hook, or network request.

## Can cards be written in Korean?

Yes, but one repository language produces more consistent retrieval. Keep source cards in the codebase's primary language and place Korean task phrases in `.llmnav/lexicon.json`.

## Is the generated cache a model prompt cache?

No. It is stable prompt material designed to be placed before volatile task context. The model provider or agent harness controls actual prompt caching.

## Are benchmark numbers guaranteed on another machine?

No. The repository records exact measured values, environment, fixture size, and methodology. Correctness and memory limits are regression gates; wall-clock numbers must be remeasured on the target machine.

## Can multiple repositories share IDs?

Each repository has a `repositoryId`. Local relations use semantic IDs; `cross-repo>` uses `repository-id/semantic.id`. Cross-repository resolution remains future work.
