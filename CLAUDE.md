# Slingshot

Backend framework for config-driven full-stack apps. Hono-based, plugin-driven, TypeScript-first.

- **Core** - `@lastshotlabs/slingshot-core`: app context, event bus, persistence resolution, plugin lifecycle
- **Entity** - `@lastshotlabs/slingshot-entity`: config-driven entity CRUD, code generation, search, transitions
- **Auth** - `@lastshotlabs/slingshot-auth`: auth providers, sessions, MFA, OAuth, WebAuthn, passkeys
- **Community** - `@lastshotlabs/slingshot-community`: messaging, channels, reactions, notifications
- **CLI** - `slingshot init`, `slingshot migrate generate|apply|status|dev`, `slingshot deploy`

## Capability Map

- **Core path** - `slingshot-core`, `slingshot-entity`
- **Prod path** - `slingshot-permissions`, `slingshot-organizations`, `slingshot-orchestration`, `slingshot-orchestration-bullmq`, `slingshot-orchestration-temporal`, `slingshot-orchestration-plugin`, `slingshot-bullmq`, `slingshot-assets`, `slingshot-search`, `slingshot-webhooks`, `slingshot-kafka`, `slingshot-admin`, `slingshot-mail`, `slingshot-notifications`, `slingshot-push`, `slingshot-ssr`, `slingshot-ssg`, `slingshot-runtime-bun`, `slingshot-runtime-node`, `slingshot-runtime-edge`, `slingshot-postgres`
- **Experimental** - `slingshot-auth`, `slingshot-oauth`, `slingshot-oidc`, `slingshot-scim`, `slingshot-m2m`
- **Deferred** - `slingshot-community`, `slingshot-chat`, `slingshot-polls`, `slingshot-image`, `slingshot-emoji`, `slingshot-embeds`, `slingshot-gifs`, `slingshot-deep-links`, `slingshot-interactions`, `slingshot-game-engine`, `slingshot-infra`

## Canonical Authoring Path

Apps declare their config in a typed `app.config.ts` at the project root using
`defineApp({ ... })`. The CLI (`slingshot start`) discovers this file, dynamically
imports its default export, and hands it to `createServer()`.

```ts
// app.config.ts
import { defineApp } from '@lastshotlabs/slingshot';
import { createAuthPlugin } from '@lastshotlabs/slingshot-auth';

export default defineApp({
  meta: { name: 'my-app', version: '1.0.0' },
  routesDir: import.meta.dir + '/routes',
  plugins: [createAuthPlugin({ ... })],
});
```

`createApp()` and `createServer()` remain the lower-level imperative API for tests,
tooling, and apps that need dynamic composition. `defineApp()` is a typed identity
helper over `CreateServerConfig` that gives users autocomplete without manually
annotating the config.

## Package Hierarchy

    slingshot-core  (plugin contract, context, event bus, shared entity and operation types)
      |-- slingshot-entity       (entity definitions, generators, config-driven runtime factories)
      |-- slingshot-auth         (auth providers, sessions, MFA, OAuth, WebAuthn, passkeys)
      |-- slingshot-permissions  (RBAC, grants, evaluators, adapter factories)
      |-- slingshot-postgres     (Postgres auth adapter and connection helper)
      |-- slingshot-bullmq       (durable BullMQ-backed event bus adapter)
      `-- feature plugins
          |-- slingshot-community      slingshot-chat           slingshot-notifications
          |-- slingshot-search         slingshot-ssr            slingshot-ssg
          |-- slingshot-assets         slingshot-push           slingshot-polls
          |-- slingshot-webhooks       slingshot-interactions   slingshot-organizations
          |-- slingshot-admin          slingshot-mail           slingshot-deep-links
          |-- slingshot-image          slingshot-embeds         slingshot-gifs
          `-- slingshot-emoji          slingshot-m2m            slingshot-oauth / slingshot-oidc / slingshot-scim

Runtime packages: `packages/runtime-bun/`, `packages/runtime-node/`, `packages/runtime-edge/`

Documentation package: `packages/docs/` (Astro site, workspace sync, API generation)

## Key Files

| Area              | File                                                  | What                                                                     |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| App bootstrap     | `src/app.ts`                                          | `createApp()` flow, framework middleware, plugin lifecycle orchestration |
| Server bootstrap  | `src/server.ts`                                       | `createServer()` wrapper around runtime and app assembly                 |
| Plugin contract   | `packages/slingshot-core/src/plugin.ts`               | `SlingshotPlugin`, `PluginSetupContext`, lifecycle hooks                 |
| Context state     | `packages/slingshot-core/src/context/index.ts`        | `SlingshotContext`, `getContext()`, instance-scoped state                |
| Entity types      | `packages/slingshot-core/src/entityConfig.ts`         | Shared field and entity config types                                     |
| Event bus         | `packages/slingshot-core/src/eventBus.ts`             | Bus interface, in-process adapter, client-safe event rules               |
| Entity plugin     | `packages/slingshot-entity/src/createEntityPlugin.ts` | Root entity plugin factory                                               |
| Code generation   | `packages/slingshot-entity/src/generate.ts`           | Pure entity code generation entry point                                  |
| App config helper | `src/defineApp.ts`                                    | `defineApp()` typed identity helper for `app.config.ts`                  |
| CLI entry         | `src/cli/commands/start.ts`                           | `slingshot start` — discovers `app.config.ts` and boots                  |

## Bootstrap Flow

1. `validateAppConfig()` validates the root config before assembly.
2. `createCoreRegistrar()` and `validateAndSortPlugins()` prepare plugin registration order.
3. `resolveSecretBundle()` resolves framework secrets from the configured provider.
4. `createInfrastructure()` wires databases, caches, queues, and framework adapters.
5. `buildContext()` creates the instance-scoped Slingshot context attached to the app.
6. `registerBoundaryAdapters()` connects shared adapters into the registrar snapshot.
7. `runPluginMiddleware()` mounts plugin middleware in dependency order.
8. `preloadModelSchemas()` loads shared Zod schemas before route registration.
9. `runPluginRoutes()`, `mountRoutes()`, and `mountOpenApiDocs()` register HTTP surfaces.
10. `runPluginPost()` finalizes post-route hooks, then `finalizeContext()` freezes the context.

## Full Contributor Guide

The complete contributor guide with engineering rules, documentation policy, specs process,
and detailed agent context strategy lives in the companion `slingshot-docs/` directory.

## Test Commands

- `bun run test`: default non-Docker suite. Runs root tests, isolated root tests, and package-local tests that do not require external services.
- `bun run test:docker`: Docker-backed integration suite. Runs `tests/docker/` plus package-local live Postgres integrations that need the Docker PostgreSQL instance.
- `bun run test:e2e`: end-to-end suite with Docker dependencies.
- `bun run test:all`: full verification pass. Runs `test`, then `test:docker`, then `test:e2e`.

Do not assume `test:all` is a different test universe. It should be a composition of the real entrypoints above.
