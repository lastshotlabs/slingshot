/**
 * End-to-end route tests for Phase 3: checkout, donate, portal, entitlement.
 *
 * The lifecycle harness (real entity modules on in-memory adapters, real
 * router, real store, recording `FakeBillingProvider`, header-driven fake
 * `userAuth`) lives in `./_harness` and is shared with the webhook suite.
 */
import { describe, expect, test } from 'bun:test';
import { getContext, resolveCapabilityValue } from '@lastshotlabs/slingshot-core';
import { BillingEntitlementCap, FREE_ENTITLEMENT } from '../../src/public';
import { ACTIVE_PRO_ROW, CONFIGURED, createBillingHarness, postJson } from './_harness';

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
