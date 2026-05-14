# Slingshot

Backend framework for config-driven full-stack apps. Hono-based, plugin-driven, TypeScript-first.

- **Core** - `@lastshotlabs/slingshot-core`: app context, event bus, persistence resolution, plugin lifecycle
- **Entity** - `@lastshotlabs/slingshot-entity`: config-driven entity CRUD, code generation, search, transitions
- **Auth** - `@lastshotlabs/slingshot-auth`: auth providers, sessions, MFA, OAuth, WebAuthn, passkeys
- **Community** - `@lastshotlabs/slingshot-community`: messaging, channels, reactions, notifications
- **Packages** - 15 in-tree `definePackage(...)`-authored modules consumed via `createApp({ packages: [createXxxPackage(...)] })`
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
import { createNotificationsPackage } from '@lastshotlabs/slingshot-notifications';

export default defineApp({
  meta: { name: 'my-app', version: '1.0.0' },
  routesDir: import.meta.dir + '/routes',
  plugins: [createAuthPlugin({ ... })],
  packages: [createNotificationsPackage({ ... })],
});
```

Apps mix two tiers. The `plugins:` array holds framework-level `SlingshotPlugin`
factories (auth, oauth, mail, image, etc.) that integrate directly with the runtime
via the plugin contract. The `packages:` array holds feature modules authored with
`definePackage(...)` and consumed through `createXxxPackage(...)` factories — these
get an entity-aware lifecycle (entity hooks interleaved with package hooks) and
exchange data through typed package contracts and capability handles. When
`config.permissions` is set, the framework auto-prepends `createPermissionsPackage(...)`
to `packages:` so RBAC is available to every other package without explicit wiring.

`createApp()` and `createServer()` remain the lower-level imperative API for tests,
tooling, and apps that need dynamic composition. `defineApp()` is a typed identity
helper over `CreateServerConfig` that gives users autocomplete without manually
annotating the config.

## Package Hierarchy

Shared base layer:

    slingshot-core   (plugin contract, definePackage/definePackageContract, capability handles,
                      context, event bus, shared entity and operation types)
      `-- slingshot-entity   (entity definitions, generators, config-driven runtime factories,
                              compilePackages entry point, runPackageLifecycle test helper)

Packages — 15 `definePackage(...)`-authored modules consumed through `packages:`:

      |-- slingshot-emoji              slingshot-search             slingshot-orchestration-plugin
      |-- slingshot-interactions       slingshot-notifications      slingshot-polls
      |-- slingshot-push               slingshot-organizations      slingshot-assets
      |-- slingshot-permissions        slingshot-ssr                slingshot-community
      `-- slingshot-webhooks           slingshot-chat               slingshot-game-engine

Plugins — 11 plugin-tier `SlingshotPlugin` factories consumed through `plugins:`:

      |-- slingshot-auth      slingshot-oauth     slingshot-oidc     slingshot-scim
      |-- slingshot-admin     slingshot-m2m       slingshot-mail     slingshot-image
      `-- slingshot-deep-links  slingshot-embeds  slingshot-gifs

Adapters and runtime backends (not authored as packages or plugins themselves):
`slingshot-postgres`, `slingshot-bullmq`, `slingshot-kafka`, `slingshot-orchestration`,
`slingshot-orchestration-bullmq`, `slingshot-orchestration-temporal`, `slingshot-ssg`.

Runtime packages: `packages/runtime-bun/`, `packages/runtime-node/`, `packages/runtime-edge/`

Documentation package: `packages/docs/` (Astro site, workspace sync, API generation)

## Key Files

