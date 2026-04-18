---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-webhooks
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-webhooks`
- Version: `0.0.2`
- Kind: Workspace package
- Role: feature package
- Description: Package documentation for this Slingshot workspace module.
- Workspace path: `packages/slingshot-webhooks`
- Entry point: `packages/slingshot-webhooks/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-webhooks
```

## Export Paths

- `.`
- `./testing`

## Package Scripts

- `build`: `tsc -p tsconfig.build.json`
- `lint`: `eslint src/ --cache`
- `prepublishOnly`: `bun run build`
- `typecheck`: `tsc --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `^0.1.0`
- `@lastshotlabs/slingshot-entity`: `^0.1.0`

## Peer Dependencies

- `hono`: `>=4.12.12 <5`
- `mongoose`: `>=9.0 <10`
- `pg`: `^8.20.0`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-webhooks/)
