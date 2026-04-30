---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-ssr
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-ssr`
- Version: `0.0.2`
- Kind: Workspace package
- Role: feature package
- Description: SSR, ISR, and page-routing plugin for Slingshot
- Workspace path: `packages/slingshot-ssr`
- Entry point: `packages/slingshot-ssr/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-ssr
```

## Export Paths

- `.`
- `./actions`
- `./draft`
- `./errors`
- `./isr`
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

## Peer Dependencies

- `hono`: `>=4.12.14 <5`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-ssr/)
