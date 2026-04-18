# Examples

This directory contains source-backed Slingshot example apps that are kept in sync with the current
workspace code.

These examples intentionally import workspace source directly rather than published packages. That
keeps them aligned with the repo during development and lets the repo typecheck them for drift.

## Current source-backed examples

- `with-auth/` - auth baseline
- `config-driven-domain/` - entity-first authoring pattern
- `collaboration-workspace/` - chat, community, media, polls, and interactions
- `content-platform/` - search, assets, SSR, SSG, and edge-oriented delivery

## Validation

Run this from the repo root:

```bash
bun run examples:typecheck
bun run examples:coverage
bun run examples:smoke
```

If an example changes, update the corresponding docs page under `packages/docs/src/content/docs/examples/`
in the same change.
