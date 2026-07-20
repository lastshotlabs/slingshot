/**
 * End-to-end route tests for Phase 3: checkout, donate, portal, entitlement.
 *
 * Drives the real package lifecycle via `runPackageLifecycle` (the same
 * harness slingshot-push / slingshot-notifications use): real entity modules
 * wired onto in-memory adapters, the real router, and the real store — only
 * the payment provider (a recording `FakeBillingProvider`) and the auth
 * registry (a header-driven fake `userAuth`) are substituted.
 */
import { describe, expect, test } from 'bun:test';
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
  resolveCapabilityValue,
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
import { BillingEntitlementCap, FREE_ENTITLEMENT } from '../../src/public';
import type { BillingPackageConfig } from '../../src/types/config';

// ---------------------------------------------------------------------------
// Fake provider — records every call, returns canned hosted-page URLs.
// ---------------------------------------------------------------------------

class FakeBillingProvider implements BillingProvider {
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
    throw new Error('webhook verification is not under test in Phase 3');
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

const CONFIGURED: Partial<BillingPackageConfig> = {
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

interface BillingHarness {
  app: Hono;
  provider: FakeBillingProvider;
  /** Store over the SAME in-memory adapters the package resolved — for seeding. */
  store: BillingStore;
}

async function createBillingHarness(
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

  return { app, provider, store };
}

async function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ACTIVE_PRO_ROW = {
  ownerId: 'user-1',
  providerSubscriptionId: 'sub_1',
  plan: 'pro',
  status: 'active' as const,
  priceId: 'price_pro',
  currentPeriodEnd: '2026-08-01T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  providerEventCreated: 100,
};

// ---------------------------------------------------------------------------
// Dormant behavior
// ---------------------------------------------------------------------------

describe('billing routes — dormant (no provider configured)', () => {
  test('checkout, donate, and portal answer 503 billing_unavailable', async () => {
    const { app } = await createBillingHarness({}, { injectProvider: false });

    for (const [path, body] of [
      ['/billing/checkout', { plan: 'pro' }],
      ['/billing/donate', { presetId: 'supporter' }],
      ['/billing/portal', {}],
    ] as const) {
      const response = await postJson(app, path, body);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'billing_unavailable' });
    }
  });

  test('entitlement answers the free entitlement without touching storage', async () => {
    const { app } = await createBillingHarness({}, { injectProvider: false });
    const response = await app.request('/billing/entitlement');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...FREE_ENTITLEMENT });
  });

  test('the entitlement capability resolves free', async () => {
    const { app } = await createBillingHarness({}, { injectProvider: false });
    const resolve = resolveCapabilityValue(getContext(app), BillingEntitlementCap);
    expect(resolve).toBeDefined();
    expect(await resolve!('user-1')).toEqual(FREE_ENTITLEMENT);
  });
});

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

