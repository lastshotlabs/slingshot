---
title: Human Guide
description: How to use @lastshotlabs/slingshot-infra for platform and deployment configuration
---

`@lastshotlabs/slingshot-infra` is the package for describing and operating infrastructure around
Slingshot apps. Use it when you want typed config for stacks, shared resources, deployment plans, and
environment-specific infrastructure behavior.

## When To Use It

Reach for this package when:

- you want `slingshot.platform.ts` and `slingshot.infra.ts` instead of ad hoc deployment metadata
- you have multiple services or environments and want the infrastructure shape captured in code
- you want to compute deploy plans, scaffold infra files, or inspect which shared resources an app uses

You probably do not need this package to boot a local app. This is deployment and platform tooling,
not runtime request handling.

## The Two Files It Centers Around

Most usage comes down to two files:

### `slingshot.platform.ts`

Shared platform definition for the repo or environment family.

This is where you define:

- org and cloud provider
- region
- shared resources
- stages such as `dev` and `prod`
- stack presets such as ECS or EC2+Nginx

### `slingshot.infra.ts`

App-level or service-level infrastructure declaration.

This is where you define:

- which stacks the app deploys to
- container size and scaling
- health check behavior
- which shared resources the app consumes
- service splits for multi-service apps

## Minimal Platform File

```typescript
import { definePlatform } from '@lastshotlabs/slingshot-infra';

export default definePlatform({
  org: 'acme',
  provider: 'aws',
  region: 'us-east-1',
  registry: {
    provider: 'local',
    path: '.slingshot/registry.json',
  },
  stages: {
    dev: {
      env: { NODE_ENV: 'development' },
    },
    prod: {
      env: { NODE_ENV: 'production' },
    },
  },
  stacks: {
    main: { preset: 'ecs' },
  },
  defaults: {
    preset: 'ecs',
    scaling: { min: 1, max: 3, cpu: 256, memory: 512 },
    logging: { driver: 'cloudwatch', retentionDays: 30 },
  },
});
```

## Minimal App Infra File

```typescript
import { defineInfra, deriveUsesFromAppConfig } from '@lastshotlabs/slingshot-infra';

const appConfig: Record<string, unknown> = {
  db: { provider: 'postgres' },
  jobs: {},
};

export default defineInfra({
  stacks: ['main'],
  port: 3000,
  size: 'small',
  uses: deriveUsesFromAppConfig(appConfig),
  healthCheck: '/health',
});
```

That `deriveUsesFromAppConfig()` helper is useful when you want infra declarations to stay aligned
with the app config instead of hand-maintaining the `uses` list.

## Common Workflows

### 1. Define infra in code

Use `definePlatform()` and `defineInfra()` for typed config with validation and frozen outputs.

### 2. Load config files

Use `loadPlatformConfig()` and `loadInfraConfig()` when a CLI or deployment tool needs to discover
`slingshot.platform.ts` and `slingshot.infra.ts`.

### 3. Plan deploys

Use `computeDeployPlan()` and `formatDeployPlan()` when you want to show what will happen before a
deploy actually runs.

### 4. Run deploys and rollbacks

Use `runDeployPipeline()` and `runRollback()` when you are wiring an operational flow around Slingshot
infra config.

### 5. Start from scaffolds

Use `generatePlatformTemplate()` and `generateInfraTemplate()` when you want to create starter files
instead of hand-writing them from scratch.

## Multi-Service Shape

If one app becomes multiple deployable units, `defineInfra()` supports `services` instead of only a
single top-level service.

That is the right time to move from:

- one service with `stacks`, `port`, and `uses`

to:

- `api`, `ws`, `jobs`, or other named services with separate stack and scaling settings

## What This Package Is Not

This package does not add routes, middleware, auth, or app runtime behavior.

It exists to answer questions like:

- what resources does this app consume?
- which stack should this service deploy to?
- what is the scaling and health-check shape for this stage?
- how do we compute and execute a deploy plan consistently?

## Gotchas

- `loadPlatformConfig()` looks for `slingshot.platform.ts` upward from the starting directory unless `SLINGSHOT_PLATFORM` is set.
- `loadInfraConfig()` looks for `slingshot.infra.ts` in the target directory.
- TypeScript infra config files require Bun runtime when loaded directly.
- If you only need a single small app locally, this package can be overkill on day one. It starts paying off when shared resources, multiple services, or deployment automation become real concerns.

## Key Files

- `packages/slingshot-infra/src/index.ts`
- `packages/slingshot-infra/src/config/platformSchema.ts`
- `packages/slingshot-infra/src/config/infraSchema.ts`
- `packages/slingshot-infra/src/config/deriveUsesFromApp.ts`
- `packages/slingshot-infra/src/deploy/pipeline.ts`
- `packages/slingshot-infra/src/scaffold/`
