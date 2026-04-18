---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-notifications
---

`@lastshotlabs/slingshot-notifications` is Slingshot's shared notification package. It owns
notification records, user notification preferences, dispatcher scheduling, rate limiting,
preference resolution, and the builder/runtime surface that other packages use to enqueue or
deliver notifications.

## When To Use It

Use this package when your app or plugin needs:

- persisted notification records
- user notification preferences and quiet-hours-aware resolution
- queued notification dispatch with a polling loop
- SSE delivery for the current user
- a common notification builder that feature packages can share

This is the right dependency for chat, community, push, and other product packages that need a
shared notification backbone instead of private per-feature notification tables.

## What You Need Before Wiring It In

The plugin declares `slingshot-auth` as a dependency. It expects the auth layer to be present before
notification routes and user-scoped SSE behavior are used.

The config is intentionally easy to start with. `createNotificationsPlugin()` accepts a partial
config object and fills in defaults.

## Minimum Setup

With no config, the plugin already gives you:

- route mount path `/notifications`
- SSE endpoint `/notifications/sse`
- dispatcher enabled
- dispatcher interval `30000`
- dispatcher max-per-tick `500`
- memory-backed rate limiting
- default channel preferences of push, email, and in-app all enabled

The main knobs are:

- `mountPath`
- `sseEnabled`
- `ssePath`
- `dispatcher`
- `rateLimit`
- `defaultPreferences`

## What You Get

The package provides:

- notification and notification-preference entities
- adapters resolved for the active store backend
- a notification builder surface created from plugin state
- a dispatcher that can poll and deliver queued notifications
- SSE routing for user-scoped notification streams
- a registration point for delivery adapters

At runtime, the plugin publishes state under `NOTIFICATIONS_PLUGIN_STATE_KEY`. That state includes:

- notification and preference adapters
- the dispatcher
- `createBuilder()`
- `registerDeliveryAdapter()`

Other feature packages should use that published state instead of reaching through notification internals.

## Common Customization

The first files to read are:

- `src/plugin.ts` for lifecycle and runtime state
- `src/types/config.ts` for defaults and configuration
- `src/builder.ts` for builder behavior
- `src/dispatcher.ts` for queue draining and delivery
- `src/preferences.ts` for quiet hours and effective preference resolution

The highest-value changes are usually:

- dispatcher cadence and throughput
- default preference behavior
- rate-limit backend and thresholds
- delivery adapter registration

## Gotchas

- Disabling the dispatcher does not remove notification persistence. It only stops the automatic
  polling loop that drains queued notifications.
- Delivery adapters are opt-in. Persisted notifications exist without them, but external delivery
  will not happen until another package registers an adapter.
- The plugin state is only complete after setup has resolved the entity adapters. If those adapters
  are missing, the plugin throws during setup instead of continuing in a half-wired state.
- SSE can be disabled independently from storage and dispatch. Treat it as a delivery surface, not
  the whole notification system.

## Key Files

- `src/index.ts`
- `src/plugin.ts`
- `src/types/config.ts`
- `src/builder.ts`
- `src/dispatcher.ts`
- `src/preferences.ts`
- `src/sse.ts`
