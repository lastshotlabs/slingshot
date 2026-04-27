# slingshot-assets

Entity-backed asset storage plugin with storage adapter resolution, upload metadata, and
manifest-aware runtime wiring for asset routes.
Asset entities follow the shared package-first/entity model; `createAssetsPlugin()` is the runtime
shell that composes those entities into the live plugin.

## Key Files

| File                    | What                                                      |
| ----------------------- | --------------------------------------------------------- |
| src/index.ts            | Public API surface for plugin, adapters, and asset types  |
| src/plugin.ts           | `createAssetsPlugin()` factory                            |
| src/config.schema.ts    | Assets plugin config schema                               |
| src/adapters/index.ts   | Manifest-compatible storage adapter resolution            |
| src/manifest/runtime.ts | Manifest-time adapter resolution and runtime helpers      |
| src/types.ts            | Shared asset records, adapter contracts, and config types |
| docs/human/index.md     | Package guide synced into the docs site                   |

## Connections

- **Imports from**: `packages/slingshot-core/src/storeInfra.ts`, `packages/slingshot-entity/src/configDriven/index.ts`, and `packages/slingshot-permissions/src/index.ts`
- **Imported by**: manifest bootstrap via `../../src/lib/builtinPlugins.ts` and app-level plugin composition

## Common Tasks

- **Adding a storage adapter**: add the adapter file under `src/adapters/`, wire it through `src/adapters/index.ts`, and update `src/manifest/runtime.ts` if manifest refs change
- **Changing config options**: update `src/config.schema.ts`, then update `docs/human/index.md`
- **Testing**: `packages/slingshot-assets/tests/`
