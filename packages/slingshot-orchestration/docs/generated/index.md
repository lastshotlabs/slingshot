---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-orchestration
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-orchestration`
- Version: `0.0.3`
- Kind: Workspace package
- Role: feature package
- Description: Portable orchestration runtime, task/workflow DSL, and built-in memory/SQLite adapters for Slingshot
- Workspace path: `packages/slingshot-orchestration`
- Entry point: `packages/slingshot-orchestration/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-orchestration
```

## Export Paths

- `.`
- `./errors`
- `./provider`
- `./testing`

## Package Scripts

- `build`: `tsc -p tsconfig.build.json`
- `coverage`: `bun test --coverage`
- `lint`: `eslint src/ --cache`
- `test`: `bun test`
- `test:integration`: `bun test tests/concurrency-stress.test.ts`
- `test:unit`: `bun test tests/ --ignore tests/concurrency-stress.test.ts`
- `typecheck`: `tsc --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `workspace:*`
- `better-sqlite3`: `^12.8.0`

## Peer Dependencies

- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-orchestration/)
