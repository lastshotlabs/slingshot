---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-notifications
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-notifications`
- Version: `0.1.0`
- Kind: Workspace package
- Role: feature package
- Description: Shared notification storage, scheduling, and delivery events for slingshot
- Workspace path: `packages/slingshot-notifications`
- Entry point: `packages/slingshot-notifications/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-notifications
```

## Export Paths

- `.`
- `./rateLimit`
- `./testing`

## Package Scripts

- `build`: `tsc -p tsconfig.build.json`
- `lint`: `eslint src/ --cache`
- `prepublishOnly`: `bun run build`
- `test`: `bun test tests`
- `typecheck`: `tsc --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `^0.1.0`
- `@lastshotlabs/slingshot-entity`: `workspace:*`
- `zod`: `>=4.0 <5`

## Peer Dependencies

- `hono`: `>=4.12.12 <5`

## Related Docs

- [API reference](/api/slingshot-notifications/)
