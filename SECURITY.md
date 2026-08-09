# Security policy

## Supported versions

Until 1.0, security fixes target the latest published minor release.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose source, overwrite files outside the project root, execute repository code, bypass path restrictions, or compromise npm publication.

Use GitHub private vulnerability reporting on the repository's Security tab. Include the affected version, operating system, minimal reproduction, impact, and any proposed mitigation.

## Security boundaries

LLMNav is a local developer tool. It treats repository source and `.llmnav/cache` as equally sensitive. Version 0.1 performs no network requests, executes no scanned source, and loads no third-party plugins.

Formatting modifies source files only after an explicit `llmnav format`. Initialization writes known project files only after an explicit `llmnav init`. Source and evaluation paths must remain inside the repository, generated output must remain below `.llmnav/`, and existing symbolic-link traversal in managed write paths is rejected.

Reports involving path traversal, symlink escapes, unsafe archive handling, command execution, malicious configuration, or publication workflow compromise are considered high priority.
