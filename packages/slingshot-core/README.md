---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-core
---

> Human-owned documentation. This page describes what core is allowed to own and what should stay out of it.

## Purpose

`@lastshotlabs/slingshot-core` is the canonical contract layer for Slingshot. Its job is to let the framework root, generators, runtimes, and feature packages coordinate without importing each other in circles.

Core is where shared shapes become stable:

- lifecycle contracts
- boundary interfaces
- entity and route config types
- runtime abstractions
- context and registrar state
- low-level helpers that are framework-safe and package-safe

## Architectural Role

Core sits below the framework root and below the feature plugins.

- The framework root owns boot, assembly, route mounting, and concrete runtime wiring.
- Core defines the shapes those steps consume and publish.
- Feature packages depend on core so they can integrate through interfaces instead of hard dependencies on sibling plugins.

This package is intentionally broad in surface area but narrow in behavior. It should expose contracts freely, but concrete domain logic belongs elsewhere.

## What Belongs In Core

- Type contracts shared by more than one package.
- Registry and context helpers that support cross-package discovery.
- Package-first authoring contracts such as `definePackage(...)`, `defineCapability(...)`, `domain(...)`, and typed route metadata.
- Framework-agnostic defaults such as in-process event transport and memory adapters.
- Config schemas and type families that multiple packages must agree on.
- Runtime interfaces that abstract Bun-specific or Node-specific capabilities.

## What Does Not Belong In Core

- Feature-specific business logic.
- Route mounting for a single domain package.
- Direct dependencies from one plugin to another.
- Large concrete services that only one package needs.
- Framework boot orchestration that belongs in `@lastshotlabs/slingshot`.

## Key Invariants

- Plugins should be able to share contracts through core without importing each other directly.
- Core should stay usable from both the framework root and package workspaces.
- Public contracts in core are the source of truth for cross-package integration. Duplicated local versions should be treated as drift.
- New helpers in core should remain infrastructure-light. If they require concrete runtime assembly, they likely belong in the framework root instead.

## Important Seams

### Plugin lifecycle

`src/plugin.ts` is the backbone of package integration. The three main lifecycle phases are:

- `setupMiddleware` for early request middleware
- `setupRoutes` for mounted routes, route-aware plugin behavior, and any plugin-owned state that becomes canonical at route-assembly time
- `setupPost` for event subscriptions, registrar writes, WebSocket draft mutation, and other post-assembly work

That ordering is a contract. Packages should treat it as stable.

One important exception to the old "pluginState is setupPost-owned" shorthand now exists on purpose:
entity adapters are published during `setupRoutes` via the framework-owned merge contract so
dependent plugins can discover them while composing routes. Treat that as a documented lifecycle
state fix, not as a reason to move arbitrary mutable state earlier.

### Registrar and context

`src/coreRegistrar.ts` and `src/context/` are the handoff points where plugins publish capabilities for the rest of the app to use. This is how auth, permissions, mail templates, route auth, and similar concerns become discoverable without hard package edges.

`src/pluginState.ts` owns the other discovery seam: plugin-owned runtime state. If a package publishes
state here, it must stay mergeable, frozen at publication boundaries, and keyed by the plugin that
owns it. Cross-plugin reads should go through the helper APIs instead of reaching into ad hoc shapes.

Package-first authoring builds on the same seam. Capabilities are declared in core, published by the
owning package during bootstrap finalization, and consumed through typed handles instead of mutable
adapter bags or module-global registries.

### Actor-first identity

Core owns the canonical identity model for all framework consumers:

- `Actor` — frozen identity shape with `id`, `kind`, `tenantId`, `sessionId`, `roles`, and `claims`.
  Five kinds: `'user'`, `'service-account'`, `'api-key'`, `'system'`, `'anonymous'`.
- `ANONYMOUS_ACTOR` — frozen singleton for unauthenticated requests.
- `getActor(c)` — reads `c.get('actor')`, falls back to `ANONYMOUS_ACTOR`. Never returns `null`.
- `getActorId(c)` — shorthand for the actor's primary ID, `null` when anonymous.
- `getActorTenantId(c)` — actor-scoped tenant, `null` when tenantless.
- `getRequestTenantId(c)` — request-scoped tenant from tenant-resolution middleware (distinct from
  actor tenant — they usually match but diverge for cross-tenant operations).

Guards, permissions, data scoping, audit, entity routes, and transport helpers all read identity
through the actor shape. Auth middleware (`identify`) publishes the frozen actor on the Hono context;
downstream consumers read it via the helpers above.

`RequestActorResolver` (registered via `CoreRegistrar.setRequestActorResolver()`) resolves the
canonical `Actor` from a raw HTTP request — used by WS/SSE upgrade paths where full middleware
hasn't run. Unauthenticated requests resolve to `ANONYMOUS_ACTOR`, never `null`.

