# slingshot-m2m

Machine-to-machine OAuth2 client credentials plugin built on Slingshot auth primitives. It
adds M2M client models, scope checks, and token issuance routes.

## Key Files

| File                           | What                                                   |
| ------------------------------ | ------------------------------------------------------ |
| src/index.ts                   | Public API surface for plugin, routes, and M2M helpers |
| src/plugin.ts                  | `createM2MPlugin()` factory                            |
| src/routes/m2m.ts              | M2M route surface                                      |
| src/models/M2MClient.ts        | M2M client model                                       |
| src/middleware/requireScope.ts | Scope enforcement middleware                           |
| src/lib/m2m.ts                 | Shared M2M token helpers                               |
| docs/human/index.md            | Package guide synced into the docs site                |

## Connections

- **Imports from**: `packages/slingshot-auth/src/index.ts` and `packages/slingshot-core/src/index.ts`
- **Imported by**: direct application use

## Common Tasks

- **Changing token or scope behavior**: update `src/lib/m2m.ts` and `src/middleware/requireScope.ts`
- **Changing route behavior**: update `src/routes/m2m.ts`, then update `docs/human/index.md`
- **Updating docs**: search `packages/docs/src/content/docs/` for M2M references when behavior changes
