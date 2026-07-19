/**
 * Provider abstraction for `slingshot-billing`.
 *
 * All billing routes, sync, and entitlement logic speak ONLY this interface plus
 * billing's own domain types — no provider SDK type ever leaks past this seam.
 * Stripe is the first implementation (`lib/providers/stripe.ts`, Phase 2); a
 * second provider slots in by satisfying `BillingProvider` with no refactor.
 */

/** Who a customer/subscription belongs to. Defaults to a user id; may later be an org. */
export interface OwnerRef {
  /** Stable owner identifier (user id by default). */
  readonly ownerId: string;
  /** Optional email to attach to the provider customer. */
  readonly email?: string;
}

/** A provider-side customer handle, persisted as `billing_customers`. */
export interface ProviderCustomer {
  /** Provider customer id (e.g. Stripe `cus_...`). */
  readonly providerCustomerId: string;
}

/** Redirect URLs a hosted checkout / portal session returns to. */
export interface CheckoutUrls {
  readonly successUrl: string;
  readonly cancelUrl: string;
}

/** Normalized subscription lifecycle status, provider-agnostic. */
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled';

/**
 * A provider webhook event normalized to billing's domain. `verifyAndParseWebhook`
 * returns one of these after a successful signature check; `lib/sync.ts` (Phase 2)
 * switches on `kind` without any provider-specific knowledge.
 */
export type ProviderEvent =
  | {
      readonly kind: 'subscription.updated';
      /** Provider customer id the subscription belongs to. */
      readonly providerCustomerId: string;
      readonly providerSubscriptionId: string;
      readonly priceId: string | null;
      readonly status: SubscriptionStatus;
      readonly currentPeriodEnd: string | null;
      readonly cancelAtPeriodEnd: boolean;
      /** Provider event timestamp (epoch seconds) for out-of-order drop. */
      readonly eventCreated: number;
    }
  | {
      readonly kind: 'subscription.deleted';
      readonly providerCustomerId: string;
      readonly providerSubscriptionId: string;
      readonly eventCreated: number;
    }
  | {
      readonly kind: 'payment.completed';
      /** Provider customer id, when the one-time payment had a customer. */
      readonly providerCustomerId: string | null;
      readonly providerPaymentId: string;
      readonly amount: number;
      readonly currency: string;
      readonly presetId: string | null;
      readonly eventCreated: number;
    }
  | {
      /** Any event billing does not act on; acknowledged (200) without side effects. */
      readonly kind: 'ignored';
      readonly eventCreated: number;
    };

/** Input to start a subscription checkout for a configured plan. */
export interface SubscriptionCheckoutInput {
  readonly customer: ProviderCustomer;
  readonly priceId: string;
  readonly trialDays?: number;
  readonly urls: CheckoutUrls;
}

/** Input to start a one-time donation checkout. */
export interface DonationCheckoutInput {
  readonly customer?: ProviderCustomer;
  readonly amount: number;
  readonly currency: string;
  readonly presetId?: string;
  readonly urls: CheckoutUrls;
}

/** Input to open a self-service billing portal session. */
export interface PortalInput {
  readonly customer: ProviderCustomer;
  readonly returnUrl: string;
}

/** A hosted-page URL the caller redirects the user to. */
export interface HostedSession {
  readonly url: string;
}

/**
 * The provider contract. Implementations are stateless wrappers over a payment
 * SDK; persistence, entitlement derivation, and event emission live in the
 * package, not here.
 */
export interface BillingProvider {
  /** Provider discriminator, e.g. `'stripe'`. */
  readonly name: string;
  /** Find or create the provider customer for an owner. */
  ensureCustomer(owner: OwnerRef): Promise<ProviderCustomer>;
  /** Create a hosted subscription checkout session for a configured price. */
  createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<HostedSession>;
  /** Create a hosted one-time donation checkout session. */
  createDonationCheckout(input: DonationCheckoutInput): Promise<HostedSession>;
  /** Create a hosted self-service billing portal session. */
  createPortalSession(input: PortalInput): Promise<HostedSession>;
  /**
   * Verify a raw webhook body's signature and return the normalized event.
   * MUST throw when the signature is invalid — callers translate that to 400.
   */
  verifyAndParseWebhook(rawBody: string, headers: Headers): ProviderEvent;
}
