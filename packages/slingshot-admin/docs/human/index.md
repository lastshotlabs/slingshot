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

## Manifest Auto-Wiring

In manifest mode, the admin plugin supports string strategies that wire providers automatically
from other plugins:

- **`accessProvider: "slingshot-auth"`** — verifies admin access by reading `actor.id` and
  `roles` from the framework auth context. Only users with the `super-admin` role are
  granted admin access. Adds `slingshot-auth` as a plugin dependency.

- **`managedUserProvider: "slingshot-auth"`** — delegates user CRUD operations (list, get,
  delete, suspend) to the auth adapter. Maps `UserRecord` to `ManagedUserRecord` at the
  boundary. Adds `slingshot-auth` as a plugin dependency.

- **`permissions: "slingshot-permissions"`** — reads evaluator, registry, and adapter from the
  permissions plugin state. All permission operations are forwarded to the real
  implementations after binding. Adds `slingshot-permissions` as a plugin dependency.

- **`auditLog: "memory"`** — uses an in-memory audit log for development. Entries are lost
  on process restart.

These strategies are resolved during manifest config processing. The admin plugin receives
fully-constructed provider objects — it never sees the string values.

**Example manifest:**

```json
{
  "plugins": [
    { "plugin": "slingshot-auth", "config": { ... } },
    { "plugin": "slingshot-permissions" },
    {
      "plugin": "slingshot-admin",
      "config": {
        "accessProvider": "slingshot-auth",
        "managedUserProvider": "slingshot-auth",
        "permissions": "slingshot-permissions",
        "auditLog": "memory"
      }
    }
  ]
}
```

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
