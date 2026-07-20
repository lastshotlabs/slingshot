/**
 * End-to-end webhook tests for Phase 4: `POST /billing/webhooks/stripe`.
 *
 * Runs the REAL Stripe provider (`injectProvider: false` — no network is ever
 * touched: signature verification and event normalization are pure) against
 * payloads signed with the SDK's own `generateTestHeaderString`, through the
 * full `runPackageLifecycle` stack: raw-body read, signature verification,
 * `syncProviderEvent`, bus emission, and agreement between the emitted
 * entitlement, `GET /billing/entitlement`, and `BillingEntitlementCap`.
 */
import { describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import Stripe from 'stripe';
import { getContext, resolveCapabilityValue } from '@lastshotlabs/slingshot-core';
import type { SlingshotEventBus } from '@lastshotlabs/slingshot-core';
import type {
  BillingEntitlementChangedPayload,
  BillingPaymentCompletedPayload,
} from '../../src/events';
import { stripeSyncCryptoProvider } from '../../src/lib/providers/stripe';
import { createBillingPackage } from '../../src/plugin';
import { BillingEntitlementCap } from '../../src/public';
import type { BillingHarness } from './_harness';
import { CONFIGURED, createBillingHarness } from './_harness';

const WEBHOOK_SECRET = CONFIGURED.provider!.webhookSecret;
const WEBHOOK_PATH = '/billing/webhooks/stripe';
const T0 = 1_750_000_000;
const PERIOD_END = 1_760_000_000;
const PERIOD_END_ISO = new Date(PERIOD_END * 1000).toISOString();

/** Sign `payload` exactly the way Stripe would (sync crypto provider — Bun). */
function signedHeader(payload: string, secret: string = WEBHOOK_SECRET): string {
  return new Stripe('sk_test_signing_helper').webhooks.generateTestHeaderString({
    payload,
    secret,
    cryptoProvider: stripeSyncCryptoProvider,
  });
}

async function postWebhook(
  app: Hono,
  payload: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await app.request(WEBHOOK_PATH, { method: 'POST', headers, body: payload });
}

/** POST a payload with a valid signature over it. */
async function postSigned(app: Hono, payload: string): Promise<Response> {
  return await postWebhook(app, payload, { 'stripe-signature': signedHeader(payload) });
}

let eventSeq = 0;

/** A realistic customer.subscription.* event body, JSON-stringified for signing. */
function subscriptionPayload(
  overrides: {
    type?: string;
    created?: number;
    subId?: string;
    customer?: string;
    status?: string;
    priceId?: string;
  } = {},
): string {
  return JSON.stringify({
    id: `evt_${++eventSeq}`,
    type: overrides.type ?? 'customer.subscription.created',
    created: overrides.created ?? T0,
    data: {
      object: {
        id: overrides.subId ?? 'sub_123',
        object: 'subscription',
        customer: overrides.customer ?? 'cus_123',
        status: overrides.status ?? 'active',
        cancel_at_period_end: false,
        current_period_end: PERIOD_END,
        items: { data: [{ price: { id: overrides.priceId ?? 'price_pro' } }] },
      },
    },
  });
}

/** A checkout.session.completed payment-mode (donation) event body. */
function paymentPayload(
  overrides: { created?: number; paymentIntent?: string; customer?: string | null } = {},
): string {
  return JSON.stringify({
    id: `evt_${++eventSeq}`,
    type: 'checkout.session.completed',
    created: overrides.created ?? T0,
    data: {
      object: {
        id: 'cs_1',
        mode: 'payment',
        customer: overrides.customer === undefined ? 'cus_123' : overrides.customer,
        payment_intent: overrides.paymentIntent ?? 'pi_1',
        amount_total: 500,
        currency: 'usd',
        metadata: { billingKind: 'donation', presetId: 'supporter' },
      },
    },
  });
}

/** Subscribe to both billing events, collecting every emission. */
function captureEmits(bus: SlingshotEventBus) {
  const entitlements: BillingEntitlementChangedPayload[] = [];
  const payments: BillingPaymentCompletedPayload[] = [];
  bus.on('billing:entitlement.changed', payload => {
    entitlements.push(payload as BillingEntitlementChangedPayload);
  });
  bus.on('billing:payment.completed', payload => {
    payments.push(payload as BillingPaymentCompletedPayload);
  });
  return { entitlements, payments };
}

/** Configured harness on the REAL Stripe provider, with a seeded customer row. */
async function createWebhookHarness(
  config = CONFIGURED,
  opts: { seedCustomer?: boolean } = {},
): Promise<BillingHarness & { emits: ReturnType<typeof captureEmits> }> {
  const harness = await createBillingHarness(config, { injectProvider: false });
  if (opts.seedCustomer !== false) {
    await harness.store.createCustomer({
      ownerId: 'user-1',
      provider: 'stripe',
      providerCustomerId: 'cus_123',
    });
  }
  return { ...harness, emits: captureEmits(harness.bus) };
}

// ---------------------------------------------------------------------------
// End-to-end: signed subscription event → row + emit + entitlement agreement
// ---------------------------------------------------------------------------

describe('POST /billing/webhooks/stripe — subscription lifecycle', () => {
  test('a signed subscription-created event stores the row, emits, and flips the entitlement', async () => {
    const { app, store, bus, emits } = await createWebhookHarness();

    const response = await postSigned(app, subscriptionPayload());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });

    const row = await store.getSubscriptionByProviderSubscriptionId('sub_123');
    expect(row).toMatchObject({
      ownerId: 'user-1',
      plan: 'pro',
      status: 'active',
      priceId: 'price_pro',
      currentPeriodEnd: PERIOD_END_ISO,
      cancelAtPeriodEnd: false,
      providerEventCreated: T0,
    });

    await bus.drain();
    expect(emits.entitlements).toHaveLength(1);
    const emitted = emits.entitlements[0]!;
    expect(emitted.ownerId).toBe('user-1');
    expect(emitted.entitlement).toEqual({
      plan: 'pro',
      status: 'active',
      currentPeriodEnd: PERIOD_END_ISO,
      cancelAtPeriodEnd: false,
    });

    // The emitted entitlement, the route, and the capability all agree.
    const viaRoute = await app.request('/billing/entitlement');
    expect(viaRoute.status).toBe(200);
    expect(await viaRoute.json()).toEqual({ ...emitted.entitlement });

    const resolve = resolveCapabilityValue(getContext(app), BillingEntitlementCap);
    expect(resolve).toBeDefined();
    expect(await resolve!('user-1')).toEqual(emitted.entitlement);
  });

  test('an exact duplicate replay is a 200 no-op: one row, one emit total', async () => {
    const { app, store, bus, emits } = await createWebhookHarness();
    const payload = subscriptionPayload();
    const header = signedHeader(payload);

    for (let i = 0; i < 2; i++) {
      const response = await postWebhook(app, payload, { 'stripe-signature': header });
      expect(response.status).toBe(200);
    }

    expect(await store.listSubscriptionsByOwner('user-1')).toHaveLength(1);
    await bus.drain();
    expect(emits.entitlements).toHaveLength(1);
  });

  test('an out-of-order older event is acknowledged but changes nothing', async () => {
    const { app, store, bus, emits } = await createWebhookHarness();

    expect((await postSigned(app, subscriptionPayload({ created: T0 + 100 }))).status).toBe(200);
    // The stale delivery claims the subscription was canceled — but it is
    // strictly older than the applied event, so it must be dropped.
    const stale = await postSigned(
      app,
      subscriptionPayload({
        created: T0,
        status: 'canceled',
        type: 'customer.subscription.updated',
      }),
    );
    expect(stale.status).toBe(200);

    const row = await store.getSubscriptionByProviderSubscriptionId('sub_123');
    expect(row).toMatchObject({ status: 'active', providerEventCreated: T0 + 100 });
    await bus.drain();
    expect(emits.entitlements).toHaveLength(1);
  });

  test('subscription.deleted downgrades the entitlement and the emit reflects it', async () => {
    const { app, bus, emits } = await createWebhookHarness();

    expect((await postSigned(app, subscriptionPayload())).status).toBe(200);
    const deleted = await postSigned(
      app,
      subscriptionPayload({ type: 'customer.subscription.deleted', created: T0 + 100 }),
    );
    expect(deleted.status).toBe(200);

    await bus.drain();
    expect(emits.entitlements).toHaveLength(2);
    // Pinned derivation rule: a canceled row surfaces `status: 'canceled'`
    // (plan retained for context) — no longer an active/trialing entitlement.
    const downgraded = emits.entitlements[1]!.entitlement;
    expect(downgraded.status).toBe('canceled');

    const viaRoute = await app.request('/billing/entitlement');
    expect(await viaRoute.json()).toEqual({ ...downgraded });
  });

  test('an event for an unknown customer is acknowledged without rows or emits', async () => {
    const { app, store, bus, emits } = await createWebhookHarness(CONFIGURED, {
      seedCustomer: false,
    });

    const response = await postSigned(app, subscriptionPayload({ customer: 'cus_nobody' }));
    expect(response.status).toBe(200);

    expect(await store.getSubscriptionByProviderSubscriptionId('sub_123')).toBeNull();
    await bus.drain();
    expect(emits.entitlements).toHaveLength(0);
    expect(emits.payments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Payments (donations)
// ---------------------------------------------------------------------------

describe('POST /billing/webhooks/stripe — payment mode', () => {
  test('checkout.session.completed (payment) records the payment and emits once, replay-safe', async () => {
    const { app, store, bus, emits } = await createWebhookHarness();
    const payload = paymentPayload();
    const header = signedHeader(payload);

    for (let i = 0; i < 2; i++) {
      const response = await postWebhook(app, payload, { 'stripe-signature': header });
      expect(response.status).toBe(200);
    }

    const row = await store.findPaymentByProviderPaymentId('pi_1');
    expect(row).toMatchObject({
      ownerId: 'user-1',
      kind: 'donation',
      amount: 500,
      currency: 'usd',
      presetId: 'supporter',
      status: 'succeeded',
    });

    await bus.drain();
    expect(emits.payments).toEqual([
      { ownerId: 'user-1', amount: 500, currency: 'usd', presetId: 'supporter' },
    ]);
    // Payments never touch the entitlement.
    expect(emits.entitlements).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rejection paths: signature and size — before any state is touched
// ---------------------------------------------------------------------------

describe('POST /billing/webhooks/stripe — rejections', () => {
  test('a signature made with the wrong secret is a 400 with no row and no emit', async () => {
    const { app, store, bus, emits } = await createWebhookHarness();
    const payload = subscriptionPayload();

    const response = await postWebhook(app, payload, {
      'stripe-signature': signedHeader(payload, 'whsec_a_completely_different_secret'),
    });
    expect(response.status).toBe(400);

    expect(await store.getSubscriptionByProviderSubscriptionId('sub_123')).toBeNull();
    await bus.drain();
    expect(emits.entitlements).toHaveLength(0);
  });

  test('a missing stripe-signature header is a 400', async () => {
    const { app } = await createWebhookHarness();
    const response = await postWebhook(app, subscriptionPayload());
    expect(response.status).toBe(400);
  });

  test('an oversized body is a 413 before signature verification runs', async () => {
    const { app } = await createWebhookHarness({ ...CONFIGURED, webhookMaxBodyBytes: 256 });

    // A bogus signature — if verification ran first this would be a 400.
    const response = await postWebhook(app, 'x'.repeat(300), {
      'stripe-signature': 't=1,v1=bogus',
    });
    expect(response.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// Dormant behavior + package declaration (Phase 5 closeout)
// ---------------------------------------------------------------------------

describe('POST /billing/webhooks/stripe — dormant package', () => {
  test('the webhook route is not mounted at all: POST 404s', async () => {
    const { app } = await createBillingHarness({}, { injectProvider: false });
    const payload = subscriptionPayload();
    const response = await postWebhook(app, payload, { 'stripe-signature': signedHeader(payload) });
    expect(response.status).toBe(404);
  });

  test('the webhook path is declared public + CSRF-exempt, configured or dormant', () => {
    for (const config of [{}, CONFIGURED]) {
      const pkg = createBillingPackage(config);
      expect(pkg.publicPaths).toContain('/billing/webhooks/stripe');
      expect(pkg.csrfExemptPaths).toContain('/billing/webhooks/stripe');
    }
  });
});
