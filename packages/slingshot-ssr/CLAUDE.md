# slingshot-ssr

SSR, ISR, and page-routing plugin for Slingshot. It owns route resolution, page loader
assembly, action handling, and cache-aware rendering helpers.

## Key Files

| File                 | What                                                        |
| -------------------- | ----------------------------------------------------------- |
| src/index.ts         | Public API surface for plugin, route helpers, and SSR types |
| src/plugin.ts        | `createSsrPlugin()` factory                                 |
| src/config.schema.ts | SSR plugin config schema                                    |
| src/resolver.ts      | Route and asset resolution helpers                          |
| src/pageResolver.ts  | Page declaration resolution                                 |
| src/pageLoaders.ts   | Loader resolution and page loading                          |
| src/actions/index.ts | SSR action exports                                          |
| docs/human/index.md  | Package guide synced into the docs site                     |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts` and `packages/slingshot-entity/src/index.ts`
- **Imported by**: `packages/slingshot-ssg/src/index.ts`, `packages/runtime-edge/src/index.ts`, and manifest bootstrap via `../../src/lib/builtinPlugins.ts`

## Common Tasks

- **Changing config options**: update `src/config.schema.ts`, then trace the behavior through `src/plugin.ts`
- **Changing route resolution**: update `src/resolver.ts`, `src/pageResolver.ts`, and `src/pageLoaders.ts` together
- **Testing**: `packages/slingshot-ssr/tests/`
