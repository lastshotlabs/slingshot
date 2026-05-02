---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-admin
---

> Human-owned documentation. This package should stay small and explicit about what it delegates.

## Purpose

`@lastshotlabs/slingshot-admin` provides the admin HTTP surface for Slingshot. It is the package that
turns admin access checks, managed-user operations, permissions state, and optional mail rendering
into mounted routes.

The package does not own user storage, session storage, grant persistence, or identity policy. It
depends on providers for all of that and should remain a thin route-and-guard assembly layer.

## Design Constraints

- `createAdminPlugin()` must remain provider-driven. It should not quietly reach into unrelated
  packages to discover auth or permissions implementations.
- The root-level `createSlingshotAdminPlugin()` is the place where Slingshot-specific convenience
  wiring happens. That wrapper intentionally defers route registration to `setupPost` so it can
  read permissions from shared plugin state after other plugins have published it.
- Admin route protection should stay centralized at the mount path. Today the package uses a single
  guard across admin, permissions, and mail routes so sub-routers cannot drift into inconsistent
  auth behavior.

## Wiring providers

The admin plugin is a thin wrapper that coordinates provider objects you supply. Build the
providers in `app.config.ts` and pass them to `createAdminPlugin()`:

```typescript title="app.config.ts"
// @skip-typecheck
import { defineApp } from '@lastshotlabs/slingshot';
import { createAuthPlugin } from '@lastshotlabs/slingshot-auth';
import { createPermissionsPlugin } from '@lastshotlabs/slingshot-permissions';
import { createAdminPlugin } from '@lastshotlabs/slingshot-admin';
import {
  createSlingshotAuthAccessProvider,
  createSlingshotAuthManagedUserProvider,
  createMemoryAuditLog,
} from '@lastshotlabs/slingshot-admin/providers';

export default defineApp({
  plugins: [
    createAuthPlugin({
      auth: { roles: ['user', 'super-admin'], defaultRole: 'user' },
      db: { auth: 'memory', sessions: 'memory', oauthState: 'memory' },
    }),
    createPermissionsPlugin(),
    createAdminPlugin({
      accessProvider: createSlingshotAuthAccessProvider(),
      managedUserProvider: createSlingshotAuthManagedUserProvider(),
      auditLog: createMemoryAuditLog(),
      // permissions can be omitted — the plugin will read it from
      // slingshot-permissions plugin state at runtime.
    }),
  ],
});
```

`accessProvider` only grants admin access to users with the `super-admin` role. `auditLog`
is an in-memory development implementation — entries are lost on process restart.

## Operational Notes

- If admin boots without permissions, check whether you are using `createAdminPlugin()` directly or
  the Slingshot root wrapper. Direct usage requires an explicit `permissions` object.
- If the Slingshot root wrapper throws about missing `PERMISSIONS_STATE_KEY`, another plugin was
  expected to publish permissions state and did not. That is a wiring problem, not an admin-router
  problem.
- `mailRenderer` is optional. When it is absent, mail preview routes should not be mounted.
- Mail routes require `read` permission on `admin:mail`. The mount-path auth guard alone is not
  sufficient for template enumeration or preview.

## Gotchas

- The admin package exports `./testing` helpers because the route layer is easiest to test with
  in-memory access and managed-user providers.
- This package can look "too small" on first read. That is intentional. If business logic starts
  piling up here, it probably belongs in the backing providers or in a different package.
- `mountPath` must start with `/`; trailing slashes are trimmed before routes are mounted.
- Mount path defaults to `/admin`, but the mounted permissions sub-router lives under
  `${mountPath}/permissions`, so proxy and routing assumptions should be documented carefully in
  consumer apps.

## Key Files

- `src/plugin.ts`
- `src/routes/admin.ts`
- `src/routes/permissions.ts`
- `src/testing.ts`
