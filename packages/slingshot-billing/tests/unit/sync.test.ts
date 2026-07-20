import { describe, expect, test } from 'bun:test';
import { deriveEntitlement } from '../../src/lib/entitlement';
import type { ProviderEvent } from '../../src/lib/provider';
import type {
  BillingCustomerRow,
  BillingPaymentRow,
  BillingStore,
  BillingSubscriptionRow,
} from '../../src/lib/store';
import { syncProviderEvent } from '../../src/lib/sync';

const plans = [
  { key: 'pro', priceId: 'price_pro' },
  { key: 'plus', priceId: 'price_plus' },
];

/** In-memory `BillingStore` with the backing maps exposed for assertions. */
function createFakeStore(customers: readonly Omit<BillingCustomerRow, 'id'>[] = []) {
  let nextId = 0;
  const customerRows: BillingCustomerRow[] = customers.map(customer => ({
    id: `cus_row_${nextId++}`,
    ...customer,
  }));
  const subscriptionRows: BillingSubscriptionRow[] = [];
  const paymentRows: BillingPaymentRow[] = [];

  const store: BillingStore = {
    async findCustomerByOwnerId(ownerId) {
      return customerRows.find(row => row.ownerId === ownerId) ?? null;
    },
    async createCustomer(input) {
      customerRows.push({ id: `cus_row_${nextId++}`, ...input });
    },
    async findCustomerByProviderCustomerId(providerCustomerId) {
      return customerRows.find(row => row.providerCustomerId === providerCustomerId) ?? null;
    },
    async getSubscriptionByProviderSubscriptionId(providerSubscriptionId) {
      return (
        subscriptionRows.find(row => row.providerSubscriptionId === providerSubscriptionId) ?? null
      );
    },
    async listSubscriptionsByOwner(ownerId) {
      return subscriptionRows.filter(row => row.ownerId === ownerId);
    },
    async createSubscription(input) {
      subscriptionRows.push({ id: `sub_row_${nextId++}`, ...input });
    },
    async updateSubscription(id, patch) {
      const at = subscriptionRows.findIndex(row => row.id === id);
      if (at === -1) throw new Error(`no subscription row ${id}`);
      subscriptionRows[at] = { ...subscriptionRows[at], ...patch };
    },
    async findPaymentByProviderPaymentId(providerPaymentId) {
      return paymentRows.find(row => row.providerPaymentId === providerPaymentId) ?? null;
    },
    async createPayment(input) {
      paymentRows.push({ id: `pay_row_${nextId++}`, ...input });
    },
  };

  return { store, subscriptionRows, paymentRows };
}

const KNOWN_CUSTOMER = {
  ownerId: 'user_1',
  provider: 'stripe',
  providerCustomerId: 'cus_1',
};

function subscriptionUpdated(
  overrides: Partial<Extract<ProviderEvent, { kind: 'subscription.updated' }>> = {},
): ProviderEvent {
  return {
    kind: 'subscription.updated',
    providerCustomerId: 'cus_1',
    providerSubscriptionId: 'sub_1',
    priceId: 'price_pro',
    status: 'active',
    currentPeriodEnd: '2026-08-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    eventCreated: 100,
    ...overrides,
  };
}

