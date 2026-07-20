/**
 * Shared integration harness: drives the real package lifecycle via
 * `runPackageLifecycle` (the same harness slingshot-push /
 * slingshot-notifications use): real entity modules wired onto in-memory
 * adapters, the real router, and the real store. Tests choose the provider:
 * the recording `FakeBillingProvider` (injected, default) or the real Stripe
 * provider constructed from the config (`injectProvider: false` — the webhook
 * suite uses this to run genuine signature verification, no network involved).
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
  InProcessAdapter,
  RESOLVE_ENTITY_FACTORIES,
  attachContext,
  createEventDefinitionRegistry,
  createEventPublisher,
  getContext,
  maybeEntityAdapter,
  registerPluginCapabilities,
} from '@lastshotlabs/slingshot-core';
import type {
  CoreRegistrar,
  EntityRegistry,
  PluginSetupContext,
  ResolvedEntityConfig,
  RouteAuthRegistry,
  SlingshotFrameworkConfig,
  StoreType,
} from '@lastshotlabs/slingshot-core';
import { createMemoryStoreInfra } from '@lastshotlabs/slingshot-core/testing';
import { createEntityFactories } from '@lastshotlabs/slingshot-entity';
import { runPackageLifecycle } from '@lastshotlabs/slingshot-entity/testing';
import type {
  BillingProvider,
  DonationCheckoutInput,
  OwnerRef,
  PortalInput,
  ProviderEvent,
  SubscriptionCheckoutInput,
} from '../../src/lib/provider';
import type { BillingEntityAdapter, BillingStore } from '../../src/lib/store';
import { createEntityBillingStore } from '../../src/lib/store';
import { BILLING_PACKAGE_NAME, createBillingPackage } from '../../src/plugin';
import type { BillingPackageConfig } from '../../src/types/config';

// ---------------------------------------------------------------------------
// Fake provider — records every call, returns canned hosted-page URLs.
// ---------------------------------------------------------------------------

export class FakeBillingProvider implements BillingProvider {
  readonly name = 'fake';
  readonly calls = {
    ensureCustomer: [] as OwnerRef[],
    subscriptionCheckouts: [] as SubscriptionCheckoutInput[],
    donationCheckouts: [] as DonationCheckoutInput[],
    portals: [] as PortalInput[],
  };
  private customerSeq = 0;

  async ensureCustomer(owner: OwnerRef) {
    this.calls.ensureCustomer.push(owner);
    return { providerCustomerId: `cus_fake_${++this.customerSeq}` };
  }
  async createSubscriptionCheckout(input: SubscriptionCheckoutInput) {
    this.calls.subscriptionCheckouts.push(input);
    return { url: 'https://provider.test/checkout' };
  }
  async createDonationCheckout(input: DonationCheckoutInput) {
    this.calls.donationCheckouts.push(input);
    return { url: 'https://provider.test/donate' };
  }
  async createPortalSession(input: PortalInput) {
    this.calls.portals.push(input);
    return { url: 'https://provider.test/portal' };
  }
  verifyAndParseWebhook(): ProviderEvent {
    throw new Error('webhook verification requires the real provider (injectProvider: false)');
  }
}

// ---------------------------------------------------------------------------
// Framework config fixture (mirrors the slingshot-push test harness).
// ---------------------------------------------------------------------------

function createFrameworkConfig(): SlingshotFrameworkConfig {
  const registeredEntities: ResolvedEntityConfig[] = [];
  const entityRegistry: EntityRegistry = {
    register(config) {
      registeredEntities.push(config);
    },
    getAll() {
      return registeredEntities;
    },
    filter(predicate) {
      return registeredEntities.filter(predicate);
    },
  };
  const registrar = {
    registerRouteAuth() {},
    build() {
      return { routeAuth: null, permissions: null };
    },
  } as unknown as CoreRegistrar;
  const storeInfra = createMemoryStoreInfra();
  Reflect.set(storeInfra as object, RESOLVE_ENTITY_FACTORIES, createEntityFactories);

  return {
    resolvedStores: {
      sessions: 'memory' as StoreType,
      oauthState: 'memory' as StoreType,
      cache: 'memory' as StoreType,
      authStore: 'memory' as StoreType,
      sqlite: undefined,
    },
    logging: { enabled: false, verbose: false, authTrace: false, auditWarnings: false },
    security: { cors: '*' },
    signing: null,
    dataEncryptionKeys: [],
    redis: undefined,
    mongo: undefined,
    captcha: null,
    trustProxy: false,
    storeInfra,
    registrar,
    entityRegistry,
    password: Bun.password,
  } as unknown as SlingshotFrameworkConfig;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Header-driven fake `userAuth`: `x-test-user` picks the actor id. */
