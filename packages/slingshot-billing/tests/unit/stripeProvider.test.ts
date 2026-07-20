import { describe, expect, test } from 'bun:test';
import Stripe from 'stripe';
import {
  createStripeProvider,
  normalizeStripeEvent,
  stripeSyncCryptoProvider,
} from '../../src/lib/providers/stripe';
import type { StripeEventLike } from '../../src/lib/providers/stripe';

const WEBHOOK_SECRET = 'whsec_test_secret_for_billing_unit_tests';

const providerConfig = {
  name: 'stripe' as const,
  secretKey: 'sk_test_dummy_key_never_used_for_network',
  webhookSecret: WEBHOOK_SECRET,
};

/** A minimal but realistic customer.subscription.updated event body. */
const subscriptionUpdatedEvent = {
  id: 'evt_1',
  type: 'customer.subscription.updated',
  created: 1_750_000_000,
  data: {
    object: {
      id: 'sub_123',
      object: 'subscription',
      customer: 'cus_123',
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: 1_760_000_000,
      items: { data: [{ price: { id: 'price_pro' }, current_period_end: 1_760_000_000 }] },
    },
  },
};

/**
 * Sign `payload` exactly the way Stripe would, using the SDK's own test
 * helper. Bun loads the SDK's worker build, so the sync helper needs the same
 * explicit sync crypto provider the production seam uses.
 */
function signedHeader(payload: string, secret: string = WEBHOOK_SECRET): string {
  return new Stripe('sk_test_signing_helper').webhooks.generateTestHeaderString({
    payload,
    secret,
    cryptoProvider: stripeSyncCryptoProvider,
  });
}

describe('createStripeProvider — verifyAndParseWebhook', () => {
  test('accepts a correctly signed payload and returns the normalized event', () => {
    const provider = createStripeProvider(providerConfig);
    const payload = JSON.stringify(subscriptionUpdatedEvent);
    const headers = new Headers({ 'stripe-signature': signedHeader(payload) });

    const event = provider.verifyAndParseWebhook(payload, headers);
    expect(event).toEqual({
      kind: 'subscription.updated',
      providerCustomerId: 'cus_123',
      providerSubscriptionId: 'sub_123',
      priceId: 'price_pro',
      status: 'active',
      currentPeriodEnd: new Date(1_760_000_000 * 1000).toISOString(),
      cancelAtPeriodEnd: false,
      eventCreated: 1_750_000_000,
    });
  });

  test('throws on a tampered body', () => {
    const provider = createStripeProvider(providerConfig);
    const payload = JSON.stringify(subscriptionUpdatedEvent);
    const headers = new Headers({ 'stripe-signature': signedHeader(payload) });
    const tampered = payload.replace('"status":"active"', '"status":"free!!"');

    expect(() => provider.verifyAndParseWebhook(tampered, headers)).toThrow();
  });

  test('throws on a signature made with the wrong secret', () => {
    const provider = createStripeProvider(providerConfig);
    const payload = JSON.stringify(subscriptionUpdatedEvent);
    const headers = new Headers({
      'stripe-signature': signedHeader(payload, 'whsec_a_completely_different_secret'),
    });

    expect(() => provider.verifyAndParseWebhook(payload, headers)).toThrow();
  });

  test('throws when the stripe-signature header is missing', () => {
    const provider = createStripeProvider(providerConfig);
    const payload = JSON.stringify(subscriptionUpdatedEvent);
    expect(() => provider.verifyAndParseWebhook(payload, new Headers())).toThrow(
      /stripe-signature/,
    );
  });

  test("provider name is 'stripe'", () => {
    expect(createStripeProvider(providerConfig).name).toBe('stripe');
  });
});

describe('normalizeStripeEvent — subscription lifecycle', () => {
  function subEvent(
    type: string,
    object: Record<string, unknown>,
    created = 1_750_000_000,
  ): StripeEventLike {
    return { type, created, data: { object } };
  }

  const baseSubscription = {
    id: 'sub_123',
    customer: 'cus_123',
    status: 'active',
    cancel_at_period_end: true,
    current_period_end: 1_760_000_000,
    items: { data: [{ price: { id: 'price_pro' } }] },
  };

  test('customer.subscription.created and .updated both normalize to subscription.updated', () => {
    for (const type of ['customer.subscription.created', 'customer.subscription.updated']) {
      const event = normalizeStripeEvent(subEvent(type, baseSubscription));
      expect(event).toMatchObject({
        kind: 'subscription.updated',
        providerSubscriptionId: 'sub_123',
        providerCustomerId: 'cus_123',
        priceId: 'price_pro',
        status: 'active',
        cancelAtPeriodEnd: true,
        eventCreated: 1_750_000_000,
      });
    }
  });

  test('Basil payloads: current_period_end read from the first item when absent at the root', () => {
    const basil = {
      ...baseSubscription,
      current_period_end: undefined,
      items: { data: [{ price: { id: 'price_pro' }, current_period_end: 1_761_000_000 }] },
    };
    const event = normalizeStripeEvent(subEvent('customer.subscription.updated', basil));
    expect(event).toMatchObject({
      currentPeriodEnd: new Date(1_761_000_000 * 1000).toISOString(),
    });
  });

  test('status vocabulary collapses onto the normalized union', () => {
    const cases: readonly [string, string][] = [
      ['active', 'active'],
      ['trialing', 'trialing'],
      ['past_due', 'past_due'],
      ['unpaid', 'past_due'],
      ['incomplete', 'past_due'],
      ['canceled', 'canceled'],
      ['incomplete_expired', 'canceled'],
      ['paused', 'canceled'],
    ];
    for (const [raw, normalized] of cases) {
      const event = normalizeStripeEvent(
        subEvent('customer.subscription.updated', { ...baseSubscription, status: raw }),
      );
      expect(event).toMatchObject({ status: normalized });
    }
  });

  test('customer.subscription.deleted → subscription.deleted', () => {
    const event = normalizeStripeEvent(subEvent('customer.subscription.deleted', baseSubscription));
    expect(event).toEqual({
      kind: 'subscription.deleted',
      providerCustomerId: 'cus_123',
      providerSubscriptionId: 'sub_123',
      eventCreated: 1_750_000_000,
    });
  });

  test('an expanded customer object still yields its id', () => {
    const event = normalizeStripeEvent(
      subEvent('customer.subscription.updated', {
        ...baseSubscription,
        customer: { id: 'cus_expanded' },
      }),
    );
    expect(event).toMatchObject({ providerCustomerId: 'cus_expanded' });
  });
});

