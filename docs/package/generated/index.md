---
title: Generated
description: Auto-generated workspace facts for @lastshotlabs/slingshot
---

> Generated from package metadata by `bun run docs:sync`. Re-run the command to refresh this page.

## Package Facts

- Package: `@lastshotlabs/slingshot`
- Version: `0.0.1`
- Kind: Root package
- Role: app assembly package
- Description: Config-driven backend framework built on Hono. Plugin-driven, manifest-first.
- Workspace path: `.`
- Entry point: `src/index.ts`

## Install

```bash
bun add @lastshotlabs/slingshot
```

## Export Paths

- `.`
- `./mongo`
- `./queue`
- `./redis`
- `./testing`

## Package Scripts

- `build`: `bun scripts/build.ts`
- `build:packages`: `bun scripts/build.ts --packages-only`
- `dev`: `bun --watch src/index.ts`
- `docs:api`: `bun packages/docs/generate-api.ts`
- `docs:build`: `bun run docs:generate && cd packages/docs && bun run build`
- `docs:ci`: `bun run docs:generate && bun run docs:typecheck && bun run docs:impact && bun run docs:coverage && bun run examples:typecheck && bun run examples:coverage && bun run examples:smoke`
- `docs:coverage`: `bun packages/docs/coverage-docs.ts`
- `docs:dev`: `bun run docs:generate && cd packages/docs && bun run dev`
- `docs:generate`: `bun run docs:sync && bun run docs:api`
- `docs:impact`: `bun packages/docs/docs-impact.ts`
- `docs:preview`: `bun run docs:build && cd packages/docs && bun run preview`
- `docs:sync`: `bun packages/docs/sync-workspace-docs.ts`
- `docs:typecheck`: `bun packages/docs/typecheck-docs.ts`
- `examples:coverage`: `bun scripts/examples-coverage.ts`
- `examples:smoke`: `bun scripts/examples-smoke.ts`
- `examples:typecheck`: `tsc -p tsconfig.examples.json --pretty false`
- `format`: `prettier --write .`
- `format:check`: `prettier --check .`
- `hardening:core`: `bun run lint && bun run format:check && bun run typecheck && bun run typecheck:root && bun run build && bun run test`
- `hardening:full`: `bun run hardening:core && bun run lint:deps && bun run test:docker && bun run test:e2e && bun run test:coverage:check && bun run docs:ci`
- `lint`: `eslint src/ --cache && bun run --filter '*' lint`
- `lint:deps`: `depcruise packages/ src/ --config .dependency-cruiser.cjs`
- `lint:fix`: `eslint src/ --cache --fix && bun run --filter '*' lint -- --fix`
- `prepublishOnly`: `bun run build`
- `release`: `bun run build && bun publish --access public && bun run --filter '*' publish`
- `release:major`: `bun run --filter '*' version major && npm version major && bun run release`
- `release:minor`: `bun run --filter '*' version minor && npm version minor && bun run release`
- `release:patch`: `bun run --filter '*' version patch && npm version patch && bun run release`
- `start`: `bun src/index.ts`
- `test`: `bun run test:root && bun run test:isolated && bun test --config packages/slingshot-core/bunfig.toml packages/slingshot-core/tests && bun test --config packages/slingshot-permissions/bunfig.toml packages/slingshot-permissions/tests`
- `test:all`: `bun test tests/unit tests/integration && bun run test:docker:up && bun test --config bunfig.docker.toml --concurrency=1 tests/docker/ && bun test --config bunfig.e2e.toml tests/e2e/; bun run test:docker:down`
- `test:coverage`: `bun scripts/run-coverage.ts`
- `test:coverage:check`: `bun run test:coverage && bun scripts/check-coverage.ts`
- `test:coverage:full`: `bun run test:docker:up && bun test --coverage --config bunfig.ci.toml tests/unit tests/integration tests/docker; bun run test:docker:down`
- `test:docker`: `bun run test:docker:up && bun test --config bunfig.docker.toml --concurrency=1 tests/docker/`
- `test:docker:down`: `docker compose -f docker-compose.test.yml down`
- `test:docker:up`: `docker compose -f docker-compose.test.yml up -d --wait`
- `test:docs`: `bun test packages/docs/tests`
- `test:e2e`: `bun run test:docker:up && bun test --config bunfig.e2e.toml tests/e2e/; bun run test:docker:down`
- `test:e2e:ci`: `bun test --config bunfig.e2e.toml tests/e2e/`
- `test:e2e:mongo`: `TEST_BACKEND=mongo bun run test:e2e:ci`
- `test:e2e:postgres`: `TEST_BACKEND=postgres bun run test:e2e:ci`
- `test:e2e:sqlite`: `TEST_BACKEND=sqlite bun run test:e2e:ci`
- `test:isolated`: `bun test tests/isolated/config-lock.test.ts tests/isolated/memoryCache.test.ts tests/isolated/zodToMongoose.test.ts && bun test tests/isolated/optional-deps.test.ts && bun test tests/isolated/jwt-signing-singleton.test.ts && bun test tests/isolated/csrf-signing-singleton.test.ts && bun test tests/isolated/auth0Access.test.ts && bun test tests/isolated/queue.test.ts && bun test tests/isolated/jobs-router.test.ts && bun test tests/isolated/queued-deletion.test.ts && bun test tests/isolated/bullmq-adapter-durable.test.ts && bun test tests/isolated/passkey-e2e.test.ts && bun run test:docs`
- `test:node`: `vitest run --config vitest.config.ts`
- `test:root`: `bun scripts/run-root-tests.ts`
- `typecheck`: `node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.typecheck.json --pretty false`
- `typecheck:root`: `node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.root.typecheck.json --pretty false`
- `typecheck:tests`: `node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.tests.typecheck.json --pretty false`

