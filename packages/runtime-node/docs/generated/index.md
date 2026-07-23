---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-runtime-node
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-runtime-node`
- Version: `0.2.1`
- Kind: Workspace package
- Role: feature package
- Description: Node.js runtime implementation for Slingshot
- Workspace path: `packages/runtime-node`
- Entry point: `packages/runtime-node/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-runtime-node
```

## Export Paths

- `.`
- `./errors`
- `./testing`

## Package Scripts

- `build`: `tsc -p tsconfig.build.json`
- `coverage`: `bun test --coverage`
- `lint`: `eslint src/ --cache`
- `test`: `bun run test:vitest`
- `test:integration`: `vitest run --config vitest.config.ts tests/integration/`
- `test:vitest`: `vitest run --config vitest.config.ts`
- `typecheck`: `tsc --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `workspace:*`

## Peer Dependencies

- `@hono/node-server`: `>=2.0.5 <3`
- `argon2`: `>=0.31`
- `better-sqlite3`: `>=9.0`
- `fast-glob`: `>=3.0`
- `ws`: `>=8.20.1 <9`

## Related Docs

- [API reference](/api/slingshot-runtime-node/)
