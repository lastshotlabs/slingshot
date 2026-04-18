---
title: AI Draft
description: AI-assisted summary for @lastshotlabs/slingshot-entity
---

> AI-assisted draft. This page is the quick map for the entity package and its role in the config-driven platform.

## Summary

`@lastshotlabs/slingshot-entity` is the entity-definition and code-generation package for Slingshot. It gives package authors a DSL for declaring entities and operations, plus the tooling that turns those declarations into types, schemas, adapters, routes, migrations, manifests, and plugin-level runtime wiring.

This package lives between core contracts and real feature packages. Core owns the shared types. Entity turns those types into authoring tools and runtime orchestration. Feature packages such as community consume the DSL and plugin builder.

## Main Capabilities

- `defineEntity()` and field builders for entity definitions
- `defineOperations()` and `op.*()` builders for declarative operations
- `generate()` for pure source generation
- manifest validation and resolution for JSON-driven entity definitions
- migration diffing and snapshot support
- `createEntityPlugin()` for runtime orchestration of config-driven entity packages

## Two Modes

The package has both developer-time and runtime responsibilities.

### Developer-time

- declare entities
- declare operations
- generate source output
- validate manifests
- plan migrations

### Runtime

- build bare entity routes
- apply route config
- assemble config-driven entity plugins
- wire cascades and channel forwarding

## Why This Package Matters

This is the main bridge between Slingshot's config-driven vision and real package authoring. If a plugin can be expressed cleanly with this package, Slingshot gets closer to a world where routes, policies, and side effects are declared instead of hand-wired.

## Reading Order

1. `src/defineEntity.ts`
2. `src/defineOperations.ts`
3. `src/generate.ts`
4. `src/createEntityPlugin.ts`
5. `src/manifest/`
6. `src/migrations/`

## Good Follow-Ups

- Use the human guide for the non-negotiable invariants around purity and framework boundaries.
- Pair this package with `slingshot-core` docs to understand where contracts end and tooling begins.
- Look at `slingshot-community` for the main production consumer pattern.