## Dependencies

- `@asteasolutions/zod-to-openapi`: `^8.4.1`
- `@hono/zod-openapi`: `1.2.2`
- `@lastshotlabs/slingshot-auth`: `workspace:*`
- `@lastshotlabs/slingshot-core`: `workspace:*`
- `@lastshotlabs/slingshot-entity`: `workspace:*`
- `@lastshotlabs/slingshot-organizations`: `workspace:*`
- `@oclif/core`: `^4.10.2`
- `@opentelemetry/api`: `^1.9.1`
- `@scalar/hono-api-reference`: `0.10.0`

## Peer Dependencies

- `@aws-sdk/client-s3`: `>=3.0`
- `@aws-sdk/client-ssm`: `>=3.0`
- `@aws-sdk/lib-storage`: `>=3.0`
- `@aws-sdk/s3-request-presigner`: `>=3.0`
- `@lastshotlabs/slingshot-admin`: `workspace:*`
- `@lastshotlabs/slingshot-bullmq`: `workspace:*`
- `@lastshotlabs/slingshot-community`: `workspace:*`
- `@lastshotlabs/slingshot-deep-links`: `workspace:*`
- `@lastshotlabs/slingshot-interactions`: `workspace:*`
- `@lastshotlabs/slingshot-mail`: `workspace:*`
- `@lastshotlabs/slingshot-notifications`: `workspace:*`
- `@lastshotlabs/slingshot-permissions`: `workspace:*`
- `@lastshotlabs/slingshot-postgres`: `workspace:*`
- `@lastshotlabs/slingshot-push`: `workspace:*`
- `@lastshotlabs/slingshot-webhooks`: `workspace:*`
- `@simplewebauthn/server`: `>=10.0.0`
- `arctic`: `^3.7.0`
- `bullmq`: `>=5.0 <6`
- `hono`: `>=4.12.12 <5`
- `ioredis`: `>=5.0 <6`
- `jose`: `6.2.0`
- `mongoose`: `>=9.0 <10`
- `otpauth`: `>=9.0 <10`
- `samlify`: `^2.8`
- `zod`: `>=4.0 <5`

## Related Docs

- [API reference](/api/slingshot/)
