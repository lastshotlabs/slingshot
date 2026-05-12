# slingshot-assets

Entity-backed asset storage **package** with pluggable storage adapters
(S3 / local FS / memory), presigned upload + download flows, on-the-fly image
transforms with an LRU cache, and a delete-cascade middleware that cleans up
the backing object on entity delete. Authored via `definePackage(...)` and
consumed through `createApp({ packages: [createAssetsPackage(...)] })`.
Cross-package consumers resolve the runtime via `AssetsRuntimeCap`, the
aggregated health snapshot via `AssetsHealthCap`, and the orphan-recovery
list via `AssetsOrphanedKeysCap`.

## Key Files

| File                       | What                                                                              |
| -------------------------- | --------------------------------------------------------------------------------- |
| src/index.ts               | Public API surface for package, adapters, and asset types                         |
| src/plugin.ts              | `createAssetsPackage()` factory (`SlingshotPackageDefinition`)                    |
| src/entities/modules.ts    | `buildAssetsEntityModules(...)` — entity module with `manual` adapter wiring      |
| src/entities/runtime.ts    | Adapter TTL transform + custom-op handlers (presignUpload / presignDownload / serveImage) |
| src/entities/asset.ts      | Asset entity definition                                                           |
| src/entities/factories.ts  | Store-backed asset adapter factories with lazy TTL enforcement                    |
| src/adapters/index.ts      | Storage adapter resolution (`s3` / `local` / `memory`)                            |
| src/middleware/deleteStorageFile.ts | Delete-cascade middleware + bounded orphan registry                      |
| src/config.schema.ts       | Assets package config schema                                                      |
| src/types.ts               | Shared asset records, adapter contracts, and config types                         |
| docs/human/index.md        | Package guide synced into the docs site                                           |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`, `packages/slingshot-entity/src/index.ts`, and `packages/slingshot-permissions/src/index.ts`
- **Imported by**: app-level package composition

## Common Tasks

- **Adding a storage adapter**: add the adapter file under `src/adapters/`, then wire it through `src/adapters/index.ts`
- **Changing runtime handler behavior**: update `src/entities/runtime.ts`, then verify the wiring in `src/entities/modules.ts`
- **Changing config options**: update `src/config.schema.ts`, then update `docs/human/index.md`
- **Testing**: `packages/slingshot-assets/tests/`
