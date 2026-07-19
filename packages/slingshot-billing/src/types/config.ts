import { z } from 'zod';
import { assertMountPath } from '@lastshotlabs/slingshot-core';

/** Trim trailing slashes and validate a mount path prefix. */
function normalizeMountPath(value: string): string {
  const trimmed = value.trim();
  assertMountPath('slingshot-billing', trimmed);
  const normalized = trimmed.replace(/\/+$/, '');
  if (normalized.length === 0) {
    throw new Error("[slingshot-billing] mountPath must not be '/'");
  }
  return normalized;
}

/**
 * Stripe provider credentials. Source `secretKey`/`webhookSecret` from the host
 * app's environment / framework secrets — never hard-code them. When the whole
 * `provider` block is omitted, billing runs dormant (checkout/donate/portal
 * return 503, the webhook is not mounted, every entitlement resolves to free).
 */
export const stripeProviderConfigSchema = z.object({
  name: z.literal('stripe').describe("Provider discriminator. Currently only 'stripe'."),
  secretKey: z
    .string()
    .min(1)
    .describe('Stripe secret API key (sk_...). Source from env/secrets, not source control.'),
  webhookSecret: z
    .string()
    .min(1)
    .describe('Stripe webhook signing secret (whsec_...) used to verify inbound events.'),
  apiVersion: z
    .string()
    .optional()
    .describe('Optional pinned Stripe API version. Omit to use the SDK default.'),
});

/** One configured subscription plan mapped to a provider price. `free` is implicit. */
export const planConfigSchema = z.object({
  key: z
    .string()
    .min(1)
    .describe("App-facing plan key (e.g. 'pro'). Reported as `Entitlement.plan`."),
  priceId: z.string().min(1).describe('Provider price id the checkout session subscribes to.'),
  trialDays: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Optional free-trial length in days applied at subscription checkout.'),
});

/** A fixed one-time donation amount, in the smallest currency unit (e.g. cents). */
export const donationPresetSchema = z.object({
  id: z.string().min(1).describe('Stable preset id the donate route accepts.'),
  amount: z
    .number()
    .int()
    .positive()
    .describe('Amount in the smallest currency unit (e.g. 500 = $5.00).'),
});

/** One-time donation configuration. Disabled by default. */
export const donationsConfigSchema = z
  .object({
    enabled: z.boolean().default(false).describe('Whether the donation checkout route is active.'),
    currency: z
      .string()
      .length(3)
      .default('usd')
      .describe('ISO 4217 currency code for donations (lowercase). Default: usd.'),
    presets: z
      .array(donationPresetSchema)
      .optional()
      .describe('Fixed donation amounts offered to the user.'),
    allowCustomAmount: z
      .object({
        min: z.number().int().positive().describe('Minimum custom amount, smallest currency unit.'),
        max: z.number().int().positive().describe('Maximum custom amount, smallest currency unit.'),
      })
      .optional()
      .describe(
        'Bounds for a user-entered custom donation amount. Omit to disallow custom amounts.',
      ),
    requireAuth: z
      .boolean()
      .default(true)
      .describe('Whether donations require a signed-in user. Default: true.'),
  })
  .default({ enabled: false, currency: 'usd', requireAuth: true });

/** Absolute app URLs Checkout / Portal redirect back to. */
export const billingUrlsConfigSchema = z.object({
  checkoutSuccess: z
    .string()
    .url()
    .describe('Absolute URL Stripe returns to after a successful checkout.'),
  checkoutCancel: z
    .string()
    .url()
    .describe('Absolute URL Stripe returns to when checkout is cancelled.'),
  portalReturn: z.string().url().describe('Absolute URL the Billing Portal returns to.'),
});

/** Runtime schema validating `createBillingPackage()` configuration. */
export const billingPackageConfigSchema = z.object({
  mountPath: z
    .string()
    .default('/billing')
    .transform(value => normalizeMountPath(value))
    .describe("URL path prefix for billing routes. Must start with '/'. Default: /billing."),
  provider: stripeProviderConfigSchema
    .optional()
    .describe('Payment provider credentials. Omit to run billing dormant (unconfigured).'),
  plans: z
    .array(planConfigSchema)
    .default([])
    .describe('Subscription plans mapped to provider prices. Empty ⇒ no paid plans.'),
  donations: donationsConfigSchema.describe('One-time donation configuration.'),
  urls: billingUrlsConfigSchema
    .optional()
    .describe('Checkout / Portal redirect URLs. Required once a provider is configured.'),
});

/** Validated, inferred configuration shape accepted by `createBillingPackage()`. */
export type BillingPackageConfig = z.infer<typeof billingPackageConfigSchema>;
export type StripeProviderConfig = z.infer<typeof stripeProviderConfigSchema>;
export type PlanConfig = z.infer<typeof planConfigSchema>;
export type DonationsConfig = z.infer<typeof donationsConfigSchema>;

/**
 * Whether billing has a usable provider configured. When false the package is
 * "dormant": routes short-circuit to 503 and the entitlement capability yields
 * a free/none entitlement. This is the single gate every runtime path consults.
 */
export function isBillingConfigured(config: BillingPackageConfig): boolean {
  return (
    config.provider !== undefined &&
    config.provider.secretKey.length > 0 &&
    config.provider.webhookSecret.length > 0
  );
}
