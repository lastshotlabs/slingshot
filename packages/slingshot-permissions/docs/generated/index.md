---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-permissions
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-permissions`
- Version: `0.1.1`
- Kind: Workspace package
- Role: library package
- Description: Policy engine for slingshot — grants, roles, tenant-scoped permission evaluation
- Workspace path: `packages/slingshot-permissions`
- Entry point: `packages/slingshot-permissions/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-permissions
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

- `mongoose`: `>=9.0 <10`
- `pg`: `^8.20.0`

## Related Docs

- [API reference](/api/slingshot-permissions/)