| Area               | File                                                       | What                                                                                                  |
| ------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| App bootstrap      | `src/app.ts`                                               | `createApp()` flow, framework middleware, plugin lifecycle orchestration                              |
| Server bootstrap   | `src/server.ts`                                            | `createServer()` wrapper around runtime and app assembly                                              |
| Plugin contract    | `packages/slingshot-core/src/plugin.ts`                    | `SlingshotPlugin`, `PluginSetupContext`, lifecycle hooks                                              |
| Package contract   | `packages/slingshot-core/src/packageAuthoring.ts`          | `definePackage()`, `definePackageContract()`, `SlingshotPackageDefinition`                            |
| Package compiler   | `src/framework/packageAuthoring.ts`                        | `compilePackages()`, `publishPackageRuntimeState()`, entity↔package lifecycle interleave              |
| Context state     | `packages/slingshot-core/src/context/index.ts`             | `SlingshotContext`, `getContext()`, instance-scoped state                                             |
| Entity types       | `packages/slingshot-core/src/entityConfig.ts`              | Shared field and entity config types                                                                  |
| Event bus          | `packages/slingshot-core/src/eventBus.ts`                  | Bus interface, in-process adapter, client-safe event rules                                            |
| Entity plugin      | `packages/slingshot-entity/src/createEntityPlugin.ts`      | Root entity plugin factory — lower-level escape hatch that `compilePackages()` invokes internally     |
| Code generation    | `packages/slingshot-entity/src/generate.ts`                | Pure entity code generation entry point                                                               |
| App config helper  | `src/defineApp.ts`                                         | `defineApp()` typed identity helper for `app.config.ts`                                               |
| CLI entry          | `src/cli/commands/start.ts`                                | `slingshot start` — discovers `app.config.ts` and boots                                               |

## Bootstrap Flow

1. `validateAppConfig()` validates the root config before assembly.
2. `compilePackages([...])` wraps each `SlingshotPackageDefinition` in a compiled
   `SlingshotPlugin` that interleaves the entity-plugin lifecycle hooks with the
   package's own hooks. The compiled plugins are then merged into the same
   `plugins:` list as plain plugin-tier factories for the remaining steps.
3. `createCoreRegistrar()` and `validateAndSortPlugins()` prepare plugin registration order.
4. `resolveSecretBundle()` resolves framework secrets, `createInfrastructure()` wires
   databases/caches/queues/framework adapters, `buildContext()` creates the
   instance-scoped Slingshot context, and `registerBoundaryAdapters()` connects
   shared adapters into the registrar snapshot.
5. For each entry (compiled-package plugin or plain plugin), in dependency order,
   run `setupMiddleware`. For compiled packages this internally does
   `entityPlugin.setupMiddleware → publishPackageRuntimeState → pkg.setupMiddleware`.
   For plain plugins it just calls `setupMiddleware`.
6. `preloadModelSchemas()` loads shared Zod schemas before route registration.
7. `runPluginRoutes()` runs `entityPlugin.setupRoutes → pkg.setupRoutes → mountRoutes`
   for compiled packages; plain plugins just call `setupRoutes`.
8. `mountRoutes()` and `mountOpenApiDocs()` finalize HTTP surfaces.
9. `runPluginPost()` runs `entityPlugin.setupPost → publishPackageRuntimeState (second pass)
   → pkg.setupPost` for compiled packages; plain plugins just call `setupPost`.
10. `runPluginSeed()` — only when `CreateAppConfig.seed: {…}` was provided — calls each
    plugin's/package's `seed()` hook in dependency order. Each consumer reads its slice
    of `seedInput` and writes cross-plugin references (e.g. created user IDs) into the
    shared `seedState` map. Must be idempotent.
11. `finalizeContext()` freezes the context.

`publishPackageRuntimeState()` is invoked twice per package (after middleware and
again before post-hooks). Capability resolvers registered via
`provideCapability(Cap, () => view)` return the same long-lived value for the
lifetime of the package instance, so consumers reading
`ctx.capabilities.require(Cap)` at different lifecycle phases observe `===`
identity stability.

## Full Contributor Guide

The complete contributor guide with engineering rules, documentation policy, specs process,
and detailed agent context strategy lives in the companion `slingshot-docs/` directory.

## Test Commands

- `bun run test`: default non-Docker suite. Runs root tests, isolated root tests, and package-local tests that do not require external services.
- `bun run test:docker`: Docker-backed integration suite. Runs `tests/docker/` plus package-local live Postgres integrations that need the Docker PostgreSQL instance.
- `bun run test:e2e`: end-to-end suite with Docker dependencies.
- `bun run test:all`: full verification pass. Runs `test`, then `test:docker`, then `test:e2e`.

Do not assume `test:all` is a different test universe. It should be a composition of the real entrypoints above.
