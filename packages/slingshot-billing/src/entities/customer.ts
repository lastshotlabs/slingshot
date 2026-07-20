/**
 * The owner ↔ provider-customer mapping (`billing_customers`).
 *
 * One row per owner per provider, created lazily on first checkout. The webhook
 * sync path reads it in reverse (provider customer id → owner) to attribute
 * subscription and payment events to an app owner.
 *
 * **This entity deliberately has NO `routes` key** (precedent:
 * `slingshot-ai/src/entities/aiUsage.ts`): omitting it makes the framework
 * mount no router at all, so there is zero HTTP surface. Publishing CRUD over
 * provider customer ids would leak billing internals; all reads/writes go
 * through the package's own `BillingStore` seam (`src/lib/store.ts`).
 */
import { defineEntity, field, index } from '@lastshotlabs/slingshot-core';

export const BillingCustomerEntity = defineEntity('Customer', {
  // `billing` + `Customer` → table `billing_customers`.
  namespace: 'billing',
  fields: {
    id: field.string({ primary: true, default: 'uuid' }),
    /** Stable app-side owner identifier (user id by default; org id later). */
    ownerId: field.string(),
    /** Provider discriminator the customer belongs to, e.g. `'stripe'`. */
    provider: field.string(),
    /** Provider-side customer id (e.g. Stripe `cus_...`). */
    providerCustomerId: field.string(),
    createdAt: field.date({ default: 'now', immutable: true }),
    updatedAt: field.date({ default: 'now', onUpdate: 'now' }),
  },
  indexes: [
    // One provider customer per owner; webhook sync resolves owner by provider id.
    index(['ownerId'], { unique: true }),
    index(['providerCustomerId'], { unique: true }),
  ],
  // NO `routes` key — internal-only storage, no generated HTTP surface.
});