### Event governance

Core now owns the registry-backed event contract:

- `defineEvent(...)` for canonical ownership, exposure, payload, and scope
- `createEventDefinitionRegistry(...)` for app-instance event definitions
- `createEventPublisher(...)` / `ctx.events.publish(...)` for canonical envelope creation
- `EventEnvelope` as the cross-transport unit for SSE, webhooks, BullMQ, and Kafka

If a package needs externally visible events, the definition belongs in core-owned contracts and the
publish path should go through `ctx.events`, not raw `bus.emit(...)` plus sidecar allowlists.

### Unified metrics emitter

Core owns the thin `MetricsEmitter` contract that prod-track packages call to record
counters, gauges, and timings without coupling to a specific backend. The emitter is
exposed as `ctx.metricsEmitter` and defaults to `createNoopMetricsEmitter()` when the
host application has not configured one — plugins can call it unconditionally.

This is a separate seam from the framework-owned `/metrics` endpoint registry. Use
`MetricsEmitter` for ad-hoc plugin signals (`search.query.duration`, etc.); use the
metrics plugin for HTTP request-level scrape data.

To wire a custom backend, attach an emitter that adapts your client of choice. A
minimal Prometheus example using `prom-client`:

```ts
import { Counter, Gauge, Histogram } from 'prom-client';
import type { MetricsEmitter } from '@lastshotlabs/slingshot-core';

const counters = new Map<string, Counter<string>>();
const gauges = new Map<string, Gauge<string>>();
const histograms = new Map<string, Histogram<string>>();

export const promEmitter: MetricsEmitter = {
  counter(name, value = 1, labels = {}) {
    const c =
      counters.get(name) ?? new Counter({ name, help: name, labelNames: Object.keys(labels) });
    counters.set(name, c);
    c.inc(labels, value);
  },
  gauge(name, value, labels = {}) {
    const g = gauges.get(name) ?? new Gauge({ name, help: name, labelNames: Object.keys(labels) });
    gauges.set(name, g);
    g.set(labels, value);
  },
  timing(name, ms, labels = {}) {
    const h =
      histograms.get(name) ?? new Histogram({ name, help: name, labelNames: Object.keys(labels) });
    histograms.set(name, h);
    h.observe(labels, ms / 1000);
  },
};

// Pass through `metrics.emitter` in your app config:
// createApp({ metrics: { emitter: promEmitter } })
```

### Config-driven platform

Core owns the types for entity definitions, operations, route configs, and channel configs. Those types are consumed by `@lastshotlabs/slingshot-entity`, by runtime route wiring, and by real feature packages such as community.

### Consumer shape hardening

Core now owns configurable entity field mapping and storage convention types:

- `EntitySystemFields` / `ResolvedEntitySystemFields` — consumer-configurable names for audit,
  ownership, tenant, and version fields. Defaults match first-party conventions.
- `EntityStorageFieldMap` / `ResolvedEntityStorageFieldMap` — consumer-configurable Mongo PK
  field and SQL TTL column names.
- `EntityStorageConventions` / `ResolvedEntityStorageConventions` — consumer-configurable Redis
  key format (default: `${storageName}:${appName}:${pk}`), custom auto-default resolvers
  (beyond `uuid`/`cuid`/`now`), and custom on-update resolvers (beyond `now`).
- `CustomAutoDefaultResolver` / `CustomOnUpdateResolver` — function type aliases for the
  convention hooks. Return `undefined` to fall through to the built-in handler.

These types are declared in `src/entityConfig.ts` and resolved at `defineEntity()` time. All
adapters consume the resolved shapes — consumers never need to fork an adapter to change field
names or ID generation strategy.

## Practical Advice

- When a feature package needs a shared interface, add it here before reaching across package boundaries.
- When reviewing core changes, look for accidental framework behavior creeping into contract files.
- When a type is exported from several packages, prefer moving the canonical definition into core and re-exporting from consumers.

## Related Reading

- [Config-Driven Domain example](/examples/config-driven-domain/) - core contracts expressed through entity and plugin assembly in `examples/config-driven-domain/`
- [Collaboration Workspace example](/examples/collaboration-workspace/) - cross-package composition across auth, permissions, community, chat, and media in `examples/collaboration-workspace/`
- [Content Platform example](/examples/content-platform/) - runtime, assets, search, and SSR composition in `examples/content-platform/`
- `docs/specs/completed/config-driven-packages.md`
- `docs/specs/completed/ws-config-driven-channels.md`
- `packages/slingshot-entity/docs/human/index.md`
- `packages/slingshot-auth/docs/human/index.md`
