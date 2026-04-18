# slingshot-postgres

Postgres adapter package for Slingshot auth plus a shared connection helper. This package is
the workspace bridge between abstract auth contracts and real Postgres-backed persistence.

## Key Files

| File                | What                                                   |
| ------------------- | ------------------------------------------------------ |
| src/index.ts        | Public API surface for adapter and connection helper   |
| src/adapter.ts      | `createPostgresAdapter()` implementation               |
| src/connection.ts   | `connectPostgres()` helper and Drizzle bundle contract |
| src/schema.ts       | Postgres schema definitions used by the adapter        |
| src/testing.ts      | Test utilities exported on the testing subpath         |
| docs/human/index.md | Package guide synced into the docs site                |

## Connections

- **Imports from**: `packages/slingshot-core/src/auth-adapter.ts`
- **Imported by**: `packages/slingshot-auth/src/bootstrap.ts` and framework infrastructure in `../../src/framework/createInfrastructure.ts`

## Common Tasks

- **Changing adapter behavior**: update `src/adapter.ts`, then confirm the schema in `src/schema.ts` still matches
- **Changing connection bootstrap**: update `src/connection.ts`, then search `packages/docs/src/content/docs/` for Postgres setup examples
- **Testing**: `packages/slingshot-postgres/tests/`
