---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-kafka
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-kafka`
- Version: `0.0.2`
- Kind: Workspace package
- Role: feature package
- Description: Kafka event bus adapter and Kafka connectors for Slingshot
- Workspace path: `packages/slingshot-kafka`
- Entry point: `packages/slingshot-kafka/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-kafka
```

## Export Paths

- `.`
- `./errors`
- `./testing`

## Package Scripts

- `build`: `tsc -p tsconfig.build.json`
- `test`: `cd ../.. && bun test packages/slingshot-kafka/tests`
- `typecheck`: `tsc -p tsconfig.json --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `workspace:*`

## Peer Dependencies

- `kafkajs`: `^2.2.4`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-kafka/)
