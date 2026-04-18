---
title: AI Draft
description: AI-assisted summary for @lastshotlabs/slingshot-core
---

> AI-assisted draft. This page is a fast orientation layer for the package. Keep the human docs authoritative when the two disagree.

## Summary

`@lastshotlabs/slingshot-core` is the contract package for the Slingshot ecosystem. It does not try to boot the app or own a concrete plugin. Instead it defines the interfaces, shared types, registries, and default in-memory helpers that the framework root and the feature packages all depend on.

If a capability needs to be shared across packages without creating plugin-to-plugin coupling, it usually belongs here. Good examples already in the package are the plugin lifecycle contract, event bus types, auth and admin boundary contracts, entity config and operation types, permission types, and runtime abstractions.

## What Lives Here

- Shared plugin contracts such as `SlingshotPlugin`, `StandalonePlugin`, and the three-phase lifecycle hooks.
- Registry and context surfaces such as `createCoreRegistrar()`, `attachContext()`, and the `SlingshotContext` type family.
- Cross-package contracts for auth, permissions, admin, mail, cache, rate limiting, uploads, queues, and secrets.
- Config-driven platform types including `EntityConfig`, `EntityRouteConfig`, `EntityChannelConfig`, and operation config types.
- Small framework-safe defaults such as in-process event transport and memory adapters for cache and rate limiting.

## When To Depend On Core

Depend on `slingshot-core` when your package needs a stable contract that multiple packages can share.

- A plugin package should import public contracts from core instead of reaching into the framework root.
- A package that needs auth or admin integration should depend on the boundary interfaces here rather than importing another plugin directly.
- Packages that define entities or config-driven routes should use the entity, operation, route, and channel types from core.

## How It Fits With Neighboring Packages

- `@lastshotlabs/slingshot` assembles the app, boot sequence, and concrete framework behavior.
- `@lastshotlabs/slingshot-core` supplies the stable shapes those runtime pieces speak.
- `@lastshotlabs/slingshot-entity` builds DSLs, generators, and plugin orchestration on top of core contracts.
- Feature packages like auth, community, mail, and permissions consume core contracts and publish their own plugin factories.

## Reading Order

If you are new to this package, read in this order:

1. `src/plugin.ts` for the lifecycle model.
2. `src/context/` and `src/coreRegistrar.ts` for runtime state and dependency handoff.
3. `src/eventBus.ts`, `src/permissions.ts`, and `src/auth-adapter.ts` for the major shared contracts.
4. `src/entityConfig.ts`, `src/entityRouteConfig.ts`, and `src/entityChannelConfig.ts` for the config-driven platform model.

## Good Follow-Ups

- Pair this page with the human guide for the invariants that should stay true as the package grows.
- Use the generated package docs for the exact public export list.
- Read `/api/slingshot-core/` when you need names and signatures instead of architecture.
