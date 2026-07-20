import type { MiddlewareHandler } from 'hono';
import type {
  AppEnv,
  PluginSetupContext,
  SlingshotPackageDefinition,
} from '@lastshotlabs/slingshot-core';
import {
  createRouter,
  deepFreeze,
  defineEvent,
  definePackage,
  getActorId,
  getRouteAuthOrNull,
  maybeEntityAdapter,
  provideCapability,
  validatePluginConfig,
} from '@lastshotlabs/slingshot-core';
import { entity } from '@lastshotlabs/slingshot-entity';
import { BillingCustomerEntity } from './entities/customer';
import { BillingPaymentEntity } from './entities/payment';
import { BillingSubscriptionEntity } from './entities/subscription';
import { deriveEntitlement } from './lib/entitlement';
import type { BillingProvider } from './lib/provider';
import { createStripeProvider } from './lib/providers/stripe';
import type { BillingEntityAdapter, BillingStore } from './lib/store';
import { createEntityBillingStore } from './lib/store';
import { BillingEntitlementCap, FREE_ENTITLEMENT } from './public';
import type { Entitlement } from './public';
import type { BillingRouteDeps } from './routes/_shared';
import { registerCheckoutRoute } from './routes/checkout';
import { registerDonateRoute } from './routes/donate';
import { registerEntitlementRoute } from './routes/entitlement';
import { registerPortalRoute } from './routes/portal';
import { registerWebhookRoute } from './routes/webhook';
import type { BillingPackageConfig } from './types/config';
import { billingPackageConfigSchema, isBillingConfigured } from './types/config';

/** Stable identifier for this package; used as the contract/event owner name. */
export const BILLING_PACKAGE_NAME = 'slingshot-billing';

/**
 * Internal construction seam for {@link createBillingPackage}.
 *
 * Not part of the app-facing configuration surface: tests inject a
 * `FakeBillingProvider` here so the full route/lifecycle stack runs without
 * the Stripe SDK. Production apps never pass this.
 */
export interface BillingPackageInternals {
  /** Provider override; when set, `createStripeProvider` is never constructed. */
  readonly provider?: BillingProvider;
}

/**
 * Create the billing package: provider-abstracted subscriptions, trials, and
 * one-time donations, exposing an app-agnostic entitlement capability + events.
 *
 * Dormant by default: with no `provider` configured, the checkout / donate /
 * portal routes return 503 `billing_unavailable` and the entitlement
 * capability (and `GET /billing/entitlement`) resolves to
 * {@link FREE_ENTITLEMENT}. Adding the package without Stripe keys changes
 * nothing for the host app.
 *
 * The client-facing routes (checkout, donate, portal, entitlement) mount
 * through the framework's typed OpenAPI router; the signature-verified Stripe
 * webhook is a plain (non-OpenAPI) POST mounted only when billing is
 * configured — dormant apps expose no webhook surface at all.
 *
 * @param rawConfig - Partial billing configuration; validated + frozen.
 * @param internals - Test-only construction seam ({@link BillingPackageInternals}).
 * @returns A `SlingshotPackageDefinition` ready for `createApp({ packages })`.
 */
export function createBillingPackage(
  rawConfig: Partial<BillingPackageConfig> = {},
  internals: BillingPackageInternals = {},
): SlingshotPackageDefinition {
  const config = deepFreeze(
    validatePluginConfig(BILLING_PACKAGE_NAME, rawConfig, billingPackageConfigSchema),
  );

  const configured = isBillingConfigured(config);
  const webhookPath = `${config.mountPath}/webhooks/stripe`;

  // The provider is only ever constructed behind the dormant gate, and lazily —
  // building the Stripe wrapper performs no I/O, but a dormant app must not
  // even reach the SDK module's construction path.
  let provider: BillingProvider | null = internals.provider ?? null;
  const getProvider = (): BillingProvider | null => {
    if (provider) return provider;
    if (!configured || !config.provider) return null;
    provider = createStripeProvider(config.provider);
    return provider;
  };

  // The store materializes once the framework publishes the billing entity
  // adapters (during the entity plugin's `setupRoutes`, i.e. before this
  // package's own `setupRoutes` under `compilePackages()` ordering). Routes and
  // the capability read it through this mutable ref so they always observe the
  // latest resolution.
  let store: BillingStore | null = null;
  const resolveStoreFrom = (app: PluginSetupContext['app']): void => {
    if (store) return;
    const lookup = (entityName: string): BillingEntityAdapter | null =>
      maybeEntityAdapter<BillingEntityAdapter>(app, {
        plugin: BILLING_PACKAGE_NAME,
        entity: entityName,
      });
    const customers = lookup('Customer');
    const subscriptions = lookup('Subscription');
    const payments = lookup('Payment');
    if (customers && subscriptions && payments) {
      store = createEntityBillingStore({ customers, subscriptions, payments });
    }
  };

  /**
   * Resolve an owner's current entitlement — the DB-backed derivation: the
   * owner's stored `billing_subscriptions` rows through `deriveEntitlement`.
   * Dormant (or before the entity adapters resolve, which cannot happen after
   * `setupPost`) this yields the free entitlement.
   */
  const resolveEntitlement = async (ownerId: string): Promise<Entitlement> => {
    if (!configured || !store) return FREE_ENTITLEMENT;
    return deriveEntitlement(await store.listSubscriptionsByOwner(ownerId), config.plans);
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
    setupRoutes({ app, bus }: PluginSetupContext) {
      // Entity adapters publish during the entity plugin's `setupRoutes`, which
      // `compilePackages()` runs immediately before this hook — resolve now,
      // with a `setupPost` backstop below.
      resolveStoreFrom(app);

      // Lazy per-request auth: the RouteAuthRegistry is registered by
      // slingshot-auth (a declared dependency), but resolving it at request
      // time keeps this package independent of registration ordering — the
      // pattern `slingshot-push` / `slingshot-organizations` use to avoid a
      // hard import of the auth package.
      const requireUserAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
        const routeAuth = getRouteAuthOrNull(app);
        if (!routeAuth?.userAuth) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        return routeAuth.userAuth(c, async () => {
          if (!getActorId(c)) {
            c.res = c.json({ error: 'Unauthorized' }, 401);
            return;
          }
          if (routeAuth.postGuards) {
            for (const guard of routeAuth.postGuards) {
              const failure = await guard(c);
              if (failure) {
                c.res = c.json({ error: failure.error, message: failure.message }, failure.status);
                return;
              }
            }
          }
          await next();
        });
      };

      const deps: BillingRouteDeps = {
        config,
        configured,
        userAuth: requireUserAuth,
        bus,
        provider: getProvider,
        store: () => store,
      };

      const router = createRouter();
      registerCheckoutRoute(router, deps);
      registerDonateRoute(router, deps);
      registerPortalRoute(router, deps);
      registerEntitlementRoute(router, deps);
      // Route paths already carry `config.mountPath`; mount at the root so the
      // OpenAPI document reflects the real client-facing paths (precedent:
      // slingshot-auth's routers).
      app.route('/', router);

      // The Stripe webhook mounts ONLY when billing is configured (spec:
      // dormant ⇒ the path 404s), and directly on the app as a plain POST so
      // it stays off the OpenAPI contract and receives the raw body.
      if (configured) {
        registerWebhookRoute(app, deps);
      }
    },
    setupPost({ app }: PluginSetupContext) {
      // Backstop: guarantees the store (and with it the DB-backed entitlement
      // capability) resolves even under harnesses that publish adapters late.
      resolveStoreFrom(app);
    },
  });
}
