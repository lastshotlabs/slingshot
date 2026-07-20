import { describe, expect, test } from 'bun:test';
import type { BillingEntityAdapter } from '../../src/lib/store';
import { createEntityBillingStore } from '../../src/lib/store';

/** Recording stub for one entity adapter, seeded with canned list results. */
function stubAdapter(items: unknown[] = []) {
  const calls: { create: unknown[]; update: [string, unknown][]; list: unknown[] } = {
    create: [],
    update: [],
    list: [],
  };
  const adapter: BillingEntityAdapter = {
    async create(data) {
      calls.create.push(data);
      return data;
    },
    async update(id, data) {
      calls.update.push([id, data]);
      return data;
    },
    async list(opts) {
      calls.list.push(opts);
      return { items };
    },
  };
  return { adapter, calls };
}

function makeStore(
  seed: { customers?: unknown[]; subscriptions?: unknown[]; payments?: unknown[] } = {},
) {
  const customers = stubAdapter(seed.customers);
  const subscriptions = stubAdapter(seed.subscriptions);
  const payments = stubAdapter(seed.payments);
  const store = createEntityBillingStore({
    customers: customers.adapter,
    subscriptions: subscriptions.adapter,
    payments: payments.adapter,
  });
  return { store, customers, subscriptions, payments };
}

describe('createEntityBillingStore', () => {
  test('finds a customer by provider id via an equality list filter', async () => {
    const { store, customers } = makeStore({
      customers: [{ id: 'c1', ownerId: 'user_1', provider: 'stripe', providerCustomerId: 'cus_1' }],
    });
    const row = await store.findCustomerByProviderCustomerId('cus_1');
    expect(row).toEqual({
      id: 'c1',
      ownerId: 'user_1',
      provider: 'stripe',
      providerCustomerId: 'cus_1',
    });
    expect(customers.calls.list[0]).toEqual({ filter: { providerCustomerId: 'cus_1' }, limit: 1 });
  });

  test('finds a customer by owner id via an equality list filter', async () => {
    const { store, customers } = makeStore({
      customers: [{ id: 'c1', ownerId: 'user_1', provider: 'stripe', providerCustomerId: 'cus_1' }],
    });
    const row = await store.findCustomerByOwnerId('user_1');
    expect(row?.providerCustomerId).toBe('cus_1');
    expect(customers.calls.list[0]).toEqual({ filter: { ownerId: 'user_1' }, limit: 1 });
  });

  test('creates a customer row through the customers adapter', async () => {
    const { store, customers } = makeStore();
    await store.createCustomer({
      ownerId: 'user_1',
      provider: 'stripe',
      providerCustomerId: 'cus_1',
    });
    expect(customers.calls.create[0]).toEqual({
      ownerId: 'user_1',
      provider: 'stripe',
      providerCustomerId: 'cus_1',
    });
  });

  test('returns null when nothing matches', async () => {
    const { store } = makeStore();
    expect(await store.findCustomerByOwnerId('user_nope')).toBeNull();
    expect(await store.findCustomerByProviderCustomerId('cus_nope')).toBeNull();
    expect(await store.getSubscriptionByProviderSubscriptionId('sub_nope')).toBeNull();
    expect(await store.findPaymentByProviderPaymentId('pi_nope')).toBeNull();
  });

  test('maps subscription records, coercing adapter Dates to ISO strings', async () => {
    const periodEnd = new Date('2026-08-01T00:00:00.000Z');
    const { store } = makeStore({
      subscriptions: [
        {
          id: 's1',
          ownerId: 'user_1',
          providerSubscriptionId: 'sub_1',
          plan: 'pro',
          status: 'active',
          priceId: 'price_pro',
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
          providerEventCreated: 100,
        },
      ],
    });
    const row = await store.getSubscriptionByProviderSubscriptionId('sub_1');
    expect(row?.currentPeriodEnd).toBe('2026-08-01T00:00:00.000Z');
    expect(row?.providerEventCreated).toBe(100);
  });

  test('creating a subscription converts the ISO period end to a Date for the entity', async () => {
    const { store, subscriptions } = makeStore();
    await store.createSubscription({
      ownerId: 'user_1',
      providerSubscriptionId: 'sub_1',
      plan: 'pro',
      status: 'active',
      priceId: 'price_pro',
      currentPeriodEnd: '2026-08-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      providerEventCreated: 100,
    });
    const created = subscriptions.calls.create[0] as Record<string, unknown>;
    expect(created.currentPeriodEnd).toBeInstanceOf(Date);
    expect((created.currentPeriodEnd as Date).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  test('updating converts currentPeriodEnd only when the patch names it', async () => {
    const { store, subscriptions } = makeStore();
    await store.updateSubscription('s1', { status: 'canceled', providerEventCreated: 200 });
    expect(subscriptions.calls.update[0]).toEqual([
      's1',
      { status: 'canceled', providerEventCreated: 200 },
    ]);

    await store.updateSubscription('s1', { currentPeriodEnd: '2026-09-01T00:00:00.000Z' });
    const [, patch] = subscriptions.calls.update[1] as [string, Record<string, unknown>];
    expect(patch.currentPeriodEnd).toBeInstanceOf(Date);
  });

  test('lists an owner subscriptions through the ownerId filter', async () => {
    const { store, subscriptions } = makeStore();
    await store.listSubscriptionsByOwner('user_1');
    expect(subscriptions.calls.list[0]).toEqual({ filter: { ownerId: 'user_1' } });
  });

  test('payment rows round-trip with a null owner preserved', async () => {
    const { store, payments } = makeStore({
      payments: [
        {
          id: 'p1',
          ownerId: null,
          providerPaymentId: 'pi_1',
          kind: 'donation',
          amount: 500,
          currency: 'usd',
          presetId: null,
          status: 'succeeded',
        },
      ],
    });
    const row = await store.findPaymentByProviderPaymentId('pi_1');
    expect(row?.ownerId).toBeNull();
    expect(row?.amount).toBe(500);

    await store.createPayment({
      ownerId: null,
      providerPaymentId: 'pi_2',
      kind: 'donation',
      amount: 1000,
      currency: 'usd',
      presetId: 'supporter',
      status: 'succeeded',
    });
    expect(payments.calls.create[0]).toMatchObject({ providerPaymentId: 'pi_2', amount: 1000 });
  });
});
