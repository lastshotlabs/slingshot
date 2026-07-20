import { describe, expect, test } from 'bun:test';
import { deriveEntitlement, entitlementEquals, planKeyForPrice } from '../../src/lib/entitlement';
import type { BillingSubscriptionRow } from '../../src/lib/store';
import { FREE_ENTITLEMENT } from '../../src/public';

const plans = [
  { key: 'pro', priceId: 'price_pro' },
  { key: 'plus', priceId: 'price_plus' },
];

/** Row factory with sensible defaults so tests only name what they assert. */
function row(overrides: Partial<BillingSubscriptionRow>): BillingSubscriptionRow {
  return {
    id: 'row_1',
    ownerId: 'user_1',
    providerSubscriptionId: 'sub_1',
    plan: 'pro',
    status: 'active',
    priceId: 'price_pro',
    currentPeriodEnd: '2026-08-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    providerEventCreated: 100,
    ...overrides,
  };
}

describe('planKeyForPrice', () => {
  test('maps a configured price id to its plan key', () => {
    expect(planKeyForPrice('price_pro', plans)).toBe('pro');
    expect(planKeyForPrice('price_plus', plans)).toBe('plus');
  });

  test("unknown price ⇒ 'free'", () => {
    expect(planKeyForPrice('price_who_dis', plans)).toBe('free');
  });

  test("absent price ⇒ 'free'", () => {
    expect(planKeyForPrice(null, plans)).toBe('free');
    expect(planKeyForPrice(undefined, plans)).toBe('free');
  });
});

describe('deriveEntitlement', () => {
  test('no rows ⇒ FREE_ENTITLEMENT', () => {
    expect(deriveEntitlement([], plans)).toEqual(FREE_ENTITLEMENT);
  });

  test('rows with only unknown plans ⇒ FREE_ENTITLEMENT', () => {
    // 'free' (unknown price at sync time) is not a configured plan key.
    const rows = [row({ plan: 'free' }), row({ id: 'row_2', plan: 'legacy-gold' })];
    expect(deriveEntitlement(rows, plans)).toEqual(FREE_ENTITLEMENT);
  });

  test('single active row surfaces its plan, status, and period fields', () => {
    const entitlement = deriveEntitlement([row({ cancelAtPeriodEnd: true })], plans);
    expect(entitlement).toEqual({
      plan: 'pro',
      status: 'active',
      currentPeriodEnd: '2026-08-01T00:00:00.000Z',
      cancelAtPeriodEnd: true,
    });
  });

  test('best-row rule: active > trialing > past_due > canceled (order-independent)', () => {
    const rows = [
      row({ id: 'a', providerSubscriptionId: 'sub_a', status: 'canceled', plan: 'plus' }),
      row({ id: 'b', providerSubscriptionId: 'sub_b', status: 'past_due', plan: 'plus' }),
      row({ id: 'c', providerSubscriptionId: 'sub_c', status: 'active', plan: 'pro' }),
      row({ id: 'd', providerSubscriptionId: 'sub_d', status: 'trialing', plan: 'plus' }),
    ];
    expect(deriveEntitlement(rows, plans).status).toBe('active');
    expect(deriveEntitlement(rows, plans).plan).toBe('pro');
    // Same rows reversed pick the same winner.
    expect(deriveEntitlement([...rows].reverse(), plans).plan).toBe('pro');

    const withoutActive = rows.filter(r => r.status !== 'active');
    expect(deriveEntitlement(withoutActive, plans).status).toBe('trialing');
    const withoutTrialing = withoutActive.filter(r => r.status !== 'trialing');
    expect(deriveEntitlement(withoutTrialing, plans).status).toBe('past_due');
  });

  test('equal rank tie-breaks on the LATEST currentPeriodEnd', () => {
    const rows = [
      row({
        id: 'older',
        providerSubscriptionId: 'sub_older',
        plan: 'plus',
        currentPeriodEnd: '2026-07-01T00:00:00.000Z',
      }),
      row({
        id: 'newer',
        providerSubscriptionId: 'sub_newer',
        plan: 'pro',
        currentPeriodEnd: '2026-09-01T00:00:00.000Z',
      }),
    ];
    expect(deriveEntitlement(rows, plans).plan).toBe('pro');
    expect(deriveEntitlement([...rows].reverse(), plans).plan).toBe('pro');
  });

  test('a null currentPeriodEnd loses the tie-break to any dated row', () => {
    const rows = [
      row({ id: 'dated', providerSubscriptionId: 'sub_dated', plan: 'plus' }),
      row({
        id: 'nodate',
        providerSubscriptionId: 'sub_nodate',
        plan: 'pro',
        currentPeriodEnd: null,
      }),
    ];
    expect(deriveEntitlement(rows, plans).plan).toBe('plus');
  });

  test('canceled-only rows still surface the canceled state (not FREE)', () => {
    const entitlement = deriveEntitlement([row({ status: 'canceled' })], plans);
    expect(entitlement.plan).toBe('pro');
    expect(entitlement.status).toBe('canceled');
  });
});

describe('entitlementEquals', () => {
  test('structural equality across all four fields', () => {
    const a = deriveEntitlement([row({})], plans);
    const b = deriveEntitlement([row({})], plans);
    expect(entitlementEquals(a, b)).toBe(true);
    expect(entitlementEquals(a, { ...b, cancelAtPeriodEnd: true })).toBe(false);
    expect(entitlementEquals(a, FREE_ENTITLEMENT)).toBe(false);
  });
});
