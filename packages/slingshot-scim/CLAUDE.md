# slingshot-scim

SCIM 2.0 provisioning plugin layered on Slingshot auth. It exposes provisioning routes, auth
guards, and SCIM-specific model mapping helpers.

## Key Files

| File                       | What                                                    |
| -------------------------- | ------------------------------------------------------- |
| src/index.ts               | Public API surface for plugin, SCIM router, and helpers |
| src/plugin.ts              | `createScimPlugin()` factory                            |
| src/routes/scim.ts         | SCIM route surface                                      |
| src/middleware/scimAuth.ts | SCIM auth middleware                                    |
| src/lib/scim.ts            | SCIM filter parsing and user mapping helpers            |
| docs/human/index.md        | Package guide synced into the docs site                 |

## Connections

- **Imports from**: `packages/slingshot-auth/src/index.ts` and `packages/slingshot-core/src/index.ts`
- **Imported by**: manifest bootstrap via `../../src/lib/builtinPlugins.ts` and direct application use

## Common Tasks

- **Changing SCIM behavior**: update `src/routes/scim.ts` and `src/lib/scim.ts` together
- **Changing auth behavior**: update `src/middleware/scimAuth.ts`, then update `docs/human/index.md`
- **Updating docs**: search `packages/docs/src/content/docs/` for SCIM references when behavior changes
