---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot-auth
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot-auth`
- Version: `0.0.3`
- Kind: Workspace package
- Role: feature package
- Description: Authentication, sessions, MFA, OAuth, WebAuthn, and passkeys for Slingshot
- Workspace path: `packages/slingshot-auth`
- Entry point: `packages/slingshot-auth/src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot-auth
```

## Export Paths

- `.`
- `./plugin`
- `./testing`

## Package Scripts

- `build`: `tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json`
- `lint`: `eslint src/ --cache`
- `typecheck`: `tsc --noEmit`

## Dependencies

- `@lastshotlabs/slingshot-core`: `workspace:*`

## Peer Dependencies

- `@lastshotlabs/slingshot-postgres`: `workspace:*`
- `@simplewebauthn/server`: `>=10.0.0`
- `arctic`: `>=3.0`
- `hono`: `>=4.12.14 <5`
- `ioredis`: `>=5.0 <6`
- `jose`: `>=6.0`
- `mongoose`: `>=9.0 <10`
- `otpauth`: `>=9.0 <10`
- `pg`: `^8.20.0`
- `samlify`: `^2.8`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot-auth/)
