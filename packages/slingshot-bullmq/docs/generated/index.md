---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-bullmq
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-bullmq`
- Version: `0.0.2`
- Kind: Workspace package
- Role: feature package
- Description: Durable BullMQ-backed event bus adapter for Slingshot
- Workspace path: `packages/slingshot-bullmq`
- Entry point: `packages/slingshot-bullmq/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-bullmq
```

## Export Paths

- `.`
- `./errors`
- `./testing`

## Package Scripts

- `bench`: `bun run tests/bench/emit-throughput.bench.ts`
- `build`: `tsc -p tsconfig.build.json`
- `coverage`: `bun test --coverage`
- `lint`: `eslint src/ --cache`
- `test`: `bun test`
- `test:integration`: `bun test tests/integration`
- `test:redis`: `cd ../.. && BULLMQ_INTEGRATION_REDIS_URL=redis://localhost:6380 bun test tests/docker/bullmq-adapter-redis-integration.test.ts`
- `test:unit`: `bun test --ignore tests/integration --ignore tests/helpers`
- `typecheck`: `tsc -p tsconfig.json --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `workspace:*`

## Peer Dependencies

- `bullmq`: `>=5`
- `ioredis`: `>=5`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-bullmq/)
