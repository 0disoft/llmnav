## Problem

Describe the concrete parser, retrieval, determinism, compatibility, or documentation problem.

## Contract

State the behavior this change establishes. Mention source grammar or generated schema compatibility when relevant.

## Verification

```sh
npm run check
npm pack --dry-run
```

Add parser fixtures for syntax changes and evaluation queries for search changes.

## Generated artifacts

- [ ] `.llmnav/cache` is current.
- [ ] `CHANGELOG.md` covers user-visible changes.
- [ ] No volatile path, line, signature, import, caller, or call edge was added to a source card.
