import type { PluginSetupContext, SlingshotPackageDefinition } from '@lastshotlabs/slingshot-core';
import {
  deepFreeze,
  defineEvent,
  definePackage,
  provideCapability,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { entity } from '@lastshotlabs/slingshot-entity';
import { BillingCustomerEntity } from './entities/customer';
import { BillingPaymentEntity } from './entities/payment';
import { BillingSubscriptionEntity } from './entities/subscription';
import { deriveEntitlement } from './lib/entitlement';
import { BillingEntitlementCap, FREE_ENTITLEMENT } from './public';
import type { Entitlement } from './public';
import type { BillingPackageConfig } from './types/config';
import { billingPackageConfigSchema, isBillingConfigured } from './types/config';

/** Stable identifier for this package; used as the contract/event owner name. */
export const BILLING_PACKAGE_NAME = 'slingshot-billing';

/**
 * Create the billing package: provider-abstracted subscriptions, trials, and
 * one-time donations, exposing an app-agnostic entitlement capability + events.
 *
 * Dormant by default: with no `provider` configured, the (future) checkout /
 * donate / portal routes return 503 and the entitlement capability resolves to
 * {@link FREE_ENTITLEMENT}. Adding the package without Stripe keys changes
 * nothing for the host app.
 *
 * Phase 1 scaffolds the surface only — entities, the Stripe implementation, the
 * routes, and the signature-verified webhook land in later phases.
 *
 * @param rawConfig - Partial billing configuration; validated + frozen.
 * @returns A `SlingshotPackageDefinition` ready for `createApp({ packages })`.
 */
export function createBillingPackage(
  rawConfig: Partial<BillingPackageConfig> = {},
): SlingshotPackageDefinition {
  const config = deepFreeze(
    validatePluginConfig(BILLING_PACKAGE_NAME, rawConfig, billingPackageConfigSchema),
  );

  const configured = isBillingConfigured(config);
  const webhookPath = `${config.mountPath}/webhooks/stripe`;

  /**
   * Resolve an owner's current entitlement. Still a stub: Phase 5 feeds the
   * owner's stored `billing_subscriptions` rows into `deriveEntitlement` (and
   * takes the ownerId the capability contract already declares); until then
   * the pure derivation runs over an empty row set (⇒ free/none).
   */
  const resolveEntitlement = async (): Promise<Entitlement> => {
    if (!configured) return FREE_ENTITLEMENT;
    return deriveEntitlement([], config.plans);
  };

  return definePackage({
    name: BILLING_PACKAGE_NAME,
    mountPath: config.mountPath,
    dependencies: ['slingshot-auth'],
    // Standard-wired, internal-only entities: none declares a `routes` key, so
    // no CRUD surface is mounted (precedent: slingshot-ai's usage ledger). The
    // CLI's migrate discovery walks this array to generate `billing_*` tables;
    // runtime access goes through the `BillingStore` seam (`lib/store.ts`).
    entities: [
      entity({ config: BillingCustomerEntity }),
      entity({ config: BillingSubscriptionEntity }),
      entity({ config: BillingPaymentEntity }),
    ],
    // The Stripe webhook is an unauthenticated, server-to-server POST verified by
    // signature, so it must bypass tenant/auth gating and CSRF. Declared here so
    // the framework auto-merges it — the host app needs no config edit.
    publicPaths: [webhookPath],
    csrfExemptPaths: [webhookPath],
    capabilities: {
      provides: [provideCapability(BillingEntitlementCap, () => resolveEntitlement)],
    },
    setupMiddleware({ events }: PluginSetupContext) {
      if (!events.get('billing:entitlement.changed')) {
        events.register(
          defineEvent('billing:entitlement.changed', {
            ownerPlugin: BILLING_PACKAGE_NAME,
            exposure: ['internal'],
            resolveScope: () => null,
          }),
        );
      }
      if (!events.get('billing:payment.completed')) {
        events.register(
          defineEvent('billing:payment.completed', {
            ownerPlugin: BILLING_PACKAGE_NAME,
            exposure: ['internal'],
            resolveScope: () => null,
          }),
        );
      }
    },
    setupRoutes() {
      // Phase 3/4: checkout, donate, portal, entitlement, and the Stripe webhook.
    },
  });
}
