/**
 * One-time payments — donations (`billing_payments`).
 *
 * One row per settled one-time checkout, inserted idempotently by
 * `lib/sync.ts` keyed on `providerPaymentId`. A payment is a one-time signal
 * surfaced via `billing:payment.completed`; it NEVER alters the subscription
 * entitlement (an app granting a "supporter" perk reacts to the event itself).
 *
 * **This entity deliberately has NO `routes` key** (precedent:
 * `slingshot-ai/src/entities/aiUsage.ts`): no generated HTTP surface — a
 * public payments feed would leak who donated what.
 */
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';

export const BillingPaymentEntity = defineEntity('Payment', {
  // `billing` + `Payment` → table `billing_payments`.
  namespace: 'billing',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    /** Owner who paid; null for anonymous donations (no known provider customer). */
    ownerId: field.string({ optional: true }),
    /** Provider payment id (e.g. Stripe `pi_...`) — the idempotent-insert key. */
    providerPaymentId: field.string(),
    /** Payment kind. Only one-time donations exist today. */
    kind: field.enum(['donation'] as const, { default: 'donation' }),
    /** Amount in the smallest currency unit (integer cents; 500 = $5.00). */
    amount: field.integer(),
    /** ISO 4217 currency code (lowercase), e.g. `'usd'`. */
    currency: field.string(),
    /** Configured donation preset id when one was used; null for custom amounts. */
    presetId: field.string({ optional: true }),
    /** Settlement status. Rows are only written for completed payments (`'succeeded'`). */
    status: field.string(),
    createdAt: field.date({ default: 'now', immutable: true }),
  },
  indexes: [
    // The idempotent-insert key for webhook sync.
    index(['providerPaymentId'], { unique: true }),
  ],
  // NO `routes` key — internal-only storage, no generated HTTP surface.
});
