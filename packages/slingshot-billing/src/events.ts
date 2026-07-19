import type { Entitlement } from './public';

/** Payload for `billing:entitlement.changed` — an owner's entitlement was (re)computed. */
export interface BillingEntitlementChangedPayload {
  readonly ownerId: string;
  readonly entitlement: Entitlement;
}

/** Payload for `billing:payment.completed` — a one-time payment/donation settled. */
export interface BillingPaymentCompletedPayload {
  readonly ownerId: string | null;
  readonly amount: number;
  readonly currency: string;
  readonly presetId?: string;
}

declare module '@lastshotlabs/slingshot-core' {
  interface SlingshotEventMap {
    'billing:entitlement.changed': BillingEntitlementChangedPayload;
    'billing:payment.completed': BillingPaymentCompletedPayload;
  }
}

export {};
