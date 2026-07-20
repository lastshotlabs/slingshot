import './events';

/** Create the billing package for `createApp({ packages })`. */
export { createBillingPackage, BILLING_PACKAGE_NAME } from './plugin';
/** Test-only construction seam (provider injection); not app configuration. */
export type { BillingPackageInternals } from './plugin';

/** Provider-owned contract, entitlement capability, and the free-entitlement constant. */
export { Billing, BillingEntitlementCap, FREE_ENTITLEMENT } from './public';
/** Entitlement shape and status union surfaced to consuming apps. */
export type { Entitlement, EntitlementStatus } from './public';

/** Config schema + `isBillingConfigured` dormant-gate helper. */
export { billingPackageConfigSchema, isBillingConfigured } from './types/config';
/** Inferred configuration types accepted by `createBillingPackage()`. */
export type {
  BillingPackageConfig,
  StripeProviderConfig,
  PlanConfig,
  DonationsConfig,
} from './types/config';

/** Provider abstraction: implement `BillingProvider` to add a payment backend. */
export type {
  BillingProvider,
  ProviderEvent,
  ProviderCustomer,
  OwnerRef,
  SubscriptionStatus,
  SubscriptionCheckoutInput,
  DonationCheckoutInput,
  PortalInput,
  HostedSession,
  CheckoutUrls,
} from './lib/provider';

/** Event payload types published on the bus. */
export type { BillingEntitlementChangedPayload, BillingPaymentCompletedPayload } from './events';

/** Stripe provider implementation + the structurally-typed event normalizer. */
export { createStripeProvider, normalizeStripeEvent } from './lib/providers/stripe';
export type { StripeEventLike } from './lib/providers/stripe';

/** Pure entitlement derivation over stored subscription rows. */
export { deriveEntitlement, entitlementEquals, planKeyForPrice } from './lib/entitlement';

/** Provider-agnostic webhook sync (idempotent, order-tolerant). */
export { syncProviderEvent } from './lib/sync';
export type { SyncNoopReason, SyncOutcome } from './lib/sync';

/** Storage seam: narrow store interface + the entity-adapter-backed implementation. */
export { createEntityBillingStore } from './lib/store';
export type {
  BillingCustomerInput,
  BillingCustomerRow,
  BillingEntityAdapter,
  BillingEntityAdapters,
  BillingPaymentInput,
  BillingPaymentRow,
  BillingStore,
  BillingSubscriptionInput,
  BillingSubscriptionPatch,
  BillingSubscriptionRow,
} from './lib/store';

/** Entity definitions (tables `billing_customers` / `billing_subscriptions` / `billing_payments`). */
export { BillingCustomerEntity } from './entities/customer';
export { BillingSubscriptionEntity } from './entities/subscription';
export { BillingPaymentEntity } from './entities/payment';
