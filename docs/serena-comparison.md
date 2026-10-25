# Serena semantic navigation pilot

Measured on 2026-10-25 with Serena 2.1.0's tools interface, Windows x64, Node 24.18.0, uv 0.11.30, Python 3.11.15 and gopls 0.23.0. The [report](../benchmarks/results/serena-navigation-0.15.3.json) retains every candidate, physical declaration oracle, response size, timing, error and original-source check. The [earlier LLMNav report](../benchmarks/results/real-navigation-0.15.1.json) has identical corpus and task-plan hashes; it was collected on a different date.

## Retrieval results

| Corpus | Condition | Correct file first | Correct declaration first | Declaration within five |
| --- | --- | ---: | ---: | ---: |
| TypeScript | LLMNav ordinary discovery | 4/4 | 4/4 | 4/4 |
| TypeScript | LLMNav precise discovery | 4/4 | 4/4 | 4/4 |
| TypeScript | Serena find_symbol | 4/4 | 4/4 | 4/4 |
| Go | LLMNav ordinary discovery | 4/4 | 4/4 | 4/4 |
| Go | LLMNav precise discovery | 4/4 | 4/4 | 4/4 |
| Go | Serena find_symbol | 3/4 | 2/4 | 4/4 |

The TypeScript corpus is 13 unannotated Buildmarks scoring/shared files, 67,253 bytes, at commit `4884a072fc847223c4d27db843f0338d8a0de4e6`. Go uses four production files from Go 1.26.4's `go/token`, 38,125 bytes. Both originals remained unchanged. These are the same eight author-reviewed [identifier tasks](../benchmarks/real-navigation-cases.json), not natural-language traffic or a sealed holdout.

Serena receives one `find_symbol` call per task with `include_body: false` and the frozen identifier in `name_path_pattern`. No expected file path is supplied. A separate `Box.Read` fixture established that this Go LSP backend exposes flat method names: `Read` resolves, while `Box/Read` returns no candidates. Consequently, Go input uses `PositionFor`, `String` and `AddFile`; LLMNav's existing inputs include receiver names. This interface difference is part of this comparison and prevents attributing the result to general tool quality.

For `FileSet.PositionFor`, Serena returns `File.PositionFor` before `FileSet.PositionFor`. For `Token.String`, it returns `Position.String` before `Token.String`. Both requested declarations are second, so all eight Serena tasks succeed within five candidates. The result identifies receiver ambiguity in this lookup contract; an adaptive agent can inspect and disambiguate the candidates.

## Setup and timing boundary

| Corpus | Initialize MCP, seconds | First lookup including lazy work, seconds | Remaining three lookups, median ms |
| --- | ---: | ---: | ---: |
| TypeScript | 12.422 | 12.462 | 139.45 |
| Go | 9.979 | 5.026 | 113.58 |

These are diagnostic samples, not evidence of a speedup. The earlier LLMNav timings use different process boundaries and dates. Dependencies were cached or installed before measurement; filesystem caches were not flushed. MCP initialization and the first language-server lookup must not be hidden behind the four-sample median. Human setup and maintenance time are unmeasured.

Initially Go lookup failed because gopls was absent. The then-latest gopls 0.24.0 requires Go 1.27, while this machine has 1.26.4. Evaluation used compatible gopls 0.23.0 in an isolated binary directory, without upgrading Go or changing the global PATH. Serena's dashboard and GUI were disabled, and each owned server/process tree was stopped after its scope completed.

## Reproduce

Install evaluation dependencies separately from LLMNav's runtime dependencies. This run used `uvx --no-python-downloads --python 3.11 --from serena-agent==2.1.0`; exact benchmark versions identify the measured snapshot. Set `SERENA_HOME` to a disposable external directory and make gopls 0.23.0 available on the child process PATH. Serena manages its TypeScript language-server installation.

```sh
node benchmarks/serena-navigation.js --typescript-root <buildmarks-root> --go-root <GOROOT/src/go/token> --output <report.json>
```

The harness supplies only copied source and trusted fixture configuration to Serena. See Serena's official [tool contracts](https://oraios.github.io/serena/01-about/035_tools.html) and [configuration](https://oraios.github.io/serena/02-usage/050_configuration.html). [Actual edit success](model-coding-evaluation.md) is measured separately; retrieval rank alone cannot establish it.
