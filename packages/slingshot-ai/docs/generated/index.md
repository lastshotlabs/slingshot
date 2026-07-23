---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-ai
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-ai`
- Version: `0.3.2`
- Kind: Workspace package
- Role: feature package
- Description: Multi-provider LLM capability for Slingshot — generation, structured output, moderation, cost tracking
- Workspace path: `packages/slingshot-ai`
- Entry point: `packages/slingshot-ai/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-ai
```

## Export Paths

- `.`
- `./orchestration`
- `./testing`

## Package Scripts

- `build`: `tsc -p tsconfig.build.json`
- `lint`: `eslint src/ --cache`
- `typecheck`: `tsc --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `workspace:*`
- `@lastshotlabs/slingshot-entity`: `workspace:*`

## Peer Dependencies

- `@anthropic-ai/sdk`: `>=0.30`
- `@lastshotlabs/slingshot-orchestration`: `workspace:*`
- `@lastshotlabs/slingshot-orchestration-engine`: `workspace:*`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-ai/)
