---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-search
---

> Human-owned documentation. This package owns search runtime behavior, not entity definition itself.

## Purpose

`@lastshotlabs/slingshot-search` turns entity-level search configuration into a live search runtime.
It mounts search routes, initializes providers, discovers searchable entities from the framework's
entity registry, and keeps indexes in sync through post-setup event subscriptions.

## Design Constraints

- Entity configuration is the source of truth. The package should discover entities with `search`
  config rather than requiring every searchable entity to be re-declared in plugin config.
- Provider setup and route mounting belong in this package; entity authoring does not. Keep the
  boundary between `slingshot-entity` and `slingshot-search` explicit.
- The plugin publishes runtime access through `pluginState` after initialization. Cross-package
  consumers should use that runtime surface instead of reaching into search internals.

## Manifest Strategies

The search plugin supports built-in strategy strings in manifest mode:

- **`tenantResolution: "framework"`** — reads tenant ID from the Hono context variable
  `tenantId` (set by framework tenancy middleware). Equivalent to
  `tenantResolver: c => c.get('tenantId')`. Requires `tenantField` to also be set.

- **`adminGate: "superAdmin"`** — allows access to admin routes only for users with the
  `super-admin` role.

- **`adminGate: "authenticated"`** — allows access to admin routes for any authenticated
  user (checks the request actor is not anonymous).

These strategies are resolved before the plugin factory runs, so the plugin itself never
sees the string values.

## Operational Notes

- `adminGate` is optional. Admin routes are only mounted when it is present.
- If startup warns that the entity registry contains no searchable entities, the problem is usually
  missing entity config rather than provider failure.
- Transform functions must be registered when the plugin is created. They are copied into the
  plugin's internal registry before discovery and indexing begin.
- Search sync is now registry-backed. When `syncMode: "event-bus"` is enabled, the plugin relies on
  canonical event definitions and `ctx.events.publish(...)` envelopes rather than legacy
  `clientSafeEvents` registration or raw bus payload assumptions.

## Gotchas

- `setupMiddleware()` is intentionally almost empty today. That is not dead code; it preserves room
  for future request-level search concerns without overloading route or post-setup phases.
- `setupPost()` initializes indexes and wires event-sync subscriptions after entity discovery. If
  this phase is skipped in a custom integration, the routes may mount but the search runtime will
  not be complete.
- `mountPath` must start with `/`; trailing slashes are trimmed before route mounting.
- The package can target external providers or the DB-native provider. Docs should be careful not
  to imply one deployment shape when the plugin is designed to support several.

## Key Files

- `src/plugin.ts`
- `src/searchManager.ts`
- `src/eventSync.ts`
- `src/types/config.ts`
- `src/testing.ts`

## Source-Backed Examples

- [Content Platform example](/examples/content-platform/) - search composed with assets, SSR, and edge runtime in `examples/content-platform/`
