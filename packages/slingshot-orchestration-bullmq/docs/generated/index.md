---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-orchestration-bullmq
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-orchestration-bullmq`
- Version: `0.0.3`
- Kind: Workspace package
- Role: feature package
- Description: BullMQ-backed orchestration adapter for Slingshot tasks and workflows
- Workspace path: `packages/slingshot-orchestration-bullmq`
- Entry point: `packages/slingshot-orchestration-bullmq/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-orchestration-bullmq
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
- `test:integration`: `bun test tests/integration`
- `test:unit`: `bun test --ignore tests/integration`
- `typecheck`: `tsc --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `workspace:*`
- `@lastshotlabs/slingshot-orchestration`: `workspace:*`

## Peer Dependencies

- `bullmq`: `>=5 <6`
- `ioredis`: `>=5 <6`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-orchestration-bullmq/)
