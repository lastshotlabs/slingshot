# slingshot-search

Enterprise search plugin with swappable providers, query parsing, index settings, and event
sync hooks for keeping entity-backed indexes current.

## Key Files

| File                       | What                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| src/index.ts               | Public API surface for plugin, provider factories, and search types |
| src/plugin.ts              | `createSearchPlugin()` factory                                      |
| src/types/config.ts        | Search plugin config schema and admin gate types                    |
| src/types/provider.ts      | Provider-specific config contracts                                  |
| src/searchManager.ts       | Search manager orchestration                                        |
| src/eventSync.ts           | Search sync event handling                                          |
| src/providers/typesense.ts | Representative provider implementation                              |
| docs/human/index.md        | Package guide synced into the docs site                             |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`
- **Imported by**: direct application use

## Common Tasks

- **Adding a provider**: add the provider under `src/providers/`, export it from `src/index.ts`, and update the provider union in `src/types/provider.ts`
- **Changing config options**: update `src/types/config.ts`, then update `docs/human/index.md`
- **Testing**: `packages/slingshot-search/tests/`
