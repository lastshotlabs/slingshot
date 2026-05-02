# slingshot-permissions

Policy engine and adapter package for grants, roles, registries, and evaluators. It can be
used directly as a library or mounted through the permissions plugin.

## Key Files

| File                   | What                                                            |
| ---------------------- | --------------------------------------------------------------- |
| src/index.ts           | Public API surface for evaluators, adapters, and plugin exports |
| src/plugin.ts          | `createPermissionsPlugin()` factory                             |
| src/lib/registry.ts    | Permission registry factory                                     |
| src/lib/evaluator.ts   | Permission evaluator implementation                             |
| src/adapters/sqlite.ts | Representative adapter implementation                           |
| src/factories.ts       | Adapter factory registry                                        |
| docs/human/index.md    | Package guide synced into the docs site                         |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`
- **Imported by**: `packages/slingshot-assets/src/index.ts`, `packages/slingshot-chat/src/index.ts`, `packages/slingshot-interactions/src/index.ts`, and app `app.config.ts` files

## Common Tasks

- **Adding an adapter**: add the adapter under `src/adapters/`, then register it in `src/factories.ts`
- **Changing evaluator behavior**: update `src/lib/evaluator.ts` and any registry contract changes in `src/lib/registry.ts`
- **Testing**: `packages/slingshot-permissions/tests/`
