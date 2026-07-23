# @lastshotlabs/slingshot-chat

Install with Bun:

```sh
bun add @lastshotlabs/slingshot-chat
```

`@lastshotlabs/slingshot-chat` is Slingshot's chat domain package. It provides rooms,
memberships, messages, reactions, read receipts, pins, blocks, favorites, invites, reminders,
scheduled messages, and the WebSocket realtime surface — all driven by the shared
package-first/entity authoring model. `createChatPackage()` is the runtime shell that composes
those entities, the entity adapter transforms and custom-op handlers, message encryption hooks,
and notification side effects into the live package.

Rooms can carry an optional `containerId` application grouping key. Community
products use it to associate discoverable rooms with a space without encoding
that relationship into a room name or topic.

## When To Use It

Use this package when your app needs:

- direct messages, group rooms, or broadcast rooms
- message history, reactions, unread counts, and room membership management
- realtime typing/read events and notification fan-out
- scheduled messages, message reminders, and DM orchestration
- a chat domain that integrates with Slingshot auth, permissions, notifications, and entity
  tooling

Do not use it as a generic transport layer for unrelated product flows. It is a full chat
domain, not a low-level socket primitive.

## Dependencies

`createChatPackage()` declares these dependencies. The framework topological sort uses the
declared list to enforce order, but the consumed capabilities have to actually be available —
register them in your app's `plugins` (for `slingshot-auth`) and `packages`
(for `slingshot-permissions`, `slingshot-notifications`) arrays before chat.

| Module                    | Tier    | How it's consumed                                                                          |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `slingshot-auth`          | plugin  | required; routes resolve the actor through the auth context                                |
| `slingshot-permissions`   | package | required; via `PermissionsEvaluatorCap`, `PermissionsRegistryCap`, `PermissionsAdapterCap` |
| `slingshot-notifications` | package | required; via `NotificationsBuilderFactoryCap` for outbound notifications                  |

Optional, opportunistically integrated when present:

| Plugin                   | What it does                                                     |
| ------------------------ | ---------------------------------------------------------------- |
| `slingshot-push`         | chat registers push formatters for each notification type        |
| `slingshot-embeds`       | URL unfurl on new messages → updates `embeds` and emits an event |
| `slingshot-interactions` | resolves `ChatInteractionsPeerCap` for component dispatch        |

## Public Contract

`@lastshotlabs/slingshot-chat` publishes the `Chat` package contract with one capability
handle:

- `ChatInteractionsPeerCap` — resolves to a `ChatInteractionsPeer` that can read a chat
  message tree (`chat:message`) by id and apply component updates returned by an interaction
  dispatcher.

Cross-package consumers resolve it through `ctx.capabilities.require(ChatInteractionsPeerCap)`
instead of reaching into plugin state. The package also continues to write `interactionsPeer`
into `pluginState` under `CHAT_PLUGIN_STATE_KEY` so legacy
`getPublishedInteractionsPeerOrNull` callers keep working.

```ts
// @skip-typecheck
import { ChatInteractionsPeerCap } from '@lastshotlabs/slingshot-chat';
import { getContext } from '@lastshotlabs/slingshot-core';

// In a setupPost hook, route handler, or any place with a SlingshotContext:
const ctx = getContext(app);
const peer = ctx.capabilities.maybe(ChatInteractionsPeerCap);
if (peer) {
  const message = await peer.resolveMessageByKindAndId('chat:message', messageId);
  // message.components is the component tree; update with peer.updateComponents(...)
}
```

The full chat runtime — the bundled adapter set, evaluator, and config — is published
separately under the typed `CHAT_RUNTIME_KEY` slot for in-package consumers (entity runtime,
encryption router, WebSocket dispatch). Treat that slot as internal: cross-package code goes
through the public contract.

## Minimum Setup

### App config (recommended)

```ts title="app.config.ts"
import { defineApp } from '@lastshotlabs/slingshot';
import { createAuthPlugin } from '@lastshotlabs/slingshot-auth';
import { createChatPackage } from '@lastshotlabs/slingshot-chat';
import { createNotificationsPackage } from '@lastshotlabs/slingshot-notifications';
import { createPermissionsPackage } from '@lastshotlabs/slingshot-permissions';

export default defineApp({
  plugins: [
    createAuthPlugin({
      auth: { roles: ['user', 'admin'], defaultRole: 'user' },
      db: { auth: 'memory', sessions: 'memory', oauthState: 'memory' },
    }),
  ],
  packages: [
    createPermissionsPackage(),
    createNotificationsPackage(),
    createChatPackage({ storeType: 'memory', mountPath: '/chat' }),
  ],
});
```

The `slingshot-permissions` and `slingshot-notifications` registrations must come before
`slingshot-chat` — the package throws during setup if either capability is unavailable.

## Authoring Story

