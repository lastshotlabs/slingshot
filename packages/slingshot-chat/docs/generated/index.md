---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-chat
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-chat`
- Version: `0.1.0`
- Kind: Workspace package
- Role: feature package
- Description: Package documentation for this Slingshot workspace module.
- Workspace path: `packages/slingshot-chat`
- Entry point: `packages/slingshot-chat/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-chat
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
- `@lastshotlabs/slingshot-entity`: `workspace:*`
- `@lastshotlabs/slingshot-notifications`: `workspace:*`

## Peer Dependencies

- `@lastshotlabs/slingshot-permissions`: `workspace:*`
- `hono`: `>=4.12.12 <5`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-chat/)
