# slingshot-community

Community/forum plugin with containers, threads, replies, moderation, reactions, invites, and
entity-driven operations layered on the Slingshot runtime.

## Key Files

| File                    | What                                                            |
| ----------------------- | --------------------------------------------------------------- |
| src/index.ts            | Public API surface for plugin, config, entities, and operations |
| src/plugin.ts           | `createCommunityPlugin()` factory                               |
| src/types/config.ts     | Community plugin config schema and public config types          |
| src/entities/thread.ts  | Representative entity definition and operations export          |
| src/manifest/runtime.ts | Manifest-aware runtime helpers                                  |
| src/types/state.ts      | Plugin state key and runtime state contracts                    |
| docs/human/index.md     | Package guide synced into the docs site                         |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`, `packages/slingshot-entity/src/index.ts`, and `packages/slingshot-notifications/src/index.ts`
- **Imported by**: app-level plugin composition

## Common Tasks

- **Adding a new community entity or operation**: add the entity under `src/entities/`, export it from `src/index.ts`, and keep the manifest/runtime wiring aligned
- **Changing config options**: update `src/types/config.ts`, then update `docs/human/index.md`
- **Testing**: `packages/slingshot-community/tests/`
