# slingshot-deep-links

Universal links and fallback redirect plugin. It generates Apple AASA payloads, Android
asset links, and runtime redirect behavior from a single config model.

## Key Files

| File                | What                                                               |
| ------------------- | ------------------------------------------------------------------ |
| src/index.ts        | Public API surface for plugin, config helpers, and route constants |
| src/plugin.ts       | `createDeepLinksPlugin()` factory                                  |
| src/config.ts       | Deep links config schema, compile helpers, and public config types |
| src/routes.ts       | Route mounting and well-known path constants                       |
| src/aasa.ts         | Apple AASA payload builders                                        |
| src/assetlinks.ts   | Android asset links payload builders                               |
| docs/human/index.md | Package guide synced into the docs site                            |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`
- **Imported by**: app-level plugin composition

## Common Tasks

- **Changing config options**: update `src/config.ts`, then update the published examples in `docs/human/index.md`
- **Changing Apple or Android output**: update `src/aasa.ts` or `src/assetlinks.ts`, then verify route wiring in `src/routes.ts`
- **Testing**: `packages/slingshot-deep-links/tests/`
