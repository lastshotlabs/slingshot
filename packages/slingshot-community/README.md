---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-community
---

`@lastshotlabs/slingshot-community` is Slingshot's community/forum domain package. It provides
containers, threads, replies, reactions, container memberships and rules, reports, bans, tags,
invites, subscriptions, mutes, bookmarks, automod rules, warnings, audit log entries, and
container settings — all driven by the shared package-first/entity authoring model.
`createCommunityPackage()` is the runtime shell that composes those entities, package
middleware, the WebSocket channel surface, and notification side effects into the live package.

## When To Use It

Use this package when your app needs:

- a forum, discussion, or member-generated content surface
- containers (forums/spaces) with threads, replies, reactions, and moderation
- container roles, member permissions, and grant management
- reports, bans, warnings, and an audit log
- mention notifications, ban notifications, and reply-subscription notifications wired through
  `slingshot-notifications`
- a real-time channel surface for thread/reply updates

Do not use it as a generic message log or a chat surface. Use `slingshot-chat` for direct
messaging and ephemeral conversation flows.

## Dependencies

`createCommunityPackage()` declares these dependencies. The framework topological sort uses
the declared list to enforce order, but the consumed capabilities have to actually be
available — list them all in your app's `plugins` array before community.

| Plugin                    | How it's consumed                                                     |
| ------------------------- | --------------------------------------------------------------------- |
| `slingshot-auth`          | required; routes resolve the actor through the auth context           |
| `slingshot-permissions`   | required; via `PermissionsEvaluatorCap`, `PermissionsRegistryCap`, `PermissionsAdapterCap` |
| `slingshot-notifications` | required; via `NotificationsBuilderFactory` for outbound notifications |

Optional, opportunistically integrated when present:

| Plugin                    | What it does                                                          |
| ------------------------- | --------------------------------------------------------------------- |
| `slingshot-push`          | community registers push formatters for each notification type        |
| `slingshot-interactions`  | resolves `CommunityInteractionsPeerCap` for component dispatch        |

## Public Contract

`@lastshotlabs/slingshot-community` publishes the `Community` package contract with one
capability handle:

- `CommunityInteractionsPeerCap` — resolves to a `CommunityInteractionsPeer` that can read a
  community message tree (`community:thread`, `community:reply`, `community:post`) by id and
  apply component updates returned by an interaction dispatcher.

Cross-package consumers resolve it through `ctx.capabilities.require(CommunityInteractionsPeerCap)`
instead of reaching into plugin state. The plugin also continues to write `interactionsPeer`
into `pluginState` under `COMMUNITY_PLUGIN_STATE_KEY` so legacy
`getPublishedInteractionsPeerOrNull` callers keep working.

```ts
// @skip-typecheck
import { CommunityInteractionsPeerCap } from '@lastshotlabs/slingshot-community';
import { getContext } from '@lastshotlabs/slingshot-core';

// In a setupPost hook, route handler, or any place with a SlingshotContext:
const ctx = getContext(app);
const peer = ctx.capabilities.maybe(CommunityInteractionsPeerCap);
if (peer) {
  const thread = await peer.resolveMessageByKindAndId('community:thread', threadId);
  // thread.components is the component tree; update with peer.updateComponents(...)
}
```

## Minimum Setup

### App config (recommended)

```ts title="app.config.ts"
import { defineApp } from '@lastshotlabs/slingshot';
import { createAuthPlugin } from '@lastshotlabs/slingshot-auth';
import { createCommunityPackage } from '@lastshotlabs/slingshot-community';
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
    createCommunityPackage({ authBridge: 'auto', containerCreation: 'user' }),
  ],
});
```

The `slingshot-permissions` and `slingshot-notifications` registrations must come before
`slingshot-community` — the package throws during setup if either capability is unavailable.

## Authoring Story

Slingshot's general authoring model — `defineApp`, `definePackage`, `definePackageContract` —
is documented in
[Authoring Model](/slingshot/authoring-model/) and [Package-First](/slingshot/package-first/).
The patterns below are how that model applies to community.

### Consume community from another package

Declare community as a dependency, then resolve `CommunityInteractionsPeerCap` from the
context. This is the canonical pattern — consumers do not import community plugin state.

```ts
// @skip-typecheck
import { definePackageContract } from '@lastshotlabs/slingshot';
import { Community, CommunityInteractionsPeerCap } from '@lastshotlabs/slingshot-community';

export const Moderation = definePackageContract('moderation');

export const moderationPackage = Moderation.definePackage({
  dependencies: [Community],
  capabilities: { requires: [CommunityInteractionsPeerCap] },
  domains: [
    /* domain({ ... routes that call ctx.capabilities.require(CommunityInteractionsPeerCap) ... }) */
  ],
});
```

