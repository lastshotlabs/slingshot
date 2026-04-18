---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-interactions
---

`@lastshotlabs/slingshot-interactions` provides the dispatch layer for interactive components such as
buttons, menus, and action payloads emitted from chat or community surfaces. It compiles declarative
handler templates, stores interaction events, and exposes one dispatch endpoint for component
actions.

## When To Use It

Use this package when your app needs:

- a single backend route for dispatching interactive component actions
- audited interaction events stored as entities
- declarative routing of actions to webhooks, routes, or queues
- optional integration with Slingshot chat and community packages

Do not use it as a generic job queue. This package is specifically for user-triggered interaction
dispatch.

## What You Need Before Wiring It In

`createInteractionsPlugin()` depends on:

- `slingshot-auth`
- `slingshot-permissions`

The plugin throws during setup if shared permissions state is missing.

## Minimum Setup

Defaults are:

- `mountPath: '/interactions'`
- `rateLimit.windowMs: 60_000`
- `rateLimit.max: 20`
- `handlers: {}`

The main required work is defining `handlers`, which map action prefixes to compiled dispatch
targets.

## What You Get

The plugin mounts:

- `POST {mountPath}/dispatch`
- entity-backed read routes for `interactionEvents`

It also:

- compiles declarative handler templates once at plugin construction time
- publishes plugin state under `INTERACTIONS_PLUGIN_STATE_KEY`
- registers client-safe bus events for `interactions:event.dispatched` and
  `interactions:event.failed`
- probes chat and community peers when present so interactions can integrate cleanly with those
  packages

## Common Customization

The main knobs are:

- `mountPath`
- `rateLimit`
- `handlers`, keyed by action prefix

If you need to extend the system, start in:

- `src/config/schema.ts` for config shape and defaults
- `src/handlers/` for template compilation and dispatcher behavior
- `src/routes/dispatchRoute.ts` for the public dispatch endpoint
- `src/peers/` for chat and community integration points

## Gotchas

- The longest matching handler prefix wins. Action naming conventions matter because routing is
  prefix-based, not exact-match only.
- The plugin owns an interaction-event entity surface in addition to the dispatch route. If you
  remove that entity layer, you also remove auditability.
- Chat and community integrations are optional probes, not hard dependencies. Your handlers should
  still behave sensibly when those peers are absent.
- Runtime handler registration overlays the compiled config. Treat that as an extension path, not a
  substitute for keeping manifest config accurate.

## Key Files

- `src/index.ts`
- `src/plugin.ts`
- `src/config/schema.ts`
- `src/components/schema.ts`
- `src/handlers/compile.ts`
- `src/routes/dispatchRoute.ts`
- `src/entities/interactionEvent.ts`
