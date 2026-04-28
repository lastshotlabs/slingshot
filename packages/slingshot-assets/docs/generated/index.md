---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-assets
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-assets`
- Version: `0.0.2`
- Kind: Workspace package
- Role: feature package
- Description: Entity-backed asset storage, upload metadata, and storage adapter resolution for Slingshot
- Workspace path: `packages/slingshot-assets`
- Entry point: `packages/slingshot-assets/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-assets
```

## Export Paths

- `.`
- `./testing`

## Package Scripts

- `build`: `tsc -p tsconfig.build.json`
- `lint`: `eslint src/ --cache`
- `typecheck`: `tsc --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `workspace:*`
- `@lastshotlabs/slingshot-entity`: `workspace:*`
- `@lastshotlabs/slingshot-permissions`: `workspace:*`

## Peer Dependencies

- `@aws-sdk/client-s3`: `>=3.0`
- `@aws-sdk/s3-request-presigner`: `>=3.0`
- `hono`: `>=4.12.12 <5`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-assets/)
