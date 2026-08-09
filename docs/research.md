# Research basis

LLMNav is an engineering proposal built from a recurring result in repository-level code intelligence: retrieval quality depends more on selecting the right structure and context than on sending more source text to a model.

## Repository-level retrieval

[RepoCoder](https://arxiv.org/abs/2303.12570) uses an iterative retrieval and generation loop instead of treating repository context as one static prompt. That supports LLMNav's `query → show → context → source` workflow.

[Repoformer](https://arxiv.org/abs/2403.10059) studies selective retrieval and reports that retrieval can be unnecessary or harmful for some completions. LLMNav therefore keeps the first result set small and does not force a repository dump into every request.

[GraphCoder](https://arxiv.org/abs/2406.07003) combines code context with graph structure. [CodexGraph](https://arxiv.org/abs/2408.03910) exposes repository graphs to agents. These works support the separation between hand-written semantic cards and generated structural edges.

[Aider's repository map](https://aider.chat/docs/repomap.html) is a practical example of presenting selected declarations and signatures under a token budget rather than copying every file.

## What the research does not prove

None of these projects validates the exact `llmnav/1` syntax, field weights, byte limits, or CI thresholds in this repository. Those are testable design choices, not established constants.

LLMNav also makes no universal claim that comments increase model accuracy. Unbounded comments can add stale facts, duplicate code, and distort lexical retrieval. The protocol deliberately limits cards to scarce semantic facts and measures retrieval with repository-specific queries.

## Falsifiable claims

A useful LLMNav installation should demonstrate all of the following against its own baseline:

1. The correct semantic ID appears more often in the first five results.
2. Agents open fewer irrelevant files before reaching the target declaration.
3. Uncached input tokens decrease when stable catalogs are reused.
4. Final task success does not regress.
5. Stale source metadata remains at zero because volatile structure is generated.

Use [benchmarking.md](benchmarking.md) to measure those claims. Do not advertise token or latency reductions measured on another repository as expected results for yours.
