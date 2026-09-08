# Korean self-navigation diagnostics and prospective observations

## Korean symptom queries

Eight fixed Korean task descriptions in `korean-queries.jsonl` exercise generation locking, rollback, context edge limits, Go package resolution, audit dispositions, format migration, search sharding, and string/comment parsing. They use the graph-aware session query path with five results. This is a diagnostic set, not a release gate or a held-out model benchmark.

On 2026-09-08, against runtime commit `b97cdadbd81a30483ab52486d746a5538fffabf1`, the original repository lexicon retrieved the expected ID first for only 1/8 cases: the mixed Go/import query. The other seven queries returned no results. The English-only cards had no matching Korean aliases for these task expressions.

Seven repository-local aliases were then added to `.llmnav/lexicon.json`: `하드링크`, `롤백`, `문맥 확장`, `주석 감사`, `생성 형식`, `검색 샤드`, and `문자열 안`. The same eight cases subsequently retrieved their expected IDs first (8/8). Query weights, tokenization, graph ranking, source cards, and the existing regression queries were unchanged.

This before/after result is **development-set fit**, not independent evidence of general Korean understanding. The aliases are phrases rather than whole-query special cases, but the same cases informed the changes and measured them. They affect navigation of this repository only; they are not shipped as a universal Korean vocabulary in the npm package. A repository with different IDs must define its own aliases. Short phrases can also be ambiguous, so future misses and wrong targets should be recorded rather than hidden by editing these cases.

The configured `llmnav_korean_diagnostic` intent reads the JSONL file and queries a project session. Outside the workspace command wrapper, first use `const session = await createProjectSession(root)`, then `session.query(query, { top: 5 })`. Do not substitute the existing graph-less `eval` path when reproducing these exact rankings.

## Observe the next real tasks

`navigation-observation.example.json` is an empty template, **not an observation**. No new real-task measurements have been collected in this change.

For the next 3–5 independently arising development tasks:

1. Record a non-sensitive task reference, starting commit, model/settings, and assigned condition (`baseline` or `llmnav`) before exploration. Do not invent tasks merely to exercise favorable keywords.
2. Count actual search requests and distinct source files opened from observable tool events. Count a wrong file only when the investigation establishes that it was irrelevant; a non-first candidate alone is not a wrong-file observation.
3. Record time to the first correct source only when timestamps are available. Keep missing token usage and timing fields `null`; do not estimate them from text length or candidate rank.
4. Record completion separately and link the actual test/acceptance evidence. A successful search is not a successful code change.
5. Keep raw prompts, transcripts, secrets, customer data, and source excerpts out of the observation record. Store only permitted references, counts, and limitations in the user's chosen task record; no background collector is installed.

Do not compare a second attempt after the correct file is known with an uninformed first attempt. A paired comparison needs independent fresh contexts or another explicitly controlled assignment. With only 3–5 heterogeneous tasks, report each case and its limitations rather than a broad percentage improvement. General efficiency and Korean holdout claims remain unmeasured.
