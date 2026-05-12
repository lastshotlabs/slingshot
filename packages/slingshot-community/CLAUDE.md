# slingshot-community

Community/forum **package** with containers, threads, replies, moderation, reactions, invites,
and entity-driven operations layered on the Slingshot runtime. Authored via
`definePackage(...)` and consumed through
`createApp({ packages: [createCommunityPackage(...)] })`. Cross-package consumers resolve the
interactions peer via `CommunityInteractionsPeerCap` and the community plugin-state slot via
`CommunityPluginStateRef`.

## Key Files

| File                        | What                                                                              |
| --------------------------- | --------------------------------------------------------------------------------- |
| src/index.ts                | Public API surface for package, entities, operations, and peer contracts          |
| src/plugin.ts               | `createCommunityPackage()` factory (`SlingshotPackageDefinition`)                 |
| src/entities/modules.ts     | `buildCommunityEntityModules(...)` — 19 entity modules with manual adapter wiring |
| src/entities/runtime.ts     | Adapter ref shapes + lifted custom-op handlers (`redeemInvite`, slot helpers)     |
| src/entities/thread.ts      | Representative entity definition and operations export                            |
| src/types/config.ts         | Community package config schema and public config types                           |
| src/types/state.ts          | Plugin state key and runtime state contracts                                      |
| src/public.ts               | `Community` contract, `CommunityEntities` refs, `CommunityInteractionsPeerCap`    |
| docs/human/index.md         | Package guide synced into the docs site                                           |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`, `packages/slingshot-entity/src/index.ts`, and `packages/slingshot-notifications/src/index.ts`
- **Runtime dependencies**: requires the `slingshot-auth`, `slingshot-notifications`, and `slingshot-permissions` packages to be registered first
- **Imported by**: app-level package composition

## Common Tasks

- **Adding or changing entities**: update the relevant file under `src/entities/`, then keep `src/index.ts` exports and `src/entities/modules.ts` aligned
- **Changing adapter-dependent middleware**: update the middleware file under `src/middleware/`, then verify the wiring in `src/plugin.ts` (lazy refs populated inside `setupMiddleware` / `setupPost`)
- **Changing the invite-redemption flow**: update `src/entities/runtime.ts` (`createRedeemInviteHandler`), then verify the override wiring in `src/entities/modules.ts`
- **Changing config options**: update `src/types/config.ts`, then update `docs/human/index.md`
- **Testing**: `packages/slingshot-community/tests/`
