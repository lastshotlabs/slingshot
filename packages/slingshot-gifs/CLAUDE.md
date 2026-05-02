# slingshot-gifs

Stateless GIF search proxy plugin with swappable provider backends. Provider API keys stay on
the server; the plugin returns normalized result payloads to callers.

## Key Files

| File                   | What                                                    |
| ---------------------- | ------------------------------------------------------- |
| src/index.ts           | Public API surface for plugin, providers, and GIF types |
| src/plugin.ts          | `createGifsPlugin()` factory                            |
| src/types.ts           | GIF result types and plugin config types                |
| src/providers/giphy.ts | Giphy provider implementation                           |
| src/providers/tenor.ts | Tenor provider implementation                           |
| docs/human/index.md    | Package guide synced into the docs site                 |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`
- **Imported by**: direct application use

## Common Tasks

- **Adding a provider**: add the provider under `src/providers/`, export it from `src/index.ts`, and document the new config in `docs/human/index.md`
- **Changing config options**: update `src/types.ts`, then confirm `src/plugin.ts` still validates and dispatches correctly
- **Updating docs**: search `packages/docs/src/content/docs/` for GIF references when behavior changes
