---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-polls
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-polls`
- Version: `0.1.0`
- Kind: Workspace package
- Role: feature package
- Description: Multiple-choice polls attachable to any user content for slingshot
- Workspace path: `packages/slingshot-polls`
- Entry point: `packages/slingshot-polls/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-polls
```

## Export Paths

- `.`
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

- [API reference](/api/slingshot-polls/)
