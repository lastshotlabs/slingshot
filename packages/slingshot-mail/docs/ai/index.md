---
title: AI Draft
description: AI-assisted summary for @lastshotlabs/slingshot-mail
---

> AI-assisted draft. Use this page as the quick orientation layer for the mail package.

## Summary

`@lastshotlabs/slingshot-mail` is the event-driven mail delivery package in the Slingshot workspace. It
combines three concerns that stay intentionally separate in the code: delivery providers,
template renderers, and queues.

The package does not need routes or middleware. Its plugin participates in `setupPost`, starts the
configured queue, optionally validates templates and provider health, and wires event-bus
subscriptions into queued mail sends.

## What This Package Owns

- provider factories such as Resend, SES, Postmark, and SendGrid
- renderer factories such as raw HTML and React Email
- queue implementations including an in-memory default and a BullMQ-backed queue
- subscription wiring from Slingshot events to mail jobs

## Common Flows

- create a provider and renderer, then pass them to `createMailPlugin()`
- add `subscriptions` when mail should react to Slingshot events instead of only being sent manually
- enable durable subscriptions only when the backing event transport actually supports them

## Good Follow-Up

The missing docs gap here is examples. This package needs one clear example per provider or
renderer style more than it needs more conceptual prose.
