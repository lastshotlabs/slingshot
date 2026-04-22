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

### Event governance

Core now owns the registry-backed event contract:

- `defineEvent(...)` for canonical ownership, exposure, payload, and scope
- `createEventDefinitionRegistry(...)` for app-instance event definitions
- `createEventPublisher(...)` / `ctx.events.publish(...)` for canonical envelope creation
- `EventEnvelope` as the cross-transport unit for SSE, webhooks, BullMQ, and Kafka

If a package needs externally visible events, the definition belongs in core-owned contracts and the
publish path should go through `ctx.events`, not raw `bus.emit(...)` plus sidecar allowlists.

### Config-driven platform

Core owns the types for entity definitions, operations, route configs, and channel configs. Those types are consumed by `@lastshotlabs/slingshot-entity`, by runtime route wiring, and by real feature packages such as community.

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