describe('syncProviderEvent — subscription.updated', () => {
  test('creates the row and reports a changed entitlement', async () => {
    const { store, subscriptionRows } = createFakeStore([KNOWN_CUSTOMER]);
    const outcome = await syncProviderEvent(subscriptionUpdated(), store, plans);

    expect(subscriptionRows).toHaveLength(1);
    expect(subscriptionRows[0]).toMatchObject({
      ownerId: 'user_1',
      providerSubscriptionId: 'sub_1',
      plan: 'pro',
      status: 'active',
      providerEventCreated: 100,
    });
    expect(outcome).toMatchObject({
      kind: 'entitlement',
      ownerId: 'user_1',
      changed: true,
      entitlement: { plan: 'pro', status: 'active' },
    });
  });

  test('idempotent: the same event twice keeps one row and reports no change', async () => {
    const { store, subscriptionRows } = createFakeStore([KNOWN_CUSTOMER]);
    await syncProviderEvent(subscriptionUpdated(), store, plans);
    const replay = await syncProviderEvent(subscriptionUpdated(), store, plans);

    expect(subscriptionRows).toHaveLength(1);
    // An equal eventCreated is applied (idempotent replay), NOT dropped as stale.
    expect(replay.kind).toBe('entitlement');
    expect(replay).toMatchObject({ changed: false });
  });

  test('out-of-order: an event older than the stored one is dropped', async () => {
    const { store, subscriptionRows } = createFakeStore([KNOWN_CUSTOMER]);
    await syncProviderEvent(
      subscriptionUpdated({ status: 'canceled', eventCreated: 200 }),
      store,
      plans,
    );
    const stale = await syncProviderEvent(
      subscriptionUpdated({ status: 'active', eventCreated: 100 }),
      store,
      plans,
    );

    expect(stale).toEqual({ kind: 'noop', reason: 'stale-event' });
    // The newer canceled state was not clobbered by the late active event.
    expect(subscriptionRows[0].status).toBe('canceled');
    expect(subscriptionRows[0].providerEventCreated).toBe(200);
  });

  test('past_due partial event preserves the stored plan and period end', async () => {
    const { store, subscriptionRows } = createFakeStore([KNOWN_CUSTOMER]);
    await syncProviderEvent(subscriptionUpdated(), store, plans);
    // Shaped like a normalized invoice.payment_failed: no price, no period end.
    const outcome = await syncProviderEvent(
      subscriptionUpdated({
        priceId: null,
        currentPeriodEnd: null,
        status: 'past_due',
        eventCreated: 150,
      }),
      store,
      plans,
    );

    expect(subscriptionRows[0]).toMatchObject({
      status: 'past_due',
      plan: 'pro',
      priceId: 'price_pro',
      currentPeriodEnd: '2026-08-01T00:00:00.000Z',
      providerEventCreated: 150,
    });
    expect(outcome).toMatchObject({
      kind: 'entitlement',
      changed: true,
      entitlement: { plan: 'pro', status: 'past_due' },
    });
  });

  test("unknown price stores plan 'free' and derives FREE entitlement", async () => {
    const { store, subscriptionRows } = createFakeStore([KNOWN_CUSTOMER]);
    const outcome = await syncProviderEvent(
      subscriptionUpdated({ priceId: 'price_unconfigured' }),
      store,
      plans,
    );
    expect(subscriptionRows[0].plan).toBe('free');
    expect(outcome).toMatchObject({
      kind: 'entitlement',
      changed: false,
      entitlement: { plan: 'free', status: 'none' },
    });
  });

  test('unknown customer: no row is written, outcome is a noop', async () => {
    const { store, subscriptionRows } = createFakeStore(); // no customers stored
    const outcome = await syncProviderEvent(subscriptionUpdated(), store, plans);
    expect(outcome).toEqual({ kind: 'noop', reason: 'unknown-customer' });
    expect(subscriptionRows).toHaveLength(0);
  });
});

describe('syncProviderEvent — subscription.deleted', () => {
  const deleted = (eventCreated: number): ProviderEvent => ({
    kind: 'subscription.deleted',
    providerCustomerId: 'cus_1',
    providerSubscriptionId: 'sub_1',
    eventCreated,
  });

  test('cancels the stored row and reports the canceled entitlement', async () => {
    const { store, subscriptionRows } = createFakeStore([KNOWN_CUSTOMER]);
    await syncProviderEvent(subscriptionUpdated(), store, plans);
    const outcome = await syncProviderEvent(deleted(150), store, plans);

    expect(subscriptionRows[0].status).toBe('canceled');
    expect(outcome).toMatchObject({
      kind: 'entitlement',
      ownerId: 'user_1',
      changed: true,
      entitlement: { plan: 'pro', status: 'canceled' },
    });
  });

  test('a deletion older than the stored state is dropped', async () => {
    const { store, subscriptionRows } = createFakeStore([KNOWN_CUSTOMER]);
    await syncProviderEvent(subscriptionUpdated({ eventCreated: 200 }), store, plans);
    const outcome = await syncProviderEvent(deleted(100), store, plans);
    expect(outcome).toEqual({ kind: 'noop', reason: 'stale-event' });
    expect(subscriptionRows[0].status).toBe('active');
  });

  test('a deletion for a never-stored subscription is a noop', async () => {
    const { store } = createFakeStore([KNOWN_CUSTOMER]);
    const outcome = await syncProviderEvent(deleted(100), store, plans);
    expect(outcome).toEqual({ kind: 'noop', reason: 'unknown-subscription' });
  });
});

