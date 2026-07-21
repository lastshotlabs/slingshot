---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-orchestration-engine
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-orchestration-engine`
- Version: `0.2.1`
- Kind: Workspace package
- Role: feature package
- Description: Portable orchestration runtime, task/workflow DSL, and built-in memory/SQLite adapters for Slingshot
- Workspace path: `packages/slingshot-orchestration-engine`
- Entry point: `packages/slingshot-orchestration-engine/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-orchestration-engine
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

- [API reference](/api/slingshot-orchestration-engine/)
