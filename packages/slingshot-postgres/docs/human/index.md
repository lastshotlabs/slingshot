---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-postgres
---

`@lastshotlabs/slingshot-postgres` is the Postgres-backed auth adapter and connection helper for
Slingshot. It provides `connectPostgres()` for pool setup and `createPostgresAdapter()` for the
full `AuthAdapter` implementation used by `slingshot-auth`.

## What It Provides

- `connectPostgres(url, opts?)` — opens a `pg.Pool`, verifies connectivity with `SELECT 1` at
  startup, and returns a `DrizzlePostgresDb` handle `{ pool, db, healthCheck, getStats }`
- `createPostgresAdapter({ pool })` — returns a fully-initialised `AuthAdapter` that implements
  all auth tiers: users, OAuth accounts, MFA, WebAuthn, recovery codes, roles, tenant roles,
  groups, group memberships, suspension, and SCIM-style user listing
- Auto-migration — schema migrations run automatically inside a `pg_advisory_xact_lock`-protected
  transaction on the first `createPostgresAdapter` call; safe for concurrent cluster startup

## Minimum Setup

```ts
import { connectPostgres, createPostgresAdapter } from '@lastshotlabs/slingshot-postgres';

const { pool, db } = await connectPostgres(process.env.DATABASE_URL!);
const authAdapter = await createPostgresAdapter({ pool });
```

Pass `pool` to permission/push/webhook adapters. Pass `authAdapter` to the auth plugin config.

## Migration Modes

`connectPostgres()` accepts a `migrations` option forwarded to the Postgres pool runtime:

- `undefined` (default) — run pending migrations automatically on first `createPostgresAdapter` call
- `'assume-ready'` — skip migration runner entirely; use when your deployment pipeline manages schema changes

```ts
const { pool } = await connectPostgres(process.env.DATABASE_URL!, {
  migrations: 'assume-ready',
});
```

## Pool Configuration

All `PostgresPoolConfig` fields are optional and map to `pg.Pool` constructor options:

| Field                          | `pg.Pool` field               |
| ------------------------------ | ----------------------------- |
| `max`                          | `max`                         |
| `min`                          | `min`                         |
| `idleTimeoutMs`                | `idleTimeoutMillis`           |
| `connectionTimeoutMs`          | `connectionTimeoutMillis`     |
| `queryTimeoutMs`               | `query_timeout`               |
| `statementTimeoutMs`           | `statement_timeout`           |
| `maxUses`                      | `maxUses`                     |
| `allowExitOnIdle`              | `allowExitOnIdle`             |
| `keepAlive`                    | `keepAlive`                   |
| `keepAliveInitialDelayMillis`  | `keepAliveInitialDelayMillis` |

## Migration Schema

Migrations are tracked in `_slingshot_auth_schema_version` and protected by
`pg_advisory_xact_lock(7283, 4829)` to serialise concurrent restarts. Each migration runs
inside the same transaction as the version bump, so a mid-migration crash leaves the schema
unchanged and the migration is retried on next startup.

Current migration history:
- **v1** — `slingshot_users`, `slingshot_oauth_accounts`, `slingshot_user_roles`, `slingshot_tenant_roles`
- **v2** — MFA columns on users, `slingshot_recovery_codes`, `slingshot_webauthn_credentials`, `slingshot_groups`, `slingshot_group_memberships`

Never edit or reorder existing migrations. Append new ones to the `MIGRATIONS` array in `src/adapter.ts`.

## Operational Notes

- `connectPostgres()` fails fast: if the Postgres server is unreachable or credentials are
  wrong, it throws during startup before the app serves any requests. The pool is closed before
  the error is re-thrown to avoid connection leaks.
- `createPostgresAdapter` uses `Bun.password.verify()` for password verification. This means the
  adapter currently requires a Bun runtime for password checks; pure-Node apps need a shim or
  a different adapter.
- `listUsers()` caps results at 200 per page regardless of the `count` parameter.
- Pagination in `listGroups()` and `getGroupMembers()` uses a `(createdAt, id)` keyset cursor
  for stable ordering under concurrent inserts. Cursors are opaque base64-encoded JSON.
- Group name uniqueness is enforced by partial unique indexes: app-wide groups (no `tenantId`)
  use one index; tenant-scoped groups use another. This allows the same name in different tenants.
- Unique-constraint violations (`pg` error code `23505`) are converted to `HttpError(409)`
  with typed error codes (`PROVIDER_EMAIL_CONFLICT`, `GROUP_NAME_CONFLICT`, `GROUP_MEMBER_CONFLICT`).

## Gotchas

- `connectPostgres()` accepts only `postgresql://` connection strings, not object-style configs.
- `pool` and `db` share the same underlying `pg.Pool`. Close the pool (via `pool.end()`) to
  release all connections on shutdown — closing only `db` is not sufficient.
- The `DrizzlePostgresDb.db` is a plain Drizzle client with no schema inference. Use it for
  simple queries; type-safe schema queries require importing and passing the schema explicitly.
- Do not call `createPostgresAdapter` multiple times with the same pool if `migrations:
  'assume-ready'` is not set — the migration runner serialises concurrent callers via the
  advisory lock, but repeated calls from the same process are wasteful.

## Key Files

- `src/connection.ts` — `connectPostgres()`, `DrizzlePostgresDb`, pool config
- `src/adapter.ts` — `createPostgresAdapter()`, migrations, all `AuthAdapter` tier implementations
- `src/schema.ts` — Drizzle table definitions
- `src/testing.ts` — test utilities (`/testing` subpath export)
