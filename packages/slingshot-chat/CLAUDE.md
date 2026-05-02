# slingshot-chat

Real-time chat plugin with rooms, messages, membership, encryption hooks, and WebSocket event
handling built on Slingshot entities and notification primitives.

## Key Files

| File                       | What                                                         |
| -------------------------- | ------------------------------------------------------------ |
| src/index.ts               | Public API surface for plugin, entity types, and chat events |
| src/plugin.ts              | `createChatPlugin()` factory                                 |
| src/config.schema.ts       | Chat plugin config schema                                    |
| src/types.ts               | Shared chat records, config types, and event payloads        |
| src/encryption/provider.ts | Encryption provider contract and dispatch point              |
| src/ws/incoming.ts         | Incoming WebSocket event handling                            |
| src/manifest/runtime.ts    | Manifest-aware runtime helpers                               |
| docs/human/index.md        | Package guide synced into the docs site                      |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`, `packages/slingshot-entity/src/index.ts`, `packages/slingshot-notifications/src/index.ts`, and `packages/slingshot-permissions/src/index.ts`
- **Imported by**: app-level plugin composition

## Common Tasks

- **Adding config or permissions**: update `src/config.schema.ts`, then trace the effect through `src/plugin.ts`
- **Changing realtime behavior**: update `src/ws/incoming.ts` and any related payload types in `src/types.ts`
- **Testing**: `packages/slingshot-chat/tests/`
