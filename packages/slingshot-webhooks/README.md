---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-webhooks
---

> Human-owned documentation. This is the authoritative lane for package boundaries, constraints, and operational guidance.

## Purpose

`@lastshotlabs/slingshot-webhooks` owns outbound webhook endpoint management, scoped delivery, and
inbound provider intake. It does not own the event universe. Event owners define what is externally
deliverable through the registry, and this package projects those definitions onto subscribers.
The webhook entities themselves follow the shared package-first/entity authoring model;
`createWebhookPlugin()` is the runtime shell that composes delivery and intake wiring.

## Package Boundaries

- Own endpoint persistence, delivery orchestration, retry state, and inbound provider hooks.
- Consume `slingshot-core` event definitions, event envelopes, and subscriber authorization rules.
- Stay policy-aware at the boundary but transport-light underneath. Queue implementations should carry projected payloads and subscriber metadata, not rebuild authorization later.
- Do not reintroduce a webhook-owned default event universe, string allowlist API, or cross-tenant widening path.

## Operational Notes

- Webhook management routes now fail closed. Configure `adminGuard` unless you explicitly disable the endpoints route group.
- Manifest mode can resolve the webhook adapter from `store` when you cannot pass a live adapter instance. Use handler refs for `adminGuard`, custom queues, and inbound providers.
- Webhook endpoint URLs must use `http:` or `https:`. Non-HTTP schemes are rejected at validation time.
- HTTP responses fully redact stored webhook secrets. The runtime adapter still holds the raw secret internally for signing deliveries.
- Management writes use `subscriptions`, not legacy `events`. Each entry is either `{ event }` or `{ pattern }`, and patterns are normalized up front into concrete approved event keys.
- Endpoint records now carry `ownerType`, `ownerId`, optional `tenantId`, and normalized `subscriptions`. Delivery records preserve `eventId`, `occurredAt`, subscriber identity, and source scope.
- Existing legacy rows are normalized at startup. If stored subscriptions cannot be resolved safely, the endpoint is disabled rather than widened.
- HTTP delivery timeout is configurable via the plugin-wide `deliveryTimeoutMs` (default 30000) and the per-endpoint `deliveryTimeoutMs` override. Both are bounded to a hard 120000 ms ceiling to keep stuck deliveries from monopolising queue workers.
- Inbound webhook routes enforce a maximum request body size via `inboundMaxBodyBytes` (default 1 MiB). Oversized requests are rejected with `413 Payload Too Large` before any provider parsing runs. Raise this only when a known provider posts larger payloads.

## Gotchas

- Plugin config still has an `events` field, but that is only the webhook plugin's own intake filter on the app bus. It is not the endpoint-management payload shape.
- Future plugin event registrations do not silently expand existing endpoint subscriptions. Concrete event subscriptions stay frozen until an endpoint is updated explicitly.
- Delivery attempts time out after `endpoint.deliveryTimeoutMs` (when set), otherwise `config.deliveryTimeoutMs`, otherwise 30 s. Both knobs accept a positive integer up to 120000 ms (2 min); larger values are rejected at validation time. Timeouts surface as retryable delivery failures.
- If enqueueing a delivery fails, the delivery record is immediately marked `dead`. If that status update itself fails, the error is logged but does not propagate — the event handler always returns cleanly.

## Key Files

- `packages/slingshot-webhooks/src/index.ts`
- `packages/slingshot-webhooks/src/manifest/runtime.ts`
- `packages/slingshot-webhooks/src/lib/eventWiring.ts`
