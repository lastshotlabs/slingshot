---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-search
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-search`
- Version: `0.0.4`
- Kind: Workspace package
- Role: feature package
- Description: Enterprise search plugin for Slingshot — per-entity search with Meilisearch, Typesense, Elasticsearch, Algolia, or DB-native providers
- Workspace path: `packages/slingshot-search`
- Entry point: `packages/slingshot-search/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-search
```

## Export Paths

- `.`
- `./errors`
- `./testing`

## Package Scripts

- `bench`: `bun run tests/bench/search-throughput.bench.ts`
- `build`: `tsc -p tsconfig.build.json`
- `coverage`: `bun test --coverage`
- `lint`: `eslint src/ --cache`
- `test`: `bun test`
- `test:integration`: `bun test tests/providers tests/routes`
- `test:unit`: `bun test tests/unit`
- `typecheck`: `tsc --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `workspace:*`

## Peer Dependencies

- `@hono/zod-openapi`: `>=0.18`
- `hono`: `>=4.12.14 <5`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-search/)