describe('syncProviderEvent — payment.completed', () => {
  const payment = (
    overrides: Partial<Extract<ProviderEvent, { kind: 'payment.completed' }>> = {},
  ): ProviderEvent => ({
    kind: 'payment.completed',
    providerCustomerId: 'cus_1',
    providerPaymentId: 'pi_1',
    amount: 500,
    currency: 'usd',
    presetId: 'coffee',
    eventCreated: 100,
    ...overrides,
  });

  test('inserts one row and returns the emit payload', async () => {
    const { store, paymentRows } = createFakeStore([KNOWN_CUSTOMER]);
    const outcome = await syncProviderEvent(payment(), store, plans);

    expect(paymentRows).toHaveLength(1);
    expect(paymentRows[0]).toMatchObject({
      ownerId: 'user_1',
      providerPaymentId: 'pi_1',
      kind: 'donation',
      amount: 500,
      currency: 'usd',
      presetId: 'coffee',
      status: 'succeeded',
    });
    expect(outcome).toEqual({
      kind: 'payment',
      payload: { ownerId: 'user_1', amount: 500, currency: 'usd', presetId: 'coffee' },
    });
  });

  test('idempotent: a duplicate providerPaymentId is a noop, one row remains', async () => {
    const { store, paymentRows } = createFakeStore([KNOWN_CUSTOMER]);
    await syncProviderEvent(payment(), store, plans);
    const replay = await syncProviderEvent(payment(), store, plans);
    expect(replay).toEqual({ kind: 'noop', reason: 'duplicate-payment' });
    expect(paymentRows).toHaveLength(1);
  });

  test('anonymous donation (no provider customer) records a null owner', async () => {
    const { store, paymentRows } = createFakeStore();
    const outcome = await syncProviderEvent(
      payment({ providerCustomerId: null, presetId: null }),
      store,
      plans,
    );
    expect(paymentRows[0].ownerId).toBeNull();
    expect(outcome).toEqual({
      kind: 'payment',
      payload: { ownerId: null, amount: 500, currency: 'usd' },
    });
  });

  test('payments NEVER alter the entitlement', async () => {
    const { store, subscriptionRows } = createFakeStore([KNOWN_CUSTOMER]);
    await syncProviderEvent(subscriptionUpdated(), store, plans);
    const before = deriveEntitlement(await store.listSubscriptionsByOwner('user_1'), plans);

    const outcome = await syncProviderEvent(payment(), store, plans);

    const after = deriveEntitlement(await store.listSubscriptionsByOwner('user_1'), plans);
    expect(after).toEqual(before);
    expect(subscriptionRows).toHaveLength(1);
    // The outcome carries a payment payload, never an entitlement.
    expect(outcome.kind).toBe('payment');
  });
});

describe('syncProviderEvent — ignored events', () => {
  test('acknowledges without side effects', async () => {
    const { store, subscriptionRows, paymentRows } = createFakeStore([KNOWN_CUSTOMER]);
    const outcome = await syncProviderEvent({ kind: 'ignored', eventCreated: 100 }, store, plans);
    expect(outcome).toEqual({ kind: 'noop', reason: 'ignored-event' });
    expect(subscriptionRows).toHaveLength(0);
    expect(paymentRows).toHaveLength(0);
  });
});
