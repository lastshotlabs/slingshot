---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-entity
---

> Human-owned documentation. This page explains what this package is for and which constraints should stay true as it evolves.

## Purpose

`@lastshotlabs/slingshot-entity` is Slingshot's authoring and orchestration layer for config-driven data models. It turns the shared types from `slingshot-core` into real tools for declaring entities, generating artifacts, validating manifests, planning migrations, and assembling runtime plugins.

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
- Manifest and migration support should stay aligned with the same entity model rather than drifting into a second configuration universe.

## The Two Big Responsibilities

### DSL and generation

This package owns the ergonomic side of the platform:

- `defineEntity`
- `defineOperations`
- builders such as `field`, `index`, `relation`, and `op`
- code generation from those definitions

The goal is to make the declarative path easier than the hand-wired path.

### Runtime orchestration

`createEntityPlugin()` and the routing helpers are the runtime proof that the same definitions can drive live packages, not just generated code. This is what lets packages like community express behavior through entity config, middleware references, registry-backed route events, composed extra routes, and generated executor overrides instead of bespoke route files.

The stock CRUD list route is part of that contract. For entities mounted through
`createEntityPlugin()`, `GET /{entity}` accepts the same allowlisted list query params that the
generated route path exposes: indexed fields, enum fields, boolean fields, the tenant field, and
`limit` / `cursor` / `sortDir`. Runtime row scoping still wins over caller-supplied filters.

Entity runtime assembly now has a few explicit invariants:

- entity adapters are published during `setupRoutes`, not delayed until `setupPost`
- dependent route builders should use the published-adapter lookup helpers rather than closing over sibling adapters manually
- generated CRUD and named-operation routes keep framework-owned shells; overrides replace executors, not route shapes
- extra routes and generated routes share one planner, one collision check, and one specificity ordering model
- the manual router escape hatch still exists in plugin `setupRoutes`, but it should be for routes that do not fit the entity shell rather than a default workaround

## Relationship To Other Packages

- `slingshot-core` owns the canonical contracts and shared type families.
- `slingshot-entity` turns those contracts into authoring and orchestration tools.
- Feature packages such as community consume the tools and provide domain-specific adapters, middleware, and side effects.

## Review Heuristics

- If a change introduces framework-private assumptions into the authoring DSL, pause and recheck the boundary.
- If a new feature duplicates what manifests, migrations, or generation already know how to express, prefer extending the shared model instead.
- If runtime helpers start growing domain rules, those rules probably belong in the consuming package instead.

## Related Reading

- [Config-Driven Domain example](/examples/config-driven-domain/) - runnable entity -> operations -> plugin -> app composition in `examples/config-driven-domain/`
- [Config-Driven Workflow](/config-driven/workflow/) - recommended implementation order from entity through docs
- `docs/specs/completed/config-driven-packages.md`
- `docs/specs/completed/community-config-rewrite.md`
- `packages/slingshot-core/docs/human/index.md`
- `packages/slingshot-community/docs/human/index.md`
