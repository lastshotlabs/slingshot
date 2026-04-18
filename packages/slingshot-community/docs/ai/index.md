---
title: AI Draft
description: AI-assisted summary for @lastshotlabs/slingshot-community
---

> AI-assisted draft. This page is the fast explanation of how the package works after the config-driven rewrite.

## Summary

`@lastshotlabs/slingshot-community` is a full community/forum plugin built on the config-driven entity platform. It models containers, threads, replies, reactions, moderation, bans, reports, memberships, rules, and notifications as entity definitions plus operations, then uses `createEntityPlugin()` to mount the whole package.

This package is important because it is both a product package and a proof point. It demonstrates that a real plugin with permissions, middleware, cascades, search, event wiring, notification side effects, and moderation workflows can run without hand-written route files.

## Core Shape

- `src/entities/` defines the nine entities and their operations.
- `src/plugin.ts` is a thin orchestration layer around `createEntityPlugin()`.
- `src/middleware/` holds the custom domain logic that config alone cannot express.
- `src/lib/mentions.ts` and `setupPost()` handle side effects that consume emitted events.
- `src/types/` holds config, hook, and model types exposed to consumers.

## Why It Depends On Auth

The plugin declares `slingshot-auth` as a dependency because community behavior assumes authenticated identities for membership, moderation, notifications, and real user-scoped actions. It also relies on auth-related contracts exposed through core for permission and identity resolution.

## Design Pattern

The key split is:

- config handles route wiring, auth, permissions, events, cascades, and channel declarations
- middleware handles package-specific decision logic
- `setupPost()` handles event consumers and notification side effects

That split keeps the plugin mostly declarative without pretending every rule can be reduced to config.

## What Makes This Package Non-Trivial

- nine entities with different access patterns
- moderation and ban checks
- grant management
- reaction and notification workflows
- mention parsing and event-driven follow-up behavior
- search and realtime hooks layered on top of entity definitions

## Reading Order

1. `src/plugin.ts`
2. `src/entities/`
3. `src/middleware/`
4. `docs/specs/completed/community-config-rewrite.md`

## Good Follow-Ups

- Use the human guide for the package invariants and the "what belongs in config vs code" rules.
- Use the generated docs for the public exports.
- Pair this package with `slingshot-entity` docs when making structural changes.