function createFakeRouteAuth(defaultUserId: string): RouteAuthRegistry {
  return {
    userAuth: (async (c, next) => {
      const uid = c.req.header('x-test-user') ?? defaultUserId;
      const setter = c as unknown as { set(key: string, value: unknown): void };
      setter.set(
        'actor',
        Object.freeze({
          id: uid,
          kind: 'user' as const,
          tenantId: null,
          sessionId: null,
          roles: null,
          claims: { email: `${uid}@example.test` },
        }),
      );
      await next();
    }) as MiddlewareHandler,
    requireRole: () => async (_c, next) => next(),
  };
}

export const CONFIGURED: Partial<BillingPackageConfig> = {
  provider: { name: 'stripe', secretKey: 'sk_test_fake', webhookSecret: 'whsec_fake' },
  plans: [{ key: 'pro', priceId: 'price_pro', trialDays: 14 }],
  donations: {
    enabled: true,
    currency: 'usd',
    requireAuth: true,
    presets: [{ id: 'supporter', amount: 500 }],
    allowCustomAmount: { min: 100, max: 10_000 },
  },
  urls: {
    checkoutSuccess: 'https://app.test/billing/success',
    checkoutCancel: 'https://app.test/billing/cancel',
    portalReturn: 'https://app.test/account',
  },
};

export interface BillingHarness {
  app: Hono;
  provider: FakeBillingProvider;
  /** Store over the SAME in-memory adapters the package resolved — for seeding. */
  store: BillingStore;
  /** The instance bus — subscribe to observe `billing:*` emissions, `drain()` to settle. */
  bus: InProcessAdapter;
}

export async function createBillingHarness(
  config: Partial<BillingPackageConfig> = CONFIGURED,
  opts: { injectProvider?: boolean } = {},
): Promise<BillingHarness> {
  const app = new Hono();
  const bus = new InProcessAdapter();
  const events = createEventPublisher({ definitions: createEventDefinitionRegistry(), bus });
  const provider = new FakeBillingProvider();

  attachContext(app, {
    app,
    pluginState: new Map(),
    capabilityProviders: new Map<string, string>(),
    ws: null,
    wsEndpoints: {},
    wsPublish: null,
    bus,
    events,
    routeAuth: createFakeRouteAuth('user-1'),
  } as never);

  const pkg = createBillingPackage(config, opts.injectProvider === false ? {} : { provider });
  const ctx = {
    app,
    config: createFrameworkConfig(),
    bus,
    events,
  } as unknown as PluginSetupContext;
  await runPackageLifecycle(pkg, ctx);
  await registerPluginCapabilities(getContext(app) as never, pkg.name, pkg.capabilities.provides);

  const lookup = (entityName: string): BillingEntityAdapter => {
    const adapter = maybeEntityAdapter<BillingEntityAdapter>(app, {
      plugin: BILLING_PACKAGE_NAME,
      entity: entityName,
    });
    if (!adapter) throw new Error(`entity adapter '${entityName}' was not published`);
    return adapter;
  };
  const store = createEntityBillingStore({
    customers: lookup('Customer'),
    subscriptions: lookup('Subscription'),
    payments: lookup('Payment'),
  });

  return { app, provider, store, bus };
}

export async function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const ACTIVE_PRO_ROW = {
  ownerId: 'user-1',
  providerSubscriptionId: 'sub_1',
  plan: 'pro',
  status: 'active' as const,
  priceId: 'price_pro',
  currentPeriodEnd: '2026-08-01T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  providerEventCreated: 100,
};
