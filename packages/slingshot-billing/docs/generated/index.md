---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-billing
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-billing`
- Version: `0.2.0`
- Kind: Workspace package
- Role: feature package
- Description: Provider-abstracted billing for Slingshot: subscriptions, trials, donations, and an app-agnostic entitlement surface
- Workspace path: `packages/slingshot-billing`
- Entry point: `packages/slingshot-billing/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-billing
```

## Export Paths

- `.`
- `./config`
- `./public`

## Package Scripts

- `build`: `tsc -p tsconfig.build.json`
- `lint`: `eslint src/ --cache`
- `test`: `bun test tests`
- `test:unit`: `bun test tests/unit`
- `typecheck`: `tsc --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `workspace:*`
- `@lastshotlabs/slingshot-entity`: `workspace:*`
- `stripe`: `^22.3.2`
- `zod`: `>=4.0 <5`

## Peer Dependencies

- `hono`: `>=4.12.14 <5`

## Related Docs

- [API reference](/api/slingshot-billing/)
