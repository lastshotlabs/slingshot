---
title: AI Draft
description: AI-assisted starting point for @lastshotlabs/slingshot-billing
---

> AI-assisted draft. Use this page for fast orientation, then harden important details in the human guide.

## Summary

@lastshotlabs/slingshot-billing is the provider-abstracted billing feature package in the
Slingshot workspace: subscriptions (with trials), one-time donations, hosted Checkout/Portal, a
signature-verified Stripe webhook, and a domain-agnostic entitlement surface
(`BillingEntitlementCap` + `billing:entitlement.changed` / `billing:payment.completed` events).
Dormant unless a provider is configured.

## Quick Map

- Package kind: Workspace package
- Public exports: `.`, `./public`, `./config`
- Factory: `createBillingPackage(config)` for `createApp({ packages })`
- Provider seam: `BillingProvider` (`src/lib/provider.ts`); Stripe impl in `src/lib/providers/stripe.ts`
- Entities (internal-only, no HTTP surface): `billing_customers`, `billing_subscriptions`, `billing_payments`
- API reference: /api/slingshot-billing/

## What To Clarify Next

- Read `docs/human/index.md` for the binding semantics: dormant gate, webhook status contract,
  sync idempotency/ordering, and the reconcile-on-read rule for event consumers.
- Full design and phase history: `slingshot-specs/specs/feature.billing.md`.
