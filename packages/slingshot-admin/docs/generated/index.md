---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-admin
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-admin`
- Version: `0.0.2`
- Kind: Workspace package
- Role: feature package
- Description: Admin plugin for Slingshot
- Workspace path: `packages/slingshot-admin`
- Entry point: `packages/slingshot-admin/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-admin
```

## Export Paths

- `.`
- `./config`
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

- `hono`: `>=4.12.14 <5`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-admin/)
