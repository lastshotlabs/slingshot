# slingshot-admin

Thin admin plugin that wires `AdminAccessProvider` and `ManagedUserProvider` contracts into
Slingshot. It has no storage adapter of its own; another package supplies the backing providers.

## Key Files

| File                         | What                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| src/index.ts                 | Public API surface for the admin plugin and provider helpers |
| src/plugin.ts                | `createAdminPlugin()` factory                                |
| src/types/config.ts          | Admin plugin config schema and exported config types         |
| src/providers/auth0Access.ts | Built-in Auth0-backed admin access provider                  |
| src/lib/resourceTypes.ts     | Admin resource registration helpers                          |
| docs/human/index.md          | Package guide synced into the docs site                      |

## Connections

- **Imports from**: `packages/slingshot-core/src/plugin.ts` and related core contracts
- **Imported by**: manifest bootstrap via `../../src/lib/builtinPlugins.ts`; no workspace package imports it directly

## Common Tasks

- **Adding a new provider**: add a file under `src/providers/`, export it from `src/index.ts`, and document the contract in `docs/human/index.md`
- **Changing config options**: update `src/types/config.ts`, then search `packages/docs/src/content/docs/` for admin references
- **Testing**: `packages/slingshot-admin/tests/`
