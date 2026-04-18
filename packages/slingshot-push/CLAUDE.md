# slingshot-push

Multi-provider push delivery plugin with manifest wiring, formatter compilation, entity-backed
subscriptions, and provider dispatch.

## Key Files

| File                      | What                                                                   |
| ------------------------- | ---------------------------------------------------------------------- |
| src/index.ts              | Public API surface for plugin, entities, providers, and router helpers |
| src/plugin.ts             | `createPushPlugin()` factory                                           |
| src/types/config.ts       | Push plugin config schema and config types                             |
| src/router.ts             | Push router assembly                                                   |
| src/formatter.ts          | Push formatter compilation                                             |
| src/providers/provider.ts | Shared push provider contract                                          |
| src/manifest/runtime.ts   | Manifest-aware runtime helpers                                         |
| docs/human/index.md       | Package guide synced into the docs site                                |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`, `packages/slingshot-entity/src/index.ts`, and `packages/slingshot-notifications/src/index.ts`
- **Imported by**: manifest bootstrap via `../../src/lib/builtinPlugins.ts` and app-level plugin composition

## Common Tasks

- **Adding a provider**: add the provider implementation under `src/providers/`, then wire it through `src/plugin.ts`
- **Changing config or formatter behavior**: update `src/types/config.ts` and `src/formatter.ts`, then update `docs/human/index.md`
- **Testing**: `packages/slingshot-push/tests/`
