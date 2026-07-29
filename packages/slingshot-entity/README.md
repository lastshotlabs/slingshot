# @lastshotlabs/slingshot-entity

Install with Bun:

```sh
bun add @lastshotlabs/slingshot-entity
```

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

### Backend Capability Contract

Standard entity factories validate the resolved entity and operation requirements before
accessing backend infrastructure. `ENTITY_BACKEND_PROFILES`, `getEntityBackendProfile()`,
and `UnsupportedEntityBackendError` expose the same immutable support contract used by
startup. Unsupported semantics fail deterministically instead of silently degrading.

Redis does not support secondary or compound uniqueness in standard wiring. Memory, MongoDB,
and Redis do not currently support rollback for `op.transaction`; SQLite and Postgres do.
Custom operations require a factory for the selected backend. Use manual adapter wiring when
the application supplies operation methods itself.

SQLite composite transactions and package-service `transactions.run('sqlite', ...)` scopes share
one per-app FIFO coordinator. The coordinator holds `BEGIN IMMEDIATE` for the scope and gates every
unscoped standard entity method, including lazy table initialization and named operations, until
the scope commits or rolls back. Same-store nested scopes reuse the active scope; unrelated work
waits outside the transaction instead of joining the shared connection implicitly.

Primary-key creation is insert-only across standard adapters. In particular, MongoDB uses a
strict insert and Redis uses `SET ... NX`, so create never overwrites an existing record.

### Optimistic Concurrency

`concurrency: { strategy: 'version' }` injects an immutable version field into the resolved
entity. Adapters own authoritative comparison and increment behavior: creates start at 1,
successful updates and soft deletes increment once, and hard deletes compare without leaking
tenant-scoped existence. Memory, SQLite, PostgreSQL, and MongoDB claim these atomic guarantees;
Redis rejects the entity before connection or key creation.

Runtime and generated CRUD routes share the canonical strong ETag codec. They compute tags from
the raw entity before DTO projection, require or optionally accept `If-Match` according to
`requiredOnWrite`, and map malformed, missing, wrong-identity, stale, and absent records to the
documented 400/428/412/412/404 statuses. Migration snapshots remain format version 1; SQL
add-column migrations use `NOT NULL DEFAULT 1`, while MongoDB backfills only missing fields.

SQLite and PostgreSQL bootstrap reconcile framework-managed positional indexes against their
configured uniqueness and ordered field sets. Changing an index definition therefore rebuilds
the stale database index instead of letting `CREATE INDEX IF NOT EXISTS` preserve an obsolete
constraint. PostgreSQL runtime CRUD also quotes generated column identifiers, including field
names that collide with SQL keywords such as `order`.

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

Backend authors and framework contributors can run the same capability-selected behavior
catalog through `runEntityConformance()`. The `/testing` entry point exports isolated memory,
temporary-file SQLite, live PostgreSQL, live MongoDB, and live Redis drivers:

The generated [entity backend support matrix](https://slingshot.lastshotlabs.com/reference/entity-backend-support/) is sourced from
the same immutable profiles. Memory is intended for development and tests; it is neither durable
nor rollback-capable for composite transactions.

```ts
import {
  createMongoEntityConformanceDriver,
  createPostgresEntityConformanceDriver,
  createRedisEntityConformanceDriver,
  runEntityConformance,
} from '@lastshotlabs/slingshot-entity/testing';

const postgresResults = await runEntityConformance(
  createPostgresEntityConformanceDriver(process.env.TEST_POSTGRES_URL),
);
const mongoResults = await runEntityConformance(
  createMongoEntityConformanceDriver(process.env.TEST_MONGO_URL),
);
const redisResults = await runEntityConformance(
  createRedisEntityConformanceDriver(process.env.TEST_REDIS_URL),
);
```

The shared catalog contains no store-specific branches or handwritten skips. A driver's
immutable `EntityBackendProfile` is the sole selection source, and every result is a frozen,
serializable pass, skip, or sanitized failure record. The PostgreSQL driver creates a unique
quoted schema per harness; the MongoDB driver creates a unique database per harness. Cleanup
drops only the schema or database owned by that harness. The Redis driver creates a random,
validated application prefix and deletes only exact fixture-key prefixes under that namespace.

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

- [Config-Driven Domain example](https://slingshot.lastshotlabs.com/examples/config-driven-domain/) - runnable entity -> operations -> plugin -> app composition in `examples/config-driven-domain/`
- [Config-Driven Workflow](https://slingshot.lastshotlabs.com/config-driven/workflow/) - recommended implementation order from entity through docs
- `docs/specs/completed/config-driven-packages.md`
- `docs/specs/completed/community-config-rewrite.md`
- `packages/slingshot-core/docs/human/index.md`
- `packages/slingshot-community/docs/human/index.md`
