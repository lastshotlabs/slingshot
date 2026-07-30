---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-assets
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-assets`
- Version: `0.2.12`
- Kind: Workspace package
- Role: feature package
- Description: Entity-backed asset storage, upload metadata, and storage adapter resolution for Slingshot
- Workspace path: `packages/slingshot-assets`
- Entry point: `packages/slingshot-assets/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-assets
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
- `test:unit`: `bun test tests/unit`
- `typecheck`: `tsc --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `workspace:*`
- `@lastshotlabs/slingshot-entity`: `workspace:*`
- `@lastshotlabs/slingshot-permissions`: `workspace:*`

## Peer Dependencies

- `@aws-sdk/client-s3`: `>=3.0`
- `@aws-sdk/lib-storage`: `>=3.0`
- `@aws-sdk/s3-request-presigner`: `>=3.0`
- `better-sqlite3`: `>=9.0`
- `hono`: `>=4.12.14 <5`
- `ioredis`: `>=5 <6`
- `mongoose`: `>=9.0 <10`
- `pg`: `>=8.20 <9`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-assets/)
