---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-entity
---

> Human-owned documentation. This page explains what this package is for and which constraints should stay true as it evolves.

## Purpose

`@lastshotlabs/slingshot-entity` is Slingshot's authoring and orchestration layer for config-driven data models. It turns the shared types from `slingshot-core` into real tools for declaring entities, generating artifacts, planning migrations, and assembling runtime entity plugins behind the `definePackage(...)` package contract.

## Package Boundaries

This package should stay strongly aligned to three ideas:

- authoring DSLs
- pure generation
- runtime orchestration that is still driven by config

It should not become a dumping ground for framework internals or feature-specific business logic.

## Important Invariants

- `generate()` should remain pure: config in, source strings out.
- Entity authoring APIs should stay package-author friendly and should not require callers to understand framework-private implementation details.
- Runtime orchestration should compose core contracts instead of inventing competing abstractions.
- Migration support should stay aligned with the entity model rather than drifting into a second configuration universe.

## The Two Big Responsibilities

### DSL and generation

This package owns the ergonomic side of the platform:

- `defineEntity`
- `defineOperations`
- `entity(...)` for package-first runtime authoring
- builders such as `field`, `index`, `relation`, and `op`
- code generation from those definitions

The goal is to make the declarative path easier than the hand-wired path.

### Runtime orchestration

The canonical composition path is package-first: `definePackage(...)` in `slingshot-core` owns
composition, `entity({ config, operations })` exported from this package wraps an entity for use
inside a package, and `createApp({ packages: [...] })` mounts the result. Packages express their
entities, domain routes, named middleware, capabilities, and lifecycle through one declarative
input. Framework-side `compilePackages()` turns that input into the entity plugins and domain
routers that run at request time.

`createEntityPlugin()` and the routing helpers are the lower-level surface that `compilePackages()`
calls under the hood. They remain available as a compatibility and escape-hatch surface — apps
that need to wire entities outside `definePackage(...)` (for instance, tests or framework
internals) can still call it directly with `entities: [...]`.

The stock CRUD list route is part of that contract. For entities mounted through
`createEntityPlugin()`, `GET /{entity}` accepts the same allowlisted list query params that the
generated route path exposes: indexed fields, enum fields, boolean fields, the tenant field, and
`limit` / `cursor` / `sortDir`. Runtime row scoping still wins over caller-supplied filters.

Entity runtime assembly now has a few explicit invariants:

- entity adapters are published during `setupRoutes`, not delayed until `setupPost`
- dependent route builders should use the published-adapter lookup helpers rather than closing over sibling adapters manually
- generated CRUD and named-operation routes keep framework-owned shells; overrides replace executors, not route shapes
- extra routes and generated routes share one planner, one collision check, and one specificity ordering model
- extra routes and generated overrides can declare typed request schemas and OpenAPI response metadata
- the manual router escape hatch still exists in plugin `setupRoutes`, but it should be for routes that do not fit the entity shell rather than a default workaround

## Consumer Shape Hardening

Entity definitions support configurable system fields, storage field mapping, and storage
conventions so consumers are not locked into first-party naming assumptions.

### System Fields

`systemFields` on `EntityConfig` lets consumers rename audit and ownership fields:

```ts
defineEntity('Task', {
  fields: { ... },
  systemFields: {
    createdBy: 'author',
    updatedBy: 'lastEditor',
    ownerField: 'assignee',
    tenantField: 'workspace',
    version: 'rev',
  },
});
```

### Storage Field Mapping

`storageFields` on `EntityConfig` lets consumers rename backend-specific fields:

```ts
defineEntity('Task', {
  fields: { ... },
  storageFields: {
    mongoPkField: 'pk',       // default: '_id'
    ttlField: 'expiresAt',    // default: '_expires_at'
    mongoTtlField: 'expiry',  // default: '_expiresAt'
  },
});
```

### Storage Conventions

`conventions` on `EntityConfig` opens ID generation, on-update strategies, and Redis key
format beyond the built-in defaults:

```ts
defineEntity('Task', {
  fields: { ... },
  conventions: {
    redisKey: ({ appName, storageName, pk }) => `${appName}/${storageName}/${pk}`,
    autoDefault: (kind) => kind === 'ulid' ? generateUlid() : undefined,
    onUpdate: (kind) => kind === 'increment' ? computeNextVersion() : undefined,
  },
});
```

Built-in defaults: Redis key is `${storageName}:${appName}:${pk}`, auto-default handles
`'uuid'`/`'cuid'`/`'now'`, on-update handles `'now'`. Custom resolvers return `undefined`
to fall through to the built-in handler.

### Operation Registry

Policy and data-scope logic resolves operation semantics through a centralized registry
instead of scattered `CRUD_OPS` sets and switch statements. Built-in CRUD operations are
registered by default; named operations resolve through the same pipeline.

## Relationship To Other Packages

- `slingshot-core` owns the canonical contracts and shared type families.
- `slingshot-entity` turns those contracts into authoring and orchestration tools.
- Feature packages such as community consume the tools and provide domain-specific adapters, middleware, and side effects.

## Testing entry point

`runPackageLifecycle()` from `@lastshotlabs/slingshot-entity/testing` is the canonical way
to drive a `definePackage(...)` module in tests that bypass `createApp()` /
`compilePackages()`. It exposes the package's compiled entity plugin and publishes the
runtime state the package's capability resolvers depend on, so tests can exercise the same
boot sequence the framework runs at startup without spinning up a real HTTP host.

## Capability identity invariant

Cross-package consumers resolve published services through
`ctx.capabilities.require(Cap)`. Capability resolvers return the same long-lived value for
the lifetime of the package instance: a consumer reading the capability handle during
`setupMiddleware`, `setupRoutes`, `setupPost`, and again at request time observes `===`
identity. This lets consumers cache the handle reference safely and lets identity checks
(`===`, `WeakMap` keys, `instanceof`) hold across lifecycle phases without explicit
versioning. `publishPackageRuntimeState()` is invoked twice per package during bootstrap,
but the resolver's return value remains stable across both passes.

## Review Heuristics

- If a change introduces framework-private assumptions into the authoring DSL, pause and recheck the boundary.
- If a new feature duplicates what migrations or generation already know how to express, prefer extending the shared model instead.
- If runtime helpers start growing domain rules, those rules probably belong in the consuming package instead.

## Related Reading

- [Config-Driven Domain example](/examples/config-driven-domain/) - runnable entity -> operations -> plugin -> app composition in `examples/config-driven-domain/`
- [Config-Driven Workflow](/config-driven/workflow/) - recommended implementation order from entity through docs
- `docs/specs/completed/config-driven-packages.md`
- `docs/specs/completed/community-config-rewrite.md`
- `packages/slingshot-core/docs/human/index.md`
- `packages/slingshot-community/docs/human/index.md`
