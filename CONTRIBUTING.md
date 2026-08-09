# Contributing

LLMNav accepts focused changes that preserve determinism, small context surfaces, and explicit compatibility.

## Development

Use Node.js 22 or newer.

```sh
npm ci
npm test
npm run check
npm pack --dry-run
```

No build step is required. Production dependencies are intentionally absent. A dependency proposal must explain why the Node.js standard library cannot provide the behavior, its installation and security cost, and the measured benefit.

## Change rules

Parser changes require fixtures for accepted and rejected syntax. Search changes require regression queries showing the improvement and proving that existing cases do not regress. Generated artifact changes must remain byte-for-byte deterministic across repeated runs. New source fields require a specification amendment, schema update, formatter support, diagnostics, tests, and a compatibility decision.

Do not add hand-maintained paths, line numbers, signatures, imports, callers, or call edges to semantic cards.

## Pull requests

Keep each pull request centered on one behavior. Include the failure mode, the chosen contract, tests, and migration impact. Update CHANGELOG.md for user-visible changes.

Run this before opening the pull request:

```sh
npm run check
npm pack --dry-run
```

## Commit messages

Conventional Commits are recommended but not enforced. Clear examples are `fix(parser): preserve indentation in block cards` and `feat(search): add alias collision diagnostics`.
