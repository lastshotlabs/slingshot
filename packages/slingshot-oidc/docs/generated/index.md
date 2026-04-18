---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-oidc
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-oidc`
- Version: `0.1.0`
- Kind: Workspace package
- Role: feature package
- Description: OIDC discovery and JWKS plugin for Slingshot
- Workspace path: `packages/slingshot-oidc`
- Entry point: `packages/slingshot-oidc/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-oidc
```

## Export Paths

- `.`

## Package Scripts

- `build`: `tsc -p tsconfig.build.json`
- `lint`: `eslint src/ --cache`
- `prepublishOnly`: `bun run build`
- `typecheck`: `tsc --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `^0.1.0`

## Peer Dependencies

- `@lastshotlabs/slingshot-auth`: `^0.1.0`
- `hono`: `>=4.12.12 <5`
- `jose`: `>=6.0`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-oidc/)
