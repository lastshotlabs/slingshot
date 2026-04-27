# slingshot-notifications

Shared notification storage, preference resolution, scheduling, and dispatcher plumbing. Other
feature packages depend on this package for notification persistence and delivery.
Notification entities follow the shared package-first/entity model; `createNotificationsPlugin()` is
the runtime shell that wires storage, dispatch, and delivery.

## Key Files

| File                      | What                                                             |
| ------------------------- | ---------------------------------------------------------------- |
| src/index.ts              | Public API surface for plugin, builder, dispatcher, and entities |
| src/plugin.ts             | `createNotificationsPlugin()` factory                            |
| src/types/config.ts       | Notifications plugin config schema                               |
| src/builder.ts            | Notification builder entry points                                |
| src/dispatcher.ts         | Delivery dispatcher implementation                               |
| src/preferences.ts        | Preference and quiet-hours resolution                            |
| src/rateLimit/registry.ts | Notification rate-limit registry                                 |
| docs/human/index.md       | Package guide synced into the docs site                          |

## Connections

- **Imports from**: `packages/slingshot-core/src/index.ts` and `packages/slingshot-entity/src/index.ts`
- **Imported by**: `packages/slingshot-chat/src/index.ts`, `packages/slingshot-community/src/index.ts`, `packages/slingshot-push/src/index.ts`, and manifest bootstrap via `../../src/lib/builtinPlugins.ts`

## Common Tasks

- **Changing delivery behavior**: update `src/builder.ts`, `src/dispatcher.ts`, and any related state or entity types
- **Changing config options**: update `src/types/config.ts`, then update `docs/human/index.md`
- **Testing**: `packages/slingshot-notifications/tests/`