Slingshot's general authoring model — `defineApp`, `definePackage`, `definePackageContract` —
is documented in
[Authoring Model](https://slingshot.lastshotlabs.com/authoring-model/) and [Package-First](https://slingshot.lastshotlabs.com/package-first/).
The patterns below are how that model applies to chat.

### Consume chat from another package

Declare chat as a dependency, then resolve `ChatInteractionsPeerCap` from the context. This
is the canonical pattern — consumers do not import chat plugin state.

```ts
// @skip-typecheck
import { definePackageContract } from '@lastshotlabs/slingshot';
import { Chat, ChatInteractionsPeerCap } from '@lastshotlabs/slingshot-chat';

export const Bots = definePackageContract('bots');

export const botsPackage = Bots.definePackage({
  dependencies: [Chat],
  capabilities: { requires: [ChatInteractionsPeerCap] },
  domains: [
    /* domain({ ... routes that call ctx.capabilities.require(ChatInteractionsPeerCap) ... }) */
  ],
});
```

### Subscribe to chat events

Chat emits events on the framework event bus for every meaningful state change. Subscribe in
your plugin's `setupPost` (or a package's setup hook) — see [Events](#events) for the full
list.

```ts
// @skip-typecheck
import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';

export function createChatAuditPlugin(): SlingshotPlugin {
  return {
    name: 'chat-audit',
    dependencies: ['slingshot-chat'],
    async setupPost({ bus }) {
      bus.on('chat:message.created', async ({ id, roomId, authorId, type }) => {
        // append to your audit log, fan out to a search index, run safety classifiers
      });
      bus.on('chat:message.deleted', async payload => {
        // ...
      });
    },
  };
}
```

### Extend with custom routes

Chat itself is a `definePackage(...)` package — its routes are generated from its entity
definitions. To add custom chat-adjacent routes (an admin dashboard, a bot endpoint), define
your own package and depend on chat:

```ts
// @skip-typecheck
import { definePackage, domain, route } from '@lastshotlabs/slingshot';
import { Chat } from '@lastshotlabs/slingshot-chat';

export const chatAdminPackage = definePackage({
  name: 'chat-admin',
  dependencies: [Chat.name],
  domains: [
    domain({
      name: 'chat-admin',
      basePath: '/admin/chat',
      routes: [
        route.get({
          path: '/recent-rooms',
          auth: 'userAuth',
          permission: 'chat:admin:read',
          summary: 'List recently active rooms',
          handler: async ({ respond }) => {
            // call into your own datastore or services — chat's adapters are internal
            return respond.json({ rooms: [] });
          },
        }),
      ],
    }),
  ],
});
```

### Plug a custom encryption provider

Chat's `encryption` config currently supports `'none'` (the default) and `'aes-gcm'`. The
provider contract lives at `src/encryption/provider.ts`; replace it (or extend the
`resolveChatEncryptionProvider()` switch) when wiring an external KMS, double-ratchet
implementation, or pre-shared keys.

```ts
// @skip-typecheck
createChatPackage({
  storeType: 'postgres',
  mountPath: '/chat',
  encryption: {
    provider: 'aes-gcm',
    keyMaterial: process.env.CHAT_AES_KEY!, // 32-byte key, base64
  },
});
```

The encryption router is mounted at `${mountPath}/encryption` for client key-bundle exchange
(v1 stub shape; see `UserKeyBundle`).

### Register custom push formatters

When `slingshot-push` is loaded, chat registers default push formatters for its own
notification types. Override or extend by registering yours _after_ chat runs `setupPost`:

```ts
// @skip-typecheck
import { PushRuntimeCap } from '@lastshotlabs/slingshot-push';

export function createBrandedChatPushFormattersPlugin() {
  return {
    name: 'branded-chat-push-formatters',
    dependencies: ['slingshot-chat', 'slingshot-push'],
    async setupPost({ app }) {
      const push = getContext(app).capabilities.require(PushRuntimeCap);
      push.registerFormatter('chat:message', n => ({
        title: `💬 ${n.data?.authorName ?? 'New message'}`,
        body: typeof n.data?.bodyPreview === 'string' ? n.data.bodyPreview : '',
        url: `/chat/rooms/${n.data?.roomId}#msg-${n.data?.messageId}`,
      }));
    },
  };
}
```

The last formatter registered for a given notification type wins, so a custom override
plugin must declare `'slingshot-chat'` (and `'slingshot-push'`) as dependencies to run
after them.

## First Config Knobs To Know

- `storeType` — required; selects the persistence backend (`memory`, `redis`, `sqlite`,
  `postgres`, `mongo`)
- `tenantId` — fix chat to a single tenant; defaults to `'default'`
- `mountPath` — defaults to `/chat`
- `pageSize` — default pagination size for room message lists; defaults to `50`
- `enablePresence` — whether the live room channel publishes presence; defaults to `true`
- `permissions` — role requirements for room creation, sending, deleting, pinning, and adding
  members
- `encryption` — `provider: 'none'` (default) or `provider: 'aes-gcm'`. Omitting the field
  does **not** produce encrypted storage; it means chat stores message payloads without
  plugin-managed encryption.

## What You Get

- Room, RoomMember, Message, ReadReceipt, MessageReaction, Pin, Block, FavoriteRoom,
  RoomInvite, and Reminder entities — each with config-driven CRUD plus generated operation
  routes
- Permission-aware middleware: archive guard, broadcast guard, DM-room guard, room-creator
  grant, member grant, message post-create, reply-count update/decrement, plus
  notification-emitting middleware for new messages and invitations
- WebSocket incoming handlers for chat events, self-wired onto
  `SlingshotContext.wsEndpoints[mountPath]` during `setupPost`
- Notification hooks for message delivery and member invitations, routed through the shared
  `slingshot-notifications` builder
- Unread-count and DM orchestration logic inside the entity runtime (adapter transforms + custom-op handlers)
- An encryption router mounted at `${mountPath}/encryption` for key-bundle exchange (v1 stub
  shape)
- Periodic schedulers (30 s tick) that drain due reminders and deliver scheduled messages
- A `chat:message.embeds.resolved` event surface consumed by embed-aware peers
- Push formatters registered automatically when `slingshot-push` is present

## Events

Chat augments `SlingshotEventMap` so every event below is fully typed when you call
`bus.on(...)`.

| Event                                         | Notes                                               |
| --------------------------------------------- | --------------------------------------------------- |
| `chat:room.created`                           | new room                                            |
| `chat:room.updated`                           | room fields updated                                 |
| `chat:room.deleted`                           | room deleted                                        |
| `chat:room.archived` / `.unarchived`          | archive state changed                               |
| `chat:room.favorited` / `.unfavorited`        | per-user favorite toggled                           |
| `chat:member.added` / `.updated` / `.removed` | room membership changes                             |
| `chat:message.created`                        | new message; payload includes `type` and `authorId` |
| `chat:message.updated`                        | message edited                                      |
| `chat:message.deleted`                        | message deleted; payload includes deletion metadata |
| `chat:message.embeds.resolved`                | unfurl results applied to a message                 |
| `chat:message.scheduled.created`              | scheduled message queued                            |
| `chat:message.scheduled.delivered`            | scheduler delivered a queued message                |
| `chat:message.reaction.added` / `.removed`    | reaction toggled on a message                       |
| `chat:message.pinned` / `.unpinned`           | pin state changed                                   |
| `chat:read.created`                           | read receipt created                                |
| `chat:reminder.created`                       | reminder scheduled                                  |
| `chat:reminder.triggered`                     | reminder fired by the 30 s scheduler                |
| `chat:invite.created`                         | room invite created                                 |
| `chat:user.blocked` / `.unblocked`            | block relationship toggled                          |

`chat:message.embeds.resolved` is emitted by chat itself after the embed-aware peer
(`slingshot-embeds`) returns unfurl results — chat owns the storage write and the event
publish.

## Notifications Emitted

Chat emits these notification types through `NotificationsBuilderFactoryCap`. Register push
formatters for them in `slingshot-push` (chat registers defaults automatically when push is
present).

| Type           | When                                        |
| -------------- | ------------------------------------------- |
| `chat:message` | a new message in a room you are a member of |
| `chat:invite`  | someone invited you to a room               |

## Operational Notes

- Chat is config-driven by design. If you find yourself wrapping its routes with a large
  layer of bespoke handlers, that is usually a signal the abstraction boundary is wrong for
  your domain — extend the entity modules or contribute a config knob upstream rather than
  forking the runtime.
- The 30 s reminder/scheduled-message intervals run unconditionally during `setupPost` and
  are cleared in `teardown()`. They are guarded against re-entry; a long-running tick will
  not fire concurrently with itself.
- The push-formatter and embeds integrations are opportunistic. When the corresponding package
  is not registered, the probes are no-ops — no error, no warning.
- Encryption providers run at the storage boundary. If you switch providers in production,
  plan a migration: existing rows still hold ciphertext encrypted with the old key.

## Gotchas

- Register `slingshot-permissions` and `slingshot-notifications` before chat. The package
  throws during setup if either capability is unavailable.
- `tenantId` falls back to `'default'` when omitted. Multi-tenant apps should be deliberate
  about whether that is correct.
- Omitting `encryption` does not produce encrypted storage. It means chat stores message
  payloads without package-managed encryption.
- WebSocket incoming handlers are mounted onto `wsEndpoints[mountPath]`. If you also configure
  a separate `ws.wsEndpoint` elsewhere, the chat handlers and yours will share the same slot —
  configure carefully or let chat own that endpoint exclusively.
- The encryption router (`${mountPath}/encryption`) is the v1 stub shape for key-bundle
  exchange. Treat its types as PENDING until v2 lands.

## Source-Backed Examples

- [Collaboration Workspace](https://slingshot.lastshotlabs.com/examples/collaboration-workspace/) — chat alongside
  community, polls, interactions, embeds, and push in `examples/collaboration-workspace/`

## Key Files

- `src/index.ts`
- `src/public.ts`
- `src/plugin.ts`
- `src/config.schema.ts`
- `src/types.ts`
- `src/state.ts`
- `src/entities/modules.ts`
- `src/entities/runtime.ts`
- `src/ws/incoming.ts`
- `src/encryption/provider.ts`
- `src/events.ts`
