---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-admin
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-admin`
- Version: `0.1.1`
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
- `./testing`

## Package Scripts

- `build`: `tsc -p tsconfig.build.json`
- `lint`: `eslint src/ --cache`
- `prepublishOnly`: `bun run build`
- `typecheck`: `tsc --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `^0.1.0`

## Peer Dependencies

- `hono`: `>=4.12.12 <5`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-admin/)
