# slingshot-interactions

Interactive component and dispatch orchestration plugin for Slingshot. It models component
schemas, request payloads, and routing for message-driven interactions.

## Key Files

| File                               | What                                                               |
| ---------------------------------- | ------------------------------------------------------------------ |
| src/index.ts                       | Public API surface for plugin, component schemas, and test helpers |
| src/plugin.ts                      | `createInteractionsPlugin()` factory                               |
| src/config/schema.ts               | Interaction plugin config schema                                   |
| src/components/schema.ts           | Shared component payload schema definitions                        |
| src/handlers/dispatchers/route.ts  | Route dispatcher implementation                                    |
| src/routes/dispatchRoute.schema.ts | Dispatch route request and response schema                         |
| docs/human/index.md                | Package guide synced into the docs site                            |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`, `packages/slingshot-entity/src/index.ts`, and `packages/slingshot-permissions/src/index.ts`
- **Imported by**: app-level plugin composition

## Common Tasks

- **Adding a new interaction shape**: update `src/components/schema.ts`, then trace it through `src/handlers/dispatchers/route.ts`
- **Changing config options**: update `src/config/schema.ts`, then update `docs/human/index.md`
- **Testing**: `packages/slingshot-interactions/tests/`
