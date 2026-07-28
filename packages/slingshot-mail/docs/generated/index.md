---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-mail
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-mail`
- Version: `0.2.5`
- Kind: Workspace package
- Role: feature package
- Description: Transactional mail with provider drivers, queues, and renderer integration for Slingshot
- Workspace path: `packages/slingshot-mail`
- Entry point: `packages/slingshot-mail/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-mail
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

## Peer Dependencies

- `@aws-sdk/client-sesv2`: `>=3.0`
- `@react-email/render`: `>=2.0 <3`
- `bullmq`: `>=5 <6`
- `hono`: `>=4.12.14 <5`
- `ioredis`: `>=5 <6`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-mail/)
