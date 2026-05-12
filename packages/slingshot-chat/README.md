---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-chat
---

`@lastshotlabs/slingshot-chat` is Slingshot's chat domain package. It uses the config-driven entity
system to provide rooms, memberships, messages, reactions, receipts, pins, blocks, favorites,
invites, reminders, and realtime chat event handling behind one package.

## When To Use It

Use this package when your app needs:

- direct messages, group rooms, or broadcast rooms
- message history, reactions, unread counts, and room membership management
- realtime typing/read events and notification fan-out
- a chat domain that integrates with Slingshot auth, permissions, notifications, and entity tooling

Do not use it as a generic transport layer for unrelated product flows. It is a full chat domain,
not a low-level socket primitive.

## What You Need Before Wiring It In

This package is not standalone. `createChatPackage()` declares these dependencies:

- `slingshot-auth`
- `slingshot-notifications`
- `slingshot-permissions`

In practice that means:

- auth must establish who the caller is
- permissions must publish shared authorization state before chat starts
- notifications must be present before chat can publish notification side effects

## Minimum Setup

The required config is small but explicit:

- `storeType` is required and selects the persistence backend
- `mountPath` defaults to `/chat`
- `pageSize` defaults to `50`
- `enablePresence` defaults to `true`
- `encryption` is optional; omit it and the package does not apply package-managed at-rest encryption

## What You Get

The package owns more than route mounting:

- entity-backed chat domain (rooms, memberships, messages, reactions, receipts, pins, blocks,
  favorites, invites, reminders, scheduled messages) and their adapters
- permission-aware middleware for room creation, membership changes, archive/broadcast guards, and
  message side effects
- WebSocket incoming handlers for chat events
- notification hooks for message delivery and invitations
- unread-count and DM orchestration logic lifted into the entity-runtime adapter transforms and
  custom-op handlers
- plugin state published under `CHAT_PLUGIN_STATE_KEY` and the `ChatInteractionsPeerCap` capability
  for cross-package consumers
- an encryption router mounted at `${mountPath}/encryption`

Cross-package consumers should resolve `ChatInteractionsPeerCap` via `ctx.capabilities.require(...)`
rather than reading chat plugin state directly.

## Common Customization

The most important knobs are:

- `storeType`: choose `memory`, `redis`, `sqlite`, `postgres`, or `mongo`
- `tenantId`: fix chat to a tenant, or omit it to rely on the surrounding app
- `permissions`: role requirements for room creation, sending, deleting, pinning, and adding members
- `pageSize`: default pagination size for room message lists
- `enablePresence`: whether the live room channel publishes presence
- `encryption`: `provider: 'none'` or `provider: 'aes-gcm'`

If you need to change runtime behavior, start with:

- `src/plugin.ts` for package lifecycle and integrations
- `src/config.schema.ts` for supported config
- `src/ws/incoming.ts` for incoming realtime behavior
- `src/entities/runtime.ts` for adapter transforms and custom-op handlers

## Gotchas

- Register permissions and notifications before chat. The package throws during startup if either
  is missing.
- `tenantId` falls back to `'default'` in the package when omitted. Multi-tenant apps should be
  deliberate about whether that is correct.
- Omitting `encryption` does not produce encrypted storage. It means chat stores message payloads
  without package-managed encryption.
- The package starts reminder and scheduled-message loops on a 30-second interval during setup.
  That is expected runtime behavior, not test-only glue.
- Chat opportunistically integrates with other packages such as embeds, push, and interactions when
  they are present. Those integrations should remain additive, not hard dependencies.

## Key Files

- `src/index.ts`
- `src/plugin.ts`
- `src/public.ts`
- `src/config.schema.ts`
- `src/types.ts`
- `src/ws/incoming.ts`
- `src/entities/modules.ts`
- `src/entities/runtime.ts`
- `src/encryption/provider.ts`