describe('normalizeStripeEvent — checkout.session.completed', () => {
  const created = 1_750_000_000;

  test('subscription mode with an EXPANDED subscription uses its full fields', () => {
    const event = normalizeStripeEvent({
      type: 'checkout.session.completed',
      created,
      data: {
        object: {
          mode: 'subscription',
          customer: 'cus_123',
          subscription: {
            id: 'sub_123',
            customer: 'cus_123',
            status: 'trialing',
            cancel_at_period_end: false,
            current_period_end: 1_760_000_000,
            items: { data: [{ price: { id: 'price_plus' } }] },
          },
        },
      },
    });
    expect(event).toMatchObject({
      kind: 'subscription.updated',
      providerSubscriptionId: 'sub_123',
      priceId: 'price_plus',
      status: 'trialing',
    });
  });

  test('subscription mode with only a subscription ID yields a partial active update', () => {
    const event = normalizeStripeEvent({
      type: 'checkout.session.completed',
      created,
      data: {
        object: { mode: 'subscription', customer: 'cus_123', subscription: 'sub_123' },
      },
    });
    // Partial: null price/period — sync preserves stored values; the
    // concurrent customer.subscription.created event carries the full fields.
    expect(event).toEqual({
      kind: 'subscription.updated',
      providerCustomerId: 'cus_123',
      providerSubscriptionId: 'sub_123',
      priceId: null,
      status: 'active',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      eventCreated: created,
    });
  });

  test('payment mode → payment.completed with amount, currency, and presetId', () => {
    const event = normalizeStripeEvent({
      type: 'checkout.session.completed',
      created,
      data: {
        object: {
          id: 'cs_123',
          mode: 'payment',
          customer: 'cus_123',
          payment_intent: 'pi_123',
          amount_total: 500,
          currency: 'usd',
          metadata: { billingKind: 'donation', presetId: 'coffee' },
        },
      },
    });
    expect(event).toEqual({
      kind: 'payment.completed',
      providerCustomerId: 'cus_123',
      providerPaymentId: 'pi_123',
      amount: 500,
      currency: 'usd',
      presetId: 'coffee',
      eventCreated: created,
    });
  });

  test('anonymous payment mode: null customer, session id fallback, no preset', () => {
    const event = normalizeStripeEvent({
      type: 'checkout.session.completed',
      created,
      data: {
        object: {
          id: 'cs_456',
          mode: 'payment',
          customer: null,
          payment_intent: null,
          amount_total: 1234,
          currency: 'eur',
        },
      },
    });
    expect(event).toEqual({
      kind: 'payment.completed',
      providerCustomerId: null,
      providerPaymentId: 'cs_456',
      amount: 1234,
      currency: 'eur',
      presetId: null,
      eventCreated: created,
    });
  });

  test('setup mode is ignored', () => {
    const event = normalizeStripeEvent({
      type: 'checkout.session.completed',
      created,
      data: { object: { mode: 'setup' } },
    });
    expect(event).toEqual({ kind: 'ignored', eventCreated: created });
  });
});

describe('normalizeStripeEvent — invoice.payment_failed', () => {
  const created = 1_750_000_000;

  test('pre-Basil invoice (root subscription field) → past_due partial update', () => {
    const event = normalizeStripeEvent({
      type: 'invoice.payment_failed',
      created,
      data: { object: { customer: 'cus_123', subscription: 'sub_123' } },
    });
    expect(event).toEqual({
      kind: 'subscription.updated',
      providerCustomerId: 'cus_123',
      providerSubscriptionId: 'sub_123',
      priceId: null,
      status: 'past_due',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      eventCreated: created,
    });
  });

  test('Basil invoice (parent.subscription_details) resolves the subscription id', () => {
    const event = normalizeStripeEvent({
      type: 'invoice.payment_failed',
      created,
      data: {
        object: {
          customer: 'cus_123',
          parent: { subscription_details: { subscription: 'sub_456' } },
        },
      },
    });
    expect(event).toMatchObject({
      kind: 'subscription.updated',
      providerSubscriptionId: 'sub_456',
      status: 'past_due',
    });
  });

  test('an invoice with no subscription is ignored', () => {
    const event = normalizeStripeEvent({
      type: 'invoice.payment_failed',
      created,
      data: { object: { customer: 'cus_123' } },
    });
    expect(event).toEqual({ kind: 'ignored', eventCreated: created });
  });
});

describe('normalizeStripeEvent — everything else', () => {
  test('unhandled event types are ignored, keeping the event timestamp', () => {
    for (const type of ['invoice.paid', 'payment_intent.succeeded', 'charge.refunded']) {
      const event = normalizeStripeEvent({
        type,
        created: 42,
        data: { object: {} },
      });
      expect(event).toEqual({ kind: 'ignored', eventCreated: 42 });
    }
  });
});