### Subscribe to community events

Community emits events on the framework event bus for every meaningful state change. Subscribe
in your plugin's `setupPost` (or a package's setup hook) — see [Events](#events) for the full
list.

```ts
// @skip-typecheck
import type { SlingshotPlugin } from '@lastshotlabs/slingshot-core';

export function createModerationPlugin(): SlingshotPlugin {
  return {
    name: 'moderation',
    dependencies: ['slingshot-community'],
    async setupPost({ bus }) {
      bus.on('community:thread.created', async ({ id, containerId, authorId }) => {
        // queue an automod scan, update a search index, page on-call, etc.
      });
      bus.on('community:reply.created', async payload => {
        // ...
      });
    },
  };
}
```

### Extend with custom routes

Community itself is a `definePackage(...)` package — its routes are generated from its entity
definitions. To add custom community-adjacent routes (a moderation dashboard, a custom search
endpoint), define your own package and depend on community:

```ts
// @skip-typecheck
import { definePackage, domain, route } from '@lastshotlabs/slingshot';
import { Community } from '@lastshotlabs/slingshot-community';

export const moderationPackage = definePackage({
  name: 'moderation',
  dependencies: [Community.name],
  domains: [
    domain({
      name: 'moderation',
      basePath: '/admin/moderation',
      routes: [
        route.get({
          path: '/recent-reports',
          auth: 'userAuth',
          permission: 'moderation:read',
          summary: 'List recent reports',
          handler: async ({ respond }) => {
            // call into your own datastore — community's report adapter is internal
            return respond.json({ reports: [] });
          },
        }),
      ],
    }),
  ],
});
```

### Register custom push formatters

When `slingshot-push` is loaded, community registers default push formatters for its own
notification types (`community:reply`, `community:mention`, `community:ban`, `community:warning`,
`community:thread.subscribed_reply`). Override or extend by registering your own *after*
community runs `setupPost`:

```ts
// @skip-typecheck
import { PushRuntimeCap } from '@lastshotlabs/slingshot-push';

export function createBrandedPushFormattersPlugin() {
  return {
    name: 'branded-push-formatters',
    dependencies: ['slingshot-community', 'slingshot-push'],
    async setupPost({ app }) {
      const push = getContext(app).capabilities.require(PushRuntimeCap);
      push.registerFormatter('community:mention', n => ({
        title: `🔔 ${n.data?.actorName ?? 'Someone'} mentioned you`,
        body: typeof n.data?.bodyPreview === 'string' ? n.data.bodyPreview : '',
        url: `/community/threads/${n.data?.threadId}`,
      }));
    },
  };
}
```

The last formatter registered for a given notification type wins, so this plugin must declare
`'slingshot-community'` (and `'slingshot-push'`) as dependencies to run after them.

## First Config Knobs To Know

- `authBridge` — `'auto'` wires the auth-context-to-community-principal middleware on
  `${mountPath}/*`; `'none'` (the default) requires manual middleware
- `containerCreation` — `'user'` or `'admin'`
- `mountPath` — defaults to `/community`
- `scoring` — built-in ranking algorithm and weights for thread/reply ordering
- `disableRoutes` — turn off specific generated route groups
- `ws.wsEndpoint` — WebSocket endpoint name; when set, the plugin self-wires
  `onRoomSubscribe` and `incoming` handlers onto `SlingshotContext.wsEndpoints[wsEndpoint]`
  during `setupPost`

## What You Get

- Container, Thread, Reply, Reaction, ContainerMember, ContainerRule, Report, Ban, Tag,
  ThreadTag, ContainerInvite, ContainerSubscription, ThreadSubscription, UserMute, Bookmark,
  AutoModRule, Warning, AuditLogEntry, and ContainerSetting entities — each with config-driven
  CRUD plus generated operation routes
- Permission-aware middleware: container-creation guard, member-join guard, role-assignment
  guard, ban check, automod, thread-state guard, target-visibility guard, report-target guard,
  audit-log writer, plus reply-count update/decrement and grant manager
- Mention, reply, ban, warning, and thread-subscription notifications routed through the
  shared `slingshot-notifications` builder
- Push formatters for community notification types — registered automatically when
  `slingshot-push` is present (duck-typed; no hard dependency)
- A `community:thread.embeds.resolved` and `community:reply.embeds.resolved` event surface
  consumed by embed-aware peers
- A `community:invite.redeemed` event when an invite is accepted
- Self-wired WebSocket subscribe guard and incoming handler map under the configured
  `ws.wsEndpoint`

## Events

Community augments `SlingshotEventMap` so every event below is fully typed when you call
`bus.on(...)`.

| Event                                  | Notes                                                  |
| -------------------------------------- | ------------------------------------------------------ |
| `community:container.created`          | new container created                                  |
| `community:container.deleted`          | container deleted (cascades through entity definitions) |
| `community:thread.created`             | new thread; payload includes `format`                  |
| `community:thread.updated`             | thread fields updated                                  |
| `community:thread.deleted`             | thread deleted                                         |
| `community:thread.published`           | thread state transitioned to published                 |
| `community:thread.locked` / `.unlocked` | thread lock state changed                              |
| `community:thread.pinned` / `.unpinned` | thread pin state changed                               |
| `community:thread.solved` / `.unsolved` | solution-reply state changed                           |
| `community:reply.created`              | new reply; payload includes `parentId` for threading   |
| `community:reply.deleted`              | reply deleted                                          |
| `community:reaction.added` / `.removed` | reaction toggled on a thread or reply                  |
| `community:thread.embeds.resolved`     | embed unfurl results applied to a thread               |
| `community:reply.embeds.resolved`      | embed unfurl results applied to a reply                |
| `community:invite.redeemed`            | invite accepted; payload includes `alreadyMember`      |

The `embeds.resolved` events are emitted by an embed-aware peer (e.g. `slingshot-embeds`),
not by community itself — community owns the storage update and event registration; the peer
plugin emits the event after applying the unfurl.

## Notifications Emitted

Community emits these notification types through `NotificationsBuilderFactory`. Register
push formatters for them in `slingshot-push` (community registers defaults automatically when
push is present).

| Type                                  | When                                                              |
| ------------------------------------- | ----------------------------------------------------------------- |
| `community:reply`                     | a reply is created on your thread                                 |
| `community:mention`                   | you are `@`-mentioned in a thread or reply                        |
| `community:ban`                       | you have been banned from a container                             |
| `community:warning`                   | a moderator issued a warning                                      |
| `community:thread.subscribed_reply`   | a reply on a thread you subscribed to                             |

## Auth Bridge

Community routes expect a `communityPrincipal` on the request context. The built-in
`authBridge` config wires this automatically:

```ts
createCommunityPackage({ authBridge: 'auto', containerCreation: 'user' });
```

When `authBridge` is `'auto'`, the plugin installs middleware on `${mountPath}/*` that reads
`actor.id` and `roles` from the framework auth context and sets `communityPrincipal` for
community routes. Use `'none'` only when you need to wire the bridge yourself — typical only
when you are consuming community routes from an environment without the standard `getActor()`
surface.

## Operational Notes

- Community is config-driven by design. If you find yourself wrapping its routes with a large
  layer of bespoke handlers, that is usually a signal the abstraction boundary is wrong for
  your domain — extend the entity modules or contribute a config knob upstream rather than
  forking the runtime.
- Adapter-dependent middleware (banCheck, autoMod, threadStateGuard, banNotify) is initialised
  inside `setupMiddleware` once the entity runtime captures the adapters. The middleware refs
  start as no-ops; treat early-route requests during setup as expected no-op-pass-through, not
  an error.
- The push-formatter integration is opportunistic. When `slingshot-push` is not registered,
  the probe is a no-op — no error, no warning.
- The `authBridge: 'auto'` middleware sets `communityPrincipal` only when `actor.id` is
  present. Anonymous routes (typed `auth: 'none'`) still receive the request; protected routes
  reject through the route's `auth` declaration, not through the bridge.

## Gotchas

- Register `slingshot-permissions` and `slingshot-notifications` before community. The package
  throws during setup if either capability is unavailable.
- Community expects a `communityPrincipal` on the request context for protected flows. Either
  use `authBridge: 'auto'` or install equivalent middleware before community routes run.
- WebSocket self-wiring under `ws.wsEndpoint` mutates `SlingshotContext.wsEndpoints[wsEndpoint]`.
  If you also configure that endpoint elsewhere, make sure the keys do not collide.
- Embed unfurl events (`community:thread.embeds.resolved`, `community:reply.embeds.resolved`)
  are emitted by the embed-aware peer plugin, not by community. Subscribing to them when no
  embed plugin is installed yields nothing — that is expected.

## Source-Backed Examples

- [Forum App](/slingshot/examples/forum-app/) — auth + community + permissions + notifications
  in `examples/forum-app/`
- [Collaboration Workspace](/slingshot/examples/collaboration-workspace/) — community alongside
  chat, polls, interactions, embeds, and push in `examples/collaboration-workspace/`

## Key Files

- `src/index.ts`
- `src/public.ts`
- `src/plugin.ts`
- `src/types/config.ts`
- `src/types/state.ts`
- `src/entities/modules.ts`
- `src/entities/runtime.ts`
- `src/middleware/`
- `src/lib/mentions.ts`
- `src/events.ts`
