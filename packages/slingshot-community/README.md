---
title: Human Guide
description: How to use @lastshotlabs/slingshot-community in a real Slingshot app
---

`@lastshotlabs/slingshot-community` adds a community/forum surface to a Slingshot app. Use it when you
want containers, threads, replies, reactions, moderation, bans, reports, and notification hooks
without building and wiring that whole domain yourself.

## Auth Bridge

Community requires a `communityPrincipal` on the request context. The built-in `authBridge`
config handles this automatically:

```typescript
createCommunityPackage({ authBridge: 'auto' });
```

When `authBridge` is `"auto"`, the package registers middleware that reads `actor.id` and
`roles` from the framework auth context and sets `communityPrincipal` for community routes.
This eliminates the most common handler file pattern. Use `"none"` (default) to wire the
bridge yourself.

**Example:**

```typescript
createCommunityPackage({ authBridge: 'auto', containerCreation: 'user' });
```

## When To Use It

Install this package when:

- your app needs a forum, discussion, or member-generated content surface
- you want the content model, route policy, and moderation behavior to come as one package
- you are already using Slingshot packages and want community to behave like a first-class domain

## What You Need Before Wiring It In

This package is not standalone. In practice, most apps need:

1. An auth story so requests have a user identity.
2. A `slingshot-permissions` package so shared permission state exists in `pluginState`.
3. A small middleware bridge that sets `communityPrincipal` on the request context from your auth identity (or `authBridge: 'auto'`).

## Minimum Setup Shape

```typescript title="app.config.ts"
import { defineApp } from '@lastshotlabs/slingshot';
import { createAuthPlugin } from '@lastshotlabs/slingshot-auth';
import { createCommunityPackage } from '@lastshotlabs/slingshot-community';
import { createNotificationsPackage } from '@lastshotlabs/slingshot-notifications';
import { createPermissionsPackage } from '@lastshotlabs/slingshot-permissions';

export default defineApp({
  plugins: [
    createAuthPlugin({
      auth: { roles: ['user', 'admin'], defaultRole: 'user' },
      db: { auth: 'memory', sessions: 'memory', oauthState: 'memory' },
    }),
  ],
  packages: [
    createNotificationsPackage(),
    createPermissionsPackage(),
    createCommunityPackage({ authBridge: 'auto', containerCreation: 'user' }),
  ],
});
```

## First Config Knobs To Know

- `authBridge`: `'auto'` wires auth context to community principal automatically; `'none'` (default) requires manual middleware
- `containerCreation`: choose `'user'` or `'admin'`
- `scoring`: choose the built-in ranking algorithm and weights
- `mountPath`: move the package off `/community` if needed
- `disableRoutes`: turn off specific generated route groups

## Gotchas

- Community expects `communityPrincipal` to exist for protected flows.
- Register `createPermissionsPackage()` before community so the shared permission state is available during setup.
- This package is intentionally config-driven. If you find yourself reintroducing lots of bespoke route logic around it, that is usually a sign you want a different abstraction boundary.
