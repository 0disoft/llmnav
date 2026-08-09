# FAQ

## Should every function receive a card?

No. That makes retrieval noisier and creates a second copy of the program in prose. Start with architectural modules, public boundaries, risky workflows, orchestration points, and non-obvious invariants.

## Why not use JSDoc or docstrings alone?

JSDoc and docstrings target generated human documentation and language tooling. They do not define durable semantic IDs, controlled effects and risks, append-only catalog order, relation validation, or search regression gates. They can coexist with LLMNav cards.

## Why is the built-in search lexical?

It is deterministic, local, fast, multilingual enough for routing aliases, and requires no model or vector database. Embeddings should be added only after real evaluation queries expose a persistent lexical gap.

## Why are paths and callers forbidden in cards?

They change during routine refactoring and can be derived more accurately. LLMNav writes current paths and declarations into the generated index.

## Why commit `.llmnav/cache`?

The files are deterministic agent context. Committing them makes drift reviewable and lets agents read a ready catalog without a setup step. Repositories that cannot commit generated paths may ignore the cache and generate it locally, but must adjust CI accordingly.

## Does LLMNav execute project code?

No. Version 0.1 reads text files and writes its own generated artifacts or explicitly requested card formatting. It has no plugin loader and makes no network request.

## Can cards be written in Korean?

Yes, but one repository language produces more consistent retrieval. Keep source cards in the codebase's primary language and place Korean task phrases in `.llmnav/lexicon.json`.

## Is the generated cache a prompt cache?

No. It is stable prompt material designed to be placed before volatile task context. The model provider or agent harness controls actual prompt caching.

## Can multiple repositories share IDs?

Each repository has a `repositoryId`. Local relations use semantic IDs; `cross-repo>` uses `repository-id/semantic.id`. A future workspace index will resolve those edges across repositories.
