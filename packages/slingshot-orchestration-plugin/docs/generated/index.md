---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-orchestration-plugin
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-orchestration-plugin`
- Version: `0.0.2`
- Kind: Workspace package
- Role: feature package
- Description: Slingshot plugin, context helpers, and HTTP routes for the portable orchestration runtime
- Workspace path: `packages/slingshot-orchestration-plugin`
- Entry point: `packages/slingshot-orchestration-plugin/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-orchestration-plugin
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
- `typecheck`: `tsc --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `workspace:*`
- `@lastshotlabs/slingshot-orchestration`: `workspace:*`

## Peer Dependencies

- `hono`: `>=4.12.14 <5`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-orchestration-plugin/)
