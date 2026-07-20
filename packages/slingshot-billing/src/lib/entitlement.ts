/**
 * Pure entitlement derivation: stored subscription rows + configured plans →
 * the single app-agnostic `Entitlement` answer.
 *
 * No I/O, no provider knowledge — `lib/sync.ts` calls this after every
 * subscription mutation, and the Phase 5 capability resolver calls it over the
 * owner's stored rows.
 */
import type { Entitlement } from '../public';
import { FREE_ENTITLEMENT } from '../public';
import type { PlanConfig } from '../types/config';
import type { SubscriptionStatus } from './provider';
import type { BillingSubscriptionRow } from './store';

/**
 * Best-row ranking: a live subscription always beats a delinquent or dead one.
 * Ties on rank fall through to the latest `currentPeriodEnd`.
 */
const STATUS_RANK: Readonly<Record<SubscriptionStatus, number>> = {
  active: 3,
  trialing: 2,
  past_due: 1,
  canceled: 0,
};

/**
 * Map a provider price id onto the configured plan key.
 *
 * Unknown or absent prices map to `'free'` — a webhook for a price the app
 * never configured must not grant an entitlement.
 *
 * @param priceId - Provider price id from a webhook event, or null/undefined.
 * @param plans - The package's configured plans.
 * @returns The matching plan key, or `'free'`.
 */
export function planKeyForPrice(
  priceId: string | null | undefined,
  plans: readonly PlanConfig[],
): string {
  if (!priceId) return 'free';
  return plans.find(plan => plan.priceId === priceId)?.key ?? 'free';
}

/** Tie-break sort key: null period end ranks below any concrete date. */
function periodEndEpoch(row: BillingSubscriptionRow): number {
  if (row.currentPeriodEnd === null) return Number.NEGATIVE_INFINITY;
  const epoch = new Date(row.currentPeriodEnd).getTime();
  return Number.isNaN(epoch) ? Number.NEGATIVE_INFINITY : epoch;
}

/**
 * Derive an owner's `Entitlement` from their stored subscription rows.
 *
 * Multi-row rule (binding): rows whose `plan` is not a configured plan key are
 * discarded (unknown plan ⇒ no entitlement from that row), then the BEST
 * remaining row wins — ranked `active > trialing > past_due > canceled`,
 * tie-broken by the latest `currentPeriodEnd`. No qualifying rows ⇒
 * {@link FREE_ENTITLEMENT}.
 *
 * @param rows - The owner's `billing_subscriptions` rows (any order).
 * @param plans - The package's configured plans.
 * @returns The derived entitlement; never null.
 */
export function deriveEntitlement(
  rows: readonly BillingSubscriptionRow[],
  plans: readonly PlanConfig[],
): Entitlement {
  const knownPlans = new Set(plans.map(plan => plan.key));
  const candidates = rows.filter(row => knownPlans.has(row.plan));
  if (candidates.length === 0) return FREE_ENTITLEMENT;

  let best = candidates[0];
  for (const row of candidates.slice(1)) {
    const rankDelta = STATUS_RANK[row.status] - STATUS_RANK[best.status];
    if (rankDelta > 0 || (rankDelta === 0 && periodEndEpoch(row) > periodEndEpoch(best))) {
      best = row;
    }
  }

  return {
    plan: best.plan,
    status: best.status,
    currentPeriodEnd: best.currentPeriodEnd,
    cancelAtPeriodEnd: best.cancelAtPeriodEnd,
  };
}

/** Structural equality for entitlements — used by sync to report `changed`. */
export function entitlementEquals(a: Entitlement, b: Entitlement): boolean {
  return (
    a.plan === b.plan &&
    a.status === b.status &&
    a.currentPeriodEnd === b.currentPeriodEnd &&
    a.cancelAtPeriodEnd === b.cancelAtPeriodEnd
  );
}
