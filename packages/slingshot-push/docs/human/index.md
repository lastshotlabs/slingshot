---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-push
---

`@lastshotlabs/slingshot-push` is Slingshot's multi-provider push delivery plugin. It manages
device subscriptions, topic fan-out, delivery records, and provider dispatch for Web Push (VAPID),
iOS (APNS), and Android (FCM).
The push entities themselves follow the shared package-first/entity authoring model;
`createPushPlugin()` is the runtime shell that composes routing, providers, and manifest wiring.

## What It Owns

- Push subscription, topic, topic-membership, and delivery entities
- Per-platform provider wiring (web-push, APNS, FCM)
- Subscription management routes (`/topics/:name/subscribe`, `/topics/:name/unsubscribe`, `/ack/:deliveryId`)
- VAPID public-key endpoint for web clients (`/vapid-public-key`)
- A delivery adapter that auto-registers with `slingshot-notifications` when that plugin is present

## Dependencies

- `slingshot-auth` — required; all subscription routes require an authenticated user
- `slingshot-notifications` — optional; when present, the delivery adapter is registered automatically

## Minimum Setup

```ts
createPushPlugin({
  enabledPlatforms: ['web'],
  web: { vapid: { publicKey: '...', privateKey: '...', subject: 'mailto:push@example.com' } },
});
```

For iOS, add `ios: { auth: { kind: 'p8-token', keyPem: '...', keyId: 'ABC123', teamId: 'TEAM123456' } }`.

For Android, add `android: { serviceAccount: { project_id: '...', client_email: '...', private_key: '...' } }`.
The `serviceAccount` value can also be a JSON string or a `file://` path read at boot time.

## Operational Notes

- `mountPath` must start with `/`; trailing slashes are trimmed before routes are mounted.
- All push routes are declared CSRF-exempt because service workers cannot attach CSRF tokens.
- The VAPID public-key endpoint is a public path — no auth guard applies.
- Topics are auto-created when a device subscribes to a named topic for the first time.
- When `slingshot-notifications` is present, the delivery adapter registers itself automatically
  during `setupPost`. No manual wiring is needed.
- The Android `serviceAccount` field can be an inline object, a JSON string, or a `file://` URI
  resolved at startup. Prefer environment variables for key material rather than inlining in config.
- Retry policy applies to delivery attempts, not to subscription management operations.
- When a provider send succeeds, the delivery record transitions through `sent` → `delivered`
  automatically. The `/ack/:deliveryId` endpoint is for client-side acknowledgement (e.g., a
  service worker confirming the notification was shown); it moves the record to `delivered` from
  the client side. Both paths are now wired.

### All-providers-fail contract

`router.sendToUser`, `sendToUsers`, and `publishTopic` never throw when every provider
returns a failure result — total failure is reported in the return value, not via an exception.
Each call resolves to `{ delivered, attempted, allFailed }`: `delivered` is the number of
successful sends, `attempted` is the number of subscriptions whose platform had a configured
provider, and `allFailed` is `true` iff `attempted > 0 && delivered === 0`. Callers that need
to branch on total failure should check `result.allFailed` directly rather than inspecting
`push:delivery.failed` bus events. A user with no subscriptions, or one whose subs all map to
unconfigured platforms, returns `{ delivered: 0, attempted: 0, allFailed: false }` — that is
not a failure, just nothing to deliver. Per-subscription failures continue to surface via
`push:delivery.failed` bus events for observability.

## Gotchas

- `enabledPlatforms` controls which providers are wired and which entities are active. Listing a
  platform without supplying its config will fail validation.
- VAPID keys should be generated once and stored durably. Rotating them invalidates all existing
  web-push subscriptions.
- Push routes use `requireUserAuth` middleware that reads `actor.id` from the resolved auth context.
  The push plugin does not expose a service-to-service push route — delivery is handled through
  the router, not the HTTP surface.
- `slingshot-push` does not send push notifications directly on topic subscribe/unsubscribe. Those
  routes only manage membership records. Actual delivery is triggered through the notifications
  dispatcher or direct router calls.
- Topic fan-out is capped at 10,000 members per publish call. Topics exceeding this threshold
  will log a warning and deliver only to the first 10,000. Use a cursor-paginated delivery loop
  outside the plugin for topics that require full-membership delivery.

## Key Files

- `src/plugin.ts`
- `src/router.ts`
- `src/types/config.ts`
- `src/providers/web.ts`, `src/providers/apns.ts`, `src/providers/fcm.ts`
- `src/formatter.ts`
- `src/deliveryAdapter.ts`
