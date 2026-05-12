# slingshot-ssr

SSR, ISR, and page-routing **package** for Slingshot. It owns route resolution, page loader
assembly, action handling, cache-aware rendering helpers, draft mode, and ISR invalidation.
Authored via `definePackage(...)` and consumed through `createApp({ packages: [...] })`.

## Key Files

| File                 | What                                                                |
| -------------------- | ------------------------------------------------------------------- |
| src/index.ts         | Public API surface for package, route helpers, and SSR types        |
| src/plugin.ts        | `createSsrPackage()` factory (`SlingshotPackageDefinition`)         |
| src/public.ts        | `definePackageContract('slingshot-ssr')` + `IsrInvalidatorsCap`     |
| src/config.schema.ts | SSR package config schema                                           |
| src/resolver.ts      | Route and asset resolution helpers                                  |
| src/pageResolver.ts  | Page declaration resolution                                         |
| src/pageLoaders.ts   | Loader resolution and page loading                                  |
| src/middleware.ts    | SSR request middleware, ISR tracker, cache write drain              |
| src/actions/index.ts | SSR action exports                                                  |
| docs/human/index.md  | Package guide synced into the docs site                             |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts` and `packages/slingshot-entity/src/index.ts`
- **Imported by**: `packages/slingshot-ssg/src/index.ts`, `packages/runtime-edge/src/index.ts`, `packages/slingshot-ssr-tanstack/src/index.ts`, and app `app.config.ts` files

## Common Tasks

- **Changing config options**: update `src/config.schema.ts`, then trace the behavior through `src/plugin.ts`
- **Changing route resolution**: update `src/resolver.ts`, `src/pageResolver.ts`, and `src/pageLoaders.ts` together
- **Testing**: `packages/slingshot-ssr/tests/`
