# slingshot-billing

Provider-abstracted billing: subscriptions (with trials), one-time donations, and a small
**entitlement** surface that answers one question — _what has this owner paid for right now?_ —
so consuming apps map plans onto their own domain (a spend tier, a perk, ...).

## When to use

Add `createBillingPackage(...)` to `packages:` when an app needs paid plans or donations. It owns
the payment plumbing (customer mapping, Checkout, Billing Portal, a signature-verified webhook,
subscription sync) once, across every fleet app.

## Minimum setup

```ts
import { createBillingPackage } from '@lastshotlabs/slingshot-billing';

export default defineApp({
  plugins: [createAuthPlugin({ ... })],
  packages: [
    createBillingPackage({
      provider: { name: 'stripe', secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET },
      plans: [{ key: 'pro', priceId: env.STRIPE_PRICE_PRO, trialDays: 14 }],
      donations: { enabled: true, currency: 'usd', presets: [{ id: 'coffee', amount: 500 }] },
      urls: { checkoutSuccess, checkoutCancel, portalReturn },
    }),
  ],
});
```

**Dormant by default:** omit `provider` and every route returns 503 while the entitlement resolves
to `free` — safe to add before Stripe is configured.

## Consuming the entitlement

```ts
const entitlement = await ctx.capabilities.require(BillingEntitlementCap)(ownerId);
// or react to writes:
bus.on('billing:entitlement.changed', ({ ownerId, entitlement }) => {
  /* map plan -> your domain */
});
```

> Phase 1 scaffold. Entities, the Stripe implementation, routes, and the webhook land in later phases
> (see `slingshot-specs/specs/feature.billing.md`).
