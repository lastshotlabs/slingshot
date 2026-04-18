---
title: Human Guide
description: Human-maintained guidance for @lastshotlabs/slingshot-webhooks
---

> Human-owned documentation. This is the authoritative lane for package boundaries, constraints, and operational guidance.

## Purpose

@lastshotlabs/slingshot-webhooks is the feature package in the Slingshot workspace.

Package documentation for this Slingshot workspace module.

## Package Boundaries

- Document which responsibilities this package owns.
- Call out which contracts come from `slingshot-core` or neighboring packages.
- Keep package-specific examples here instead of hiding them in the root docs.

## Operational Notes

- Add startup requirements, debugging tips, and failure modes.
- Record migrations when config shapes or lifecycle timing changes.
- Webhook management routes now fail closed. Configure `adminGuard` unless you explicitly disable the endpoints route group.
- Manifest mode can resolve the webhook adapter from `store` when you cannot pass a live adapter instance. Use handler refs for `adminGuard`, custom queues, and inbound providers.
- Webhook endpoint URLs must use `http:` or `https:`. Non-HTTP schemes are rejected at validation time.
- Webhook endpoints must always keep at least one subscribed event. To pause delivery, set `status: 'disabled'` instead of sending an empty `events` array on update.

## Gotchas

- Record edge cases that surprised us.

## Key Files

- `packages/slingshot-webhooks/src/index.ts`
