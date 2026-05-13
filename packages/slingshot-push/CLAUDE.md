# slingshot-push

Multi-provider push delivery **package** with formatter compilation, entity-backed
subscriptions/topics/deliveries, and provider dispatch. Authored via `definePackage(...)`
and consumed through `createApp({ packages: [createPushPackage(...)] })`. Cross-package
consumers resolve the runtime via `PushRuntimeCap` and the aggregated health snapshot
via `PushHealthCap`.

## Key Files

| File                       | What                                                                              |
| -------------------------- | --------------------------------------------------------------------------------- |
| src/index.ts               | Public API surface for package, entities, providers, and router helpers           |
| src/plugin.ts              | `createPushPackage()` factory (`SlingshotPackageDefinition`)                      |
| src/entities/modules.ts    | `buildPushEntityModules(...)` — entity modules with `factories`-mode adapter wiring |
| src/types/config.ts        | Push package config schema and config types                                       |
| src/router.ts              | Push router assembly                                                              |
| src/formatter.ts           | Push formatter compilation                                                        |
| src/providers/provider.ts  | Shared push provider contract                                                     |
| docs/human/index.md        | Package guide synced into the docs site                                           |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`, `packages/slingshot-entity/src/index.ts`, and `packages/slingshot-notifications/src/index.ts`
- **Imported by**: app-level package composition

## Common Tasks

- **Adding a provider**: add the provider implementation under `src/providers/`, then wire it through `src/plugin.ts`
- **Changing config or formatter behavior**: update `src/types/config.ts` and `src/formatter.ts`, then update `docs/human/index.md`
- **Testing**: `packages/slingshot-push/tests/`
