import './events';

/** Create the billing package for `createApp({ packages })`. */
export { createBillingPackage, BILLING_PACKAGE_NAME } from './plugin';

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
