# slingshot-polls

Multiple-choice polls plugin attachable to any user content. It stays content-agnostic by
using policy handlers and stable source-type keys instead of importing consumer packages.

## Key Files

| File                     | What                                                                  |
| ------------------------ | --------------------------------------------------------------------- |
| src/index.ts             | Public API surface for plugin, entities, operations, and policy hooks |
| src/plugin.ts            | `createPollsPlugin()` factory                                         |
| src/validation/config.ts | Polls plugin config schema                                            |
| src/entities/poll.ts     | Poll entity definition                                                |
| src/operations/index.ts  | Poll operations export surface                                        |
| src/policy/index.ts      | Source handler registration and policy helpers                        |
| docs/human/index.md      | Package guide synced into the docs site                               |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts` and `packages/slingshot-entity/src/index.ts`
- **Imported by**: manifest bootstrap via `../../src/lib/builtinPlugins.ts` and direct application use

## Common Tasks

- **Adding a new source-type integration**: update `src/policy/index.ts`, then document the consumer contract in `docs/human/index.md`
- **Changing config options**: update `src/validation/config.ts`, then trace the effect through `src/plugin.ts`
- **Testing**: `packages/slingshot-polls/tests/`
