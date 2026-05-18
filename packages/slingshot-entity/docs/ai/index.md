---
title: AI Draft
description: AI-assisted summary for @lastshotlabs/slingshot-entity
---

> AI-assisted draft. This page is the quick map for the entity package and its role in the Slingshot platform.

## Summary

`@lastshotlabs/slingshot-entity` is the entity-definition and code-generation package for Slingshot. It gives package authors a DSL for declaring entities and operations, plus the tooling that turns those declarations into types, schemas, adapters, routes, and migrations. It also publishes `definePackage`-aware runtime factories so feature packages can author entities directly inside their `createXxxPackage()` factory.

This package lives between core contracts and real feature packages. Core owns the shared types. Entity turns those types into authoring tools and runtime wiring. Feature packages such as community consume the DSL and the package-authoring helpers.

## Main Capabilities

- `defineEntity()` and field builders for entity definitions
- `defineOperations()` and `op.*()` builders for declarative operations
- `entity()` and `definePackage()` runtime composition (re-exported from core)
- `generate()` for pure source generation
- migration diffing and snapshot support
- `createEntityPlugin()` — lower-level escape hatch invoked internally by `compilePackages()`
- `runPackageLifecycle()` and `createLazyMiddleware()` test/runtime helpers

## Two Modes

The package has both developer-time and runtime responsibilities.

### Developer-time

- declare entities
- declare operations
- generate source output
- plan migrations

### Runtime

- build bare entity routes
- apply route config
- assemble entity-aware package lifecycles via `compilePackages()`
- wire cascades and channel forwarding

## Why This Package Matters

This is the main bridge between Slingshot's `definePackage(...)` authoring story and real feature packages. If a feature can be expressed cleanly with this package, Slingshot gets closer to a world where routes, policies, and side effects are declared once and reused.

## Reading Order

1. `src/defineEntity.ts`
2. `src/defineOperations.ts`
3. `src/generate.ts`
4. `src/createEntityPlugin.ts`
5. `src/packageAuthoring.ts`
6. `src/migrations/`

## Good Follow-Ups

- Use the human guide for the non-negotiable invariants around purity and framework boundaries.
- Pair this package with `slingshot-core` docs to understand where contracts end and tooling begins.
- Look at `slingshot-community` for the main production consumer pattern.
