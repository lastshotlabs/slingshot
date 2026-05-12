# slingshot-chat

Real-time chat **package** with rooms, memberships, messages, reactions, read receipts, pins,
blocks, favorites, invites, reminders, scheduled messages, AES-GCM message-body encryption,
and a WebSocket realtime surface layered on Slingshot entity and notification primitives.
Authored via `definePackage(...)` and consumed through
`createApp({ packages: [createChatPackage(...)] })`. Cross-package consumers resolve the
interactions peer via `ChatInteractionsPeerCap`.

## Key Files

| File                       | What                                                                            |
| -------------------------- | ------------------------------------------------------------------------------- |
| src/index.ts               | Public API surface for package, entities, peer contracts, and chat events       |
| src/plugin.ts              | `createChatPackage()` factory (`SlingshotPackageDefinition`)                    |
| src/entities/modules.ts    | `buildChatEntityModules(...)` — 10 entity modules with manual adapter wiring    |
| src/entities/runtime.ts    | Adapter ref shapes, message adapter transforms, and lifted custom-op handlers   |
| src/config.schema.ts       | Chat package config schema                                                      |
| src/types.ts               | Shared chat records, config types, and event payloads                           |
| src/encryption/provider.ts | Encryption provider contract and dispatch point                                 |
| src/public.ts              | `Chat` contract and `ChatInteractionsPeerCap`                                   |
| src/ws/incoming.ts         | Incoming WebSocket event handling                                               |
| docs/human/index.md        | Package guide synced into the docs site                                         |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts`, `packages/slingshot-entity/src/index.ts`, `packages/slingshot-notifications/src/index.ts`, and `packages/slingshot-permissions/src/index.ts`
- **Runtime dependencies**: requires the `slingshot-auth`, `slingshot-notifications`, and `slingshot-permissions` packages to be registered first
- **Imported by**: app-level package composition

## Common Tasks

- **Adding or changing entities**: update the relevant file under `src/entities/`, then keep `src/index.ts` exports and `src/entities/modules.ts` aligned
- **Adding config or permissions**: update `src/config.schema.ts`, then trace the effect through `src/plugin.ts`
- **Changing adapter-dependent middleware**: update the middleware file under `src/middleware/`, then verify the wiring in `src/plugin.ts` (lazy refs populated inside `setupMiddleware` / `setupPost`)
- **Changing custom-op handler behavior (DM, unread count, forward, invite redemption, scheduled-message claim, reminder claim)**: update `src/entities/runtime.ts`, then verify the override wiring in `src/entities/modules.ts`
- **Changing realtime behavior**: update `src/ws/incoming.ts` and any related payload types in `src/types.ts`
- **Testing**: `packages/slingshot-chat/tests/`
