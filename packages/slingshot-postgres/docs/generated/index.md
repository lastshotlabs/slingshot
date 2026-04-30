---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-postgres
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-postgres`
- Version: `0.0.2`
- Kind: Workspace package
- Role: adapter package
- Description: Postgres adapter and connection helper for Slingshot auth
- Workspace path: `packages/slingshot-postgres`
- Entry point: `packages/slingshot-postgres/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-postgres
```

## Export Paths

- `.`
- `./errors`
- `./testing`

## Package Scripts

- `build`: `tsc -p tsconfig.build.json`
- `coverage`: `bun test --coverage`
- `lint`: `eslint src/ --cache`
- `test`: `bun test`
- `test:docker`: `bun test tests/docker/`
- `typecheck`: `tsc --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `workspace:*`

## Peer Dependencies

- `drizzle-orm`: `^0.45.2`
- `pg`: `^8.20.0`

## Related Docs

- [API reference](/api/slingshot-postgres/)