describe('POST /billing/checkout', () => {
  test('rejects an unknown plan key with 400', async () => {
    const { app, provider } = await createBillingHarness();
    const response = await postJson(app, '/billing/checkout', { plan: 'nope' });
    expect(response.status).toBe(400);
    expect(provider.calls.subscriptionCheckouts).toHaveLength(0);
    expect(provider.calls.ensureCustomer).toHaveLength(0);
  });

  test('returns the hosted checkout url with the server-selected price and trial', async () => {
    const { app, provider } = await createBillingHarness();
    const response = await postJson(app, '/billing/checkout', { plan: 'pro' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://provider.test/checkout' });

    expect(provider.calls.subscriptionCheckouts).toHaveLength(1);
    expect(provider.calls.subscriptionCheckouts[0]).toMatchObject({
      customer: { providerCustomerId: 'cus_fake_1' },
      priceId: 'price_pro',
      trialDays: 14,
      urls: {
        successUrl: 'https://app.test/billing/success',
        cancelUrl: 'https://app.test/billing/cancel',
      },
    });
    expect(provider.calls.ensureCustomer[0]).toEqual({
      ownerId: 'user-1',
      email: 'user-1@example.test',
    });
  });

  test('creates the provider customer exactly once across repeat checkouts', async () => {
    const { app, provider, store } = await createBillingHarness();
    expect((await postJson(app, '/billing/checkout', { plan: 'pro' })).status).toBe(200);
    expect((await postJson(app, '/billing/checkout', { plan: 'pro' })).status).toBe(200);

    expect(provider.calls.ensureCustomer).toHaveLength(1);
    expect(provider.calls.subscriptionCheckouts).toHaveLength(2);
    // The second checkout reused the persisted provider customer id.
    expect(provider.calls.subscriptionCheckouts[1]?.customer.providerCustomerId).toBe('cus_fake_1');
    expect((await store.findCustomerByOwnerId('user-1'))?.providerCustomerId).toBe('cus_fake_1');
  });
});

// ---------------------------------------------------------------------------
// Donate
// ---------------------------------------------------------------------------

describe('POST /billing/donate', () => {
  test('rejects both / neither of presetId and customAmount', async () => {
    const { app } = await createBillingHarness();
    const both = await postJson(app, '/billing/donate', {
      presetId: 'supporter',
      customAmount: 500,
    });
    expect(both.status).toBe(400);
    const neither = await postJson(app, '/billing/donate', {});
    expect(neither.status).toBe(400);
  });

  test('rejects an unknown preset and out-of-bounds custom amounts', async () => {
    const { app, provider } = await createBillingHarness();
    expect((await postJson(app, '/billing/donate', { presetId: 'nope' })).status).toBe(400);
    expect((await postJson(app, '/billing/donate', { customAmount: 99 })).status).toBe(400);
    expect((await postJson(app, '/billing/donate', { customAmount: 10_001 })).status).toBe(400);
    expect(provider.calls.donationCheckouts).toHaveLength(0);
  });

  test('rejects customAmount when allowCustomAmount is not configured', async () => {
    const { app } = await createBillingHarness({
      ...CONFIGURED,
      donations: {
        enabled: true,
        currency: 'usd',
        requireAuth: true,
        presets: [{ id: 'supporter', amount: 500 }],
      },
    });
    const response = await postJson(app, '/billing/donate', { customAmount: 500 });
    expect(response.status).toBe(400);
  });

  test('answers 503 when donations are disabled even though billing is configured', async () => {
    const { app } = await createBillingHarness({
      ...CONFIGURED,
      donations: { enabled: false, currency: 'usd', requireAuth: true },
    });
    const response = await postJson(app, '/billing/donate', { presetId: 'supporter' });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'billing_unavailable' });
  });

  test('preset donations resolve the configured amount server-side', async () => {
    const { app, provider } = await createBillingHarness();
    const response = await postJson(app, '/billing/donate', { presetId: 'supporter' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://provider.test/donate' });
    expect(provider.calls.donationCheckouts[0]).toMatchObject({
      amount: 500,
      currency: 'usd',
      presetId: 'supporter',
      customer: { providerCustomerId: 'cus_fake_1' },
    });
  });

  test('in-bounds custom amounts pass through', async () => {
    const { app, provider } = await createBillingHarness();
    const response = await postJson(app, '/billing/donate', { customAmount: 2500 });
    expect(response.status).toBe(200);
    expect(provider.calls.donationCheckouts[0]).toMatchObject({ amount: 2500, currency: 'usd' });
    expect(provider.calls.donationCheckouts[0]?.presetId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Portal
// ---------------------------------------------------------------------------

describe('POST /billing/portal', () => {
  test('404s when the owner has no billing customer', async () => {
    const { app, provider } = await createBillingHarness();
    const response = await postJson(app, '/billing/portal', {});
    expect(response.status).toBe(404);
    expect(provider.calls.portals).toHaveLength(0);
  });

  test('opens a portal session for an existing customer with the configured return url', async () => {
    const { app, provider } = await createBillingHarness();
    expect((await postJson(app, '/billing/checkout', { plan: 'pro' })).status).toBe(200);

    const response = await postJson(app, '/billing/portal', {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://provider.test/portal' });
    expect(provider.calls.portals[0]).toEqual({
      customer: { providerCustomerId: 'cus_fake_1' },
      returnUrl: 'https://app.test/account',
    });
  });
});

// ---------------------------------------------------------------------------
// Entitlement
// ---------------------------------------------------------------------------

describe('GET /billing/entitlement', () => {
  test('derives free when the owner has no subscription rows', async () => {
    const { app } = await createBillingHarness();
    const response = await app.request('/billing/entitlement');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...FREE_ENTITLEMENT });
  });

  test('derives the plan from stored subscription rows', async () => {
    const { app, store } = await createBillingHarness();
    await store.createSubscription(ACTIVE_PRO_ROW);

    const response = await app.request('/billing/entitlement');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      plan: 'pro',
      status: 'active',
      currentPeriodEnd: '2026-08-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    });
  });

  test('scopes the derivation to the authenticated owner', async () => {
    const { app, store } = await createBillingHarness();
    await store.createSubscription({ ...ACTIVE_PRO_ROW, ownerId: 'someone-else' });

    const response = await app.request('/billing/entitlement');
    expect(await response.json()).toEqual({ ...FREE_ENTITLEMENT });
  });

  test('the capability resolver reads the same stored rows', async () => {
    const { app, store } = await createBillingHarness();
    await store.createSubscription(ACTIVE_PRO_ROW);

    const resolve = resolveCapabilityValue(getContext(app), BillingEntitlementCap);
    expect(resolve).toBeDefined();
    expect(await resolve!('user-1')).toMatchObject({ plan: 'pro', status: 'active' });
    expect(await resolve!('someone-else')).toEqual(FREE_ENTITLEMENT);
  });
});
