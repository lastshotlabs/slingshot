import type { Entitlement } from './public';

/**
 * Payload for `billing:entitlement.changed` — an owner's derived entitlement
 * actually changed after a verified webhook event was synced.
 *
 * Delivery is fire-and-forget (the bus swallows and logs handler throws), so
 * consumers treat this as a cache-invalidation hint and reconcile via
 * `BillingEntitlementCap` on read.
 */
export interface BillingEntitlementChangedPayload {
  /** The app-side owner (user id by default) whose entitlement changed. */
  readonly ownerId: string;
  /** The full recomputed entitlement — always equals a fresh capability read. */
  readonly entitlement: Entitlement;
}

/** Payload for `billing:payment.completed` — a one-time payment/donation settled. */
export interface BillingPaymentCompletedPayload {
  /** Owner who paid, or null when the payment could not be attributed. */
  readonly ownerId: string | null;
  /** Amount in the smallest currency unit (e.g. 500 = $5.00). */
  readonly amount: number;
  /** ISO 4217 currency code (lowercase), e.g. `'usd'`. */
  readonly currency: string;
  /** Configured donation preset id, when one was used. */
  readonly presetId?: string;
}

declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    'billing:entitlement.changed': BillingEntitlementChangedPayload;
    'billing:payment.completed': BillingPaymentCompletedPayload;
  }
}

export {};
