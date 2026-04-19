---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-infra
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-infra`
- Version: `0.0.2`
- Kind: Workspace package
- Role: feature package
- Description: Infrastructure configuration, deploy planning, and platform tooling for Slingshot apps
- Workspace path: `packages/slingshot-infra`
- Entry point: `packages/slingshot-infra/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-infra
```

## Export Paths

- `.`

## Package Scripts

- `build`: `tsc -p tsconfig.build.json`
- `lint`: `eslint src/ --cache`
- `typecheck`: `tsc -p tsconfig.json --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `workspace:*`
- `yaml`: `^2.7.0`

## Peer Dependencies

- `@aws-sdk/client-s3`: `>=3.0`
- `@aws-sdk/client-ssm`: `>=3.0`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-infra/)
