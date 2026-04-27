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

## Key Files

- `src/plugin.ts`
- `src/router.ts`
- `src/types/config.ts`
- `src/providers/web.ts`, `src/providers/apns.ts`, `src/providers/fcm.ts`
- `src/formatter.ts`
- `src/deliveryAdapter.ts`
