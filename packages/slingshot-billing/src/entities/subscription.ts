/**
 * Synced provider subscription state (`billing_subscriptions`).
 *
 * One row per provider subscription, upserted idempotently by `lib/sync.ts`
 * from signature-verified webhook events. This table — never a client claim or
 * a checkout redirect — is what the entitlement is derived from.
 *
 * **This entity deliberately has NO `routes` key** (precedent:
 * `slingshot-ai/src/entities/aiUsage.ts`): no generated HTTP surface.
 * Entitlement reads go through `BillingEntitlementCap`; writes go through the
 * webhook → `lib/sync.ts` path only.
 */
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';

export const BillingSubscriptionEntity = defineEntity('Subscription', {
  // `billing` + `Subscription` → table `billing_subscriptions`.
  namespace: 'billing',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    /** Owner the subscription belongs to (resolved via `billing_customers`). */
    ownerId: field.string(),
    /** Provider subscription id (e.g. Stripe `sub_...`) — the upsert key. */
    providerSubscriptionId: field.string(),
    /** Configured plan key mapped from `priceId`; `'free'` when the price is unknown. */
    plan: field.string(),
    /** Normalized lifecycle status (`SubscriptionStatus` in `lib/provider.ts`). */
    status: field.enum(['active', 'trialing', 'past_due', 'canceled'] as const),
    /** Provider price id backing the subscription; null when the event carried none. */
    priceId: field.string({ optional: true }),
    /** When the current paid period ends; null until the provider reports one. */
    currentPeriodEnd: field.date({ optional: true }),
    /** Whether the subscription is set to cancel at period end. */
    cancelAtPeriodEnd: field.boolean({ default: false }),
    /**
     * Provider event timestamp (epoch seconds) of the last applied event.
     * `lib/sync.ts` DROPS events older than this — Stripe does not guarantee
     * webhook delivery order.
     */
    providerEventCreated: field.integer(),
    createdAt: field.date({ default: 'now', immutable: true }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [
    // Entitlement derivation reads all of an owner's rows.
    index(['ownerId']),
    // The idempotent-upsert key for webhook sync.
    index(['providerSubscriptionId'], { unique: true }),
  ],
  // NO `routes` key — internal-only storage, no generated HTTP surface.
});
