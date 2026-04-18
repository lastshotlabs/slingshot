---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-bullmq
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-bullmq`
- Version: `0.1.1`
- Kind: Workspace package
- Role: feature package
- Description: Package documentation for this Slingshot workspace module.
- Workspace path: `packages/slingshot-bullmq`
- Entry point: `packages/slingshot-bullmq/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-bullmq
```

## Export Paths

- `.`

## Package Scripts

- `build`: `tsc -p tsconfig.build.json`
- `lint`: `eslint src/ --cache`
- `prepublishOnly`: `bun run build`
- `test`: `cd ../.. && bun test tests/unit/bullmq-adapter.test.ts && bun test tests/isolated/bullmq-adapter-durable.test.ts`
- `test:redis`: `cd ../.. && BULLMQ_INTEGRATION_REDIS_URL=redis://localhost:6380 bun test tests/docker/bullmq-adapter-redis-integration.test.ts`
- `typecheck`: `tsc -p tsconfig.json --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `^0.1.0`

## Peer Dependencies

- `bullmq`: `>=5`
- `ioredis`: `>=5`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-bullmq/)
