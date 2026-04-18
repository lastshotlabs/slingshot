---
title: AI Draft
description: AI-assisted summary for @lastshotlabs/slingshot-admin
---

> AI-assisted draft. Use this page as the fast orientation layer, then harden important guarantees in the human guide.

## Summary

`@lastshotlabs/slingshot-admin` mounts admin-facing routes for user management, permissions, and
optional mail-preview flows. It is intentionally thin: the package does not own storage,
authentication, or policy persistence on its own.

The plugin exists to turn already-resolved providers into a guarded admin surface. In most Slingshot
apps, the root helper `createSlingshotAdminPlugin()` is the friendlier entrypoint because it can
derive auth-backed providers and pull permissions from shared plugin state during `setupPost`.

## What This Package Owns

- route mounting under `/admin` by default
- one shared access guard for admin, permissions, and optional mail routes
- provider validation at plugin construction time
- package-local testing helpers for in-memory admin providers

## Common Flows

- use `createAdminPlugin()` directly when you already have an `AdminAccessProvider`,
  `ManagedUserProvider`, and permissions state
- use the root helper when Slingshot auth and permissions are already part of the app and you want
  the package wiring handled for you
- add `mailRenderer` only when you want the admin package to expose mail-preview routes

## Important Caveat

This package is an adapter layer, not a control plane. If admin behavior feels "missing", the
missing piece is usually in the access provider, managed user provider, or permissions registry
rather than in the route layer itself.
