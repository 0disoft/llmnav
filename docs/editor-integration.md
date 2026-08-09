# Editor integration

## Deterministic diagnostics

```sh
llmnav check --format editor
```

The schemaVersion 1 report groups diagnostics by repository-relative path. Ranges use zero-based line and character coordinates, while each item retains numeric severity, textual level, stable diagnostic code, source, and message. The output contains no absolute workspace path, timestamp, editor identity, or platform separator.

An editor adapter should bind the repository root itself, map each relative path to its workspace document, and replace the previous LLMNav diagnostics for that document. Do not let model-generated input choose the root.

## Visual Studio Code

```sh
llmnav editor vscode
```

This prints a schemaVersion 1 integration envelope whose `config` value is a VS Code `tasks.json` configuration. The task runs the local package with `npm exec -- llmnav check` and maps LLMNav's standard text output into the Problems panel through a custom problem matcher.

If `.vscode/tasks.json` already exists, merge the generated task into its `tasks` array instead of replacing unrelated tasks. The generated command performs no file mutation.

The matcher follows the current [VS Code task and problem matcher contract](https://code.visualstudio.com/docs/debugtest/tasks): repository-relative file, line, column, severity, code, and message capture groups are declared explicitly.

## Other editors

Editors and language-client wrappers should consume `check --format editor` or call `diagnosticsToEditor(diagnostics)`. This keeps coordinate conversion and severity mapping in LLMNav while leaving document URI construction, lifecycle, debounce, and Problems-panel ownership to the editor integration.

LLMNav does not run a watcher or language server. A host decides when to invoke checks and how to cancel or replace stale results.
